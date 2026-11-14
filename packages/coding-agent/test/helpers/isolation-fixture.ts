/**
 * Shared harness for the per-agent MCP isolation runtime tests: config for the
 * real stdio fixture at `fixtures/isolation-mcp.ts`, its JSONL audit reader, and
 * the small tool/resource call helpers the manager and worker tests share.
 */
import * as path from "node:path";
import type { CustomTool, CustomToolContext } from "../../src/extensibility/custom-tools/types";
import type { MCPManagerApi } from "../../src/mcp/manager";
import type { MCPResourceReadResult, MCPStdioServerConfig } from "../../src/mcp/types";

export const ISOLATION_FIXTURE_PATH = path.join(import.meta.dir, "..", "fixtures", "isolation-mcp.ts");

export const STATUS_TOOL = "fixture_status";
export const STATE_TOOL = "fixture_set_state";
export const NOTIFY_TOOL = "fixture_notify";
export const DYNAMIC_TOOL = "fixture_dynamic";
export const ADD_TOOL_TOOL = "fixture_add_tool";

/** URI the fixture instance labelled `label` advertises for its status resource. */
export function fixtureStatusUri(label: string): string {
	return `fixture://${label}/status`;
}

export interface IsolationFixtureOptions {
	/** Logical instance label echoed in fixture status and audit records. */
	label?: string;
	initialState?: string;
	/** Stall `initialize`; lets a test terminate the acquiring owner mid-startup. */
	handshakeDelayMs?: number;
	/** Exit before answering `initialize`, exercising a private startup failure. */
	startupExitCode?: number;
	/** Exit when this process is later than instance `maxInstances`; root instances survive. */
	maxInstances?: number;
	/** Never answer `initialize` for exactly this instance index; other instances answer normally. */
	stallInstance?: number;
	/** Exit without answering `initialize` for exactly this instance, after `failInitializeAfterMs`. */
	failInitializeInstance?: number;
	failInitializeAfterMs?: number;
	/** Delay the audited `exit` after the process is asked to stop, keeping teardown observable. */
	exitDelayMs?: number;
	/** MCP request timeout passed through the server config; `0` disables the client timeout. */
	timeout?: number;
	/** Opt the server into isolation. */
	isolation?: "agent";
}

export function isolationFixtureConfig(auditPath: string, options: IsolationFixtureOptions = {}): MCPStdioServerConfig {
	const env: Record<string, string> = { FIXTURE_LABEL: options.label ?? "fixture" };
	if (options.initialState !== undefined) env.FIXTURE_INITIAL_STATE = options.initialState;
	if (options.handshakeDelayMs !== undefined) env.FIXTURE_HANDSHAKE_DELAY_MS = String(options.handshakeDelayMs);
	if (options.startupExitCode !== undefined) env.FIXTURE_STARTUP_EXIT_CODE = String(options.startupExitCode);
	if (options.maxInstances !== undefined) env.FIXTURE_MAX_INSTANCES = String(options.maxInstances);
	if (options.stallInstance !== undefined) env.FIXTURE_STALL_INSTANCE = String(options.stallInstance);
	if (options.failInitializeInstance !== undefined) {
		env.FIXTURE_FAIL_INITIALIZE_INSTANCE = String(options.failInitializeInstance);
	}
	if (options.failInitializeAfterMs !== undefined) {
		env.FIXTURE_FAIL_INITIALIZE_AFTER_MS = String(options.failInitializeAfterMs);
	}
	if (options.exitDelayMs !== undefined) env.FIXTURE_EXIT_DELAY_MS = String(options.exitDelayMs);
	return {
		type: "stdio",
		command: process.execPath,
		args: [ISOLATION_FIXTURE_PATH, auditPath],
		env,
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.isolation === undefined ? {} : { isolation: options.isolation }),
	};
}

export type IsolationAuditEvent =
	| { event: "spawn"; pid: number; label: string; instance?: number; at?: number }
	| { event: "exit"; pid: number; label: string }
	| { event: "closing"; pid: number; label: string; at?: number }
	| { event: "crash"; pid: number; label: string }
	| { event: "request"; pid: number; label: string; method: string; name?: unknown }
	| {
			event: "notification";
			pid: number;
			label: string;
			method: string;
			params?: Record<string, unknown>;
	  };

/** Parse every complete record written so far; a torn tail line is ignored, as a live writer may produce one. */
export async function readIsolationAudit(auditPath: string): Promise<IsolationAuditEvent[]> {
	let text: string;
	try {
		text = await Bun.file(auditPath).text();
	} catch {
		return [];
	}
	const events: IsolationAuditEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line) as IsolationAuditEvent);
		} catch {
			// The writer may be mid-line.
		}
	}
	return events;
}

