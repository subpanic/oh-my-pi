#!/usr/bin/env bun
/**
 * Test fixture: a real stdio MCP server whose every instance reports its own
 * PID, mutable state, resources, instructions and notifications.
 *
 * Used by the per-agent MCP isolation runtime tests to prove that an opted-in
 * server's private instances are real, distinct processes and that nothing from
 * one owner's process (tools, catalogs, resources, instructions, notifications)
 * leaks into another's. The fixture writes a JSONL audit trail so a test can
 * count spawned processes and observe that they exited.
 *
 * Usage: bun isolation-mcp.ts <auditPath>
 *
 * Env:
 * - `FIXTURE_LABEL` — logical instance label echoed in status/audit.
 * - `FIXTURE_INITIAL_STATE` — initial mutable state (default "ready").
 * - `FIXTURE_HANDSHAKE_DELAY_MS` — stall the `initialize` reply; lets a test
 *   kill the acquiring owner while a private instance is still starting.
 * - `FIXTURE_STARTUP_EXIT_CODE` — exit before answering `initialize`, so the
 *   private startup failure path can be exercised.
 * - `FIXTURE_MAX_INSTANCES` — exit when this process is instance number
 *   `max+1` or later. Lets a root's shared instance succeed while a later
 *   private acquisition is the one that fails.
 * - `FIXTURE_STALL_INSTANCE` — never answer `initialize` when this process is
 *   that instance number, so an owner's unbounded handshake can only end
 *   through abort/teardown. Other instances answer normally.
 * - `FIXTURE_FAIL_INITIALIZE_INSTANCE` + `FIXTURE_FAIL_INITIALIZE_AFTER_MS` —
 *   answer nothing, then exit after the delay, when this process is that
 *   instance. Exercises a private failure after the root's fast startup window.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. Only requests with
 * an `id` get a response; notifications are ignored. The server exits as soon
 * as stdin closes so owner teardown is observable without an extra signal.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const auditPath = process.argv[2];
if (!auditPath) throw new Error("usage: isolation-mcp.ts <auditPath>");

const label = process.env.FIXTURE_LABEL ?? "fixture";
const audit = (event: Record<string, unknown>): void => {
	// Synchronous: spawn/exit events must survive an immediate process exit.
	fs.appendFileSync(auditPath, `${JSON.stringify({ pid: process.pid, label, at: Date.now(), ...event })}\n`);
};
let exiting = false;
/** Leave exactly one `exit` record, whatever ended the process. */
const shutdown = (code: number): never => {
	if (!exiting) {
		exiting = true;
		audit({ event: "exit" });
	}
	process.exit(code);
};
let closingRequested = false;
const exitDelayMs = Number(process.env.FIXTURE_EXIT_DELAY_MS ?? "0") || 0;
/** Leave a `closing` record now and an `exit` record once the configured delay elapses. */
const requestExit = (code: number): void => {
	if (closingRequested || exiting) return;
	closingRequested = true;
	audit({ event: "closing" });
	if (exitDelayMs > 0) setTimeout(() => shutdown(code), exitDelayMs);
	else shutdown(code);
};
process.on("exit", () => {
	if (!exiting) {
		exiting = true;
		audit({ event: "exit" });
	}
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => requestExit(0));
}

// Claim an instance number atomically with an exclusive lock file. Concurrent
// root instances must not read the same spawn count and collide.
let instanceIndex = 1;
for (;;) {
	try {
		const fd = fs.openSync(`${auditPath}.instance-${instanceIndex}`, "wx");
		fs.writeSync(fd, String(process.pid));
		fs.closeSync(fd);
		break;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			instanceIndex++;
			continue;
		}
		throw error;
	}
}
audit({ event: "spawn", instance: instanceIndex });

const maxInstances = Number(process.env.FIXTURE_MAX_INSTANCES ?? "0") || 0;
if (maxInstances > 0 && instanceIndex > maxInstances) shutdown(1);

const stallInstance = Number(process.env.FIXTURE_STALL_INSTANCE ?? "0") || 0;
const stallInitialize = stallInstance > 0 && instanceIndex === stallInstance;

const failInitializeInstance = Number(process.env.FIXTURE_FAIL_INITIALIZE_INSTANCE ?? "0") || 0;
const failInitialize = failInitializeInstance > 0 && instanceIndex === failInitializeInstance;
const failInitializeAfterMs = Number(process.env.FIXTURE_FAIL_INITIALIZE_AFTER_MS ?? "0") || 0;

const startupExitCode = process.env.FIXTURE_STARTUP_EXIT_CODE;
if (startupExitCode !== undefined) {
	shutdown(Number(startupExitCode) || 1);
}

const handshakeDelayMs = Number(process.env.FIXTURE_HANDSHAKE_DELAY_MS ?? "0") || 0;

interface FixtureState {
	label: string;
	state: string;
	counter: number;
}

const current: FixtureState = {
	label,
	state: process.env.FIXTURE_INITIAL_STATE ?? "ready",
	counter: 0,
};

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

function statusPayload(): Record<string, unknown> {
	return { pid: process.pid, ...current };
}

function statusText(): string {
	return JSON.stringify(statusPayload());
}

function toolDefinitions(): Record<string, unknown>[] {
	const definitions = [
		{
			name: "fixture_status",
			description: "Report this process's PID and mutable state.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "fixture_set_state",
			description: "Replace this process's mutable state and report it.",
			inputSchema: {
				type: "object",
				properties: { state: { type: "string" } },
				required: ["state"],
				additionalProperties: false,
			},
		},
		{
			name: "fixture_bump",
			description: "Increment this process's counter and report it.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "fixture_notify",
			description: "Emit a server notification carrying this process's status.",
			inputSchema: {
				type: "object",
				properties: { marker: { type: "string" } },
				additionalProperties: false,
			},
		},
		{
			name: "fixture_add_tool",
			description: "Add the dynamic fixture tool and announce the change.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "fixture_crash",
			description: "Exit this process without answering, forcing a reconnect.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
	];
	if (dynamicTools) {
		definitions.push({
			name: "fixture_dynamic",
			description: "Tool this process added at runtime.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		});
	}
	return definitions;
}

let dynamicTools = false;

function writeFrame(frame: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function writeNotification(method: string, params?: Record<string, unknown>): void {
	audit({ event: "notification", method, params });
	writeFrame({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

function toolResult(text: string): Record<string, unknown> {
	return { content: [{ type: "text", text }], isError: false };
}

async function handleToolCall(
	params: Record<string, unknown> | undefined,
): Promise<{ result?: Record<string, unknown>; crash?: boolean }> {
	const name = String(params?.name ?? "");
	const args = (params?.arguments ?? {}) as Record<string, unknown>;
	switch (name) {
		case "fixture_status":
			return { result: toolResult(statusText()) };
		case "fixture_set_state": {
			current.state = String(args.state ?? "");
			return { result: toolResult(statusText()) };
		}
		case "fixture_bump":
			current.counter += 1;
			return { result: toolResult(statusText()) };
		case "fixture_notify": {
			const marker = typeof args.marker === "string" ? args.marker : "";
			writeNotification("notifications/fixture/state", { ...statusPayload(), marker });
			return { result: toolResult(statusText()) };
		}
		case "fixture_add_tool":
			dynamicTools = true;
			writeNotification("notifications/tools/list_changed");
			return { result: toolResult(statusText()) };
		case "fixture_crash":
			return { crash: true };
		case "fixture_dynamic":
			return { result: toolResult(JSON.stringify({ pid: process.pid, dynamic: true })) };
		default:
			return {
				result: {
					isError: true,
					content: [{ type: "text", text: `unexpected fixture tool ${name}` }],
				},
			};
	}
}

async function buildResult(
	method: string,
	params: Record<string, unknown> | undefined,
): Promise<{ result?: Record<string, unknown>; crash?: boolean }> {
	switch (method) {
		case "initialize": {
			if (failInitialize) {
				if (failInitializeAfterMs > 0) await Bun.sleep(failInitializeAfterMs);
				shutdown(1);
			}
			if (stallInitialize) {
				// The owner's request has no timeout of its own; only abort or transport teardown can end it.
				await new Promise<never>(() => {});
			}
			if (handshakeDelayMs > 0) await Bun.sleep(handshakeDelayMs);
			return {
				result: {
					protocolVersion: "2025-03-26",
					serverInfo: { name: "isolation-fixture", version: "1.0.0" },
					capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
					instructions: `ISOLATION_FIXTURE_INSTRUCTIONS pid=${process.pid} label=${label} state=${current.state}`,
				},
			};
		}
		case "tools/list":
			return { result: { tools: toolDefinitions() } };
		case "tools/call":
			return await handleToolCall(params);
		case "resources/list":
			return {
				result: {
					resources: [
						{ uri: "fixture://status", name: "Fixture status", mimeType: "application/json" },
						{
							uri: `fixture://${label}/status`,
							name: `Fixture status (${label})`,
							mimeType: "application/json",
						},
						{ uri: "fixture://pid", name: "Fixture PID", mimeType: "application/json" },
					],
				},
			};
		case "resources/templates/list":
			return { result: { resourceTemplates: [] } };
		case "resources/read": {
			const uri = String(params?.uri ?? "");
			return {
				result: {
					contents: [{ uri, mimeType: "application/json", text: statusText() }],
				},
			};
		}
		case "prompts/list":
			return {
				result: {
					prompts: [{ name: "fixture_prompt", description: "Fixture prompt" }],
				},
			};
		case "ping":
			return { result: {} };
		default:
			return { result: {} };
	}
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", line => {
	void (async () => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(trimmed) as JsonRpcRequest;
		} catch {
			return;
		}
		if (message.id === undefined || message.id === null) return;
		audit({ event: "request", method: message.method, name: message.params?.name });
		const outcome = await buildResult(message.method, message.params);
		if (outcome.crash) {
			audit({ event: "crash" });
			shutdown(1);
		}
		writeFrame({ jsonrpc: "2.0", id: message.id, result: outcome.result ?? {} });
	})();
});

rl.on("close", () => requestExit(0));