/** Poll the audit until `predicate` holds; returns the matching snapshot. */
export async function waitForIsolationAudit(
	auditPath: string,
	predicate: (events: IsolationAuditEvent[]) => boolean,
	timeoutMs = 15_000,
): Promise<IsolationAuditEvent[]> {
	const deadline = Date.now() + timeoutMs;
	let events = await readIsolationAudit(auditPath);
	while (!predicate(events)) {
		if (Date.now() > deadline) {
			throw new Error(`isolation audit condition not met in ${timeoutMs}ms; events=${JSON.stringify(events)}`);
		}
		await Bun.sleep(10);
		events = await readIsolationAudit(auditPath);
	}
	return events;
}

export function spawnedPids(events: readonly IsolationAuditEvent[]): number[] {
	return events.filter(event => event.event === "spawn").map(event => event.pid);
}

export function exitedPids(events: readonly IsolationAuditEvent[]): Set<number> {
	return new Set(events.filter(event => event.event === "exit").map(event => event.pid));
}

export function livePids(events: readonly IsolationAuditEvent[]): number[] {
	const exited = exitedPids(events);
	return spawnedPids(events).filter(pid => !exited.has(pid));
}

export async function waitForIsolationSpawn(auditPath: string, count: number, timeoutMs = 15_000): Promise<number[]> {
	const events = await waitForIsolationAudit(auditPath, current => spawnedPids(current).length >= count, timeoutMs);
	return spawnedPids(events);
}

export async function waitForIsolationExit(auditPath: string, pid: number, timeoutMs = 15_000): Promise<void> {
	await waitForIsolationAudit(auditPath, events => exitedPids(events).has(pid), timeoutMs);
}

/** One fixture instance's identity and mutable state. */
export interface FixtureStatus {
	pid: number;
	label: string;
	state: string;
	counter: number;
}

/** Parse and validate the fixture's JSON status instead of asserting it blindly. */
export function parseFixtureStatus(value: unknown): FixtureStatus {
	if (typeof value !== "object" || value === null) {
		throw new Error(`malformed fixture status: ${JSON.stringify(value)}`);
	}
	const pid = Reflect.get(value, "pid");
	const label = Reflect.get(value, "label");
	const state = Reflect.get(value, "state");
	const counter = Reflect.get(value, "counter");
	if (
		typeof pid !== "number" ||
		typeof label !== "string" ||
		typeof state !== "string" ||
		typeof counter !== "number"
	) {
		throw new Error(`malformed fixture status: ${JSON.stringify(value)}`);
	}
	return { pid, label, state, counter };
}

/** Call one MCP tool through the view it was minted from and return its parsed JSON text. */
export async function callFixtureTool(
	tools: readonly CustomTool[],
	serverName: string,
	mcpToolName: string,
	args: Record<string, unknown> = {},
	toolCallId = `isolation-${serverName}-${mcpToolName}`,
): Promise<Record<string, unknown>> {
	const tool = tools.find(
		candidate => candidate.mcpServerName === serverName && candidate.mcpToolName === mcpToolName,
	);
	if (!tool?.execute) {
		const available = tools
			.flatMap(candidate =>
				candidate.mcpServerName && candidate.mcpToolName
					? [`${candidate.mcpServerName}/${candidate.mcpToolName}`]
					: [],
			)
			.join(",");
		throw new Error(`expected MCP tool ${serverName}/${mcpToolName}; have ${available}`);
	}
	const result = await tool.execute(toolCallId, args, undefined, {} as CustomToolContext);
	const text = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
	return JSON.parse(text) as Record<string, unknown>;
}

/** Call `fixture_status` and return its validated identity/state. */
export async function callFixtureStatus(tools: readonly CustomTool[], serverName: string): Promise<FixtureStatus> {
	return parseFixtureStatus(await callFixtureTool(tools, serverName, STATUS_TOOL));
}

/** Call `fixture_set_state` and return the validated identity/state. */
export async function setFixtureState(
	tools: readonly CustomTool[],
	serverName: string,
	state: string,
): Promise<FixtureStatus> {
	return parseFixtureStatus(await callFixtureTool(tools, serverName, STATE_TOOL, { state }));
}

function resourceText(result: MCPResourceReadResult | undefined): string {
	const text = result?.contents.flatMap(part => (part.text === undefined ? [] : [part.text])).join("\n") ?? "";
	if (text.length === 0) throw new Error("fixture resource returned no text");
	return text;
}

/** Read `fixture://status` through one bound manager and parse the instance identity it reports. */
export async function readFixtureStatus(manager: MCPManagerApi, serverName: string): Promise<FixtureStatus> {
	const result = await manager.readServerResource(serverName, "fixture://status");
	return parseFixtureStatus(JSON.parse(resourceText(result)));
}
