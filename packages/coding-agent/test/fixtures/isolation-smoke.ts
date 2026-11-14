#!/usr/bin/env bun
/**
 * Bounded no-external-model isolation smoke, runnable directly:
 *
 *   bun packages/coding-agent/test/fixtures/isolation-smoke.ts
 *
 * Drives the real SDK subagent path (`runSubprocess`) in one worker with a
 * scripted local OpenAI-compatible provider and the real stdio MCP fixture. It
 * prints the distinct private instances and shared root instance, proves a
 * live follow-up keeps its private PID, then parks one child and shuts the root
 * down, reporting every fixture process that is still alive.
 *
 * Exits 0 only when the observed PIDs and teardown match; prints diagnostics on
 * failure. It never imports `bun:test`, contacts an external model, or reads a
 * user MCP config.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	STATUS_TOOL,
	isolationFixtureConfig,
	livePids,
	readFixtureStatus,
	readIsolationAudit,
	waitForIsolationExit,
} from "../helpers/isolation-fixture";
import { ScriptedModelServer } from "./scripted-model-server";

const MODEL = "scripted/scripted-model";
const MARKER = `omp-isolation-smoke-${Bun.randomUUIDv7("hex")}`;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const SCRIPT_TIMEOUT_MS = 180_000;

const AGENT: AgentDefinition = {
	name: "task",
	description: "isolation smoke agent",
	systemPrompt: `You are an isolation smoke agent (${MARKER}).`,
	source: "bundled",
	tools: ["read"],
};

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pidValues(text: string): number[] {
	return [...text.matchAll(/"pid"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-smoke-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const cwd = path.join(root, "work");
	const auditPath = path.join(root, "audit.jsonl");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();

	let server: ScriptedModelServer | undefined;
	let authStorage: AuthStorage | undefined;
	let manager: MCPManager | undefined;
	let pool: SubagentWorkerPool | undefined;
	const cleanup = async (): Promise<void> => {
		setSubagentWorkerPoolForTests(undefined);
		pool?.dispose();
		MCPManager.resetForTests();
		await manager?.disconnectAll().catch(() => {});
		server?.stop();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		authStorage?.close();
		AgentStorage.close();
		closeModelCache();
		for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	};

	try {
		const activeServer = new ScriptedModelServer(request => {
			if (!request.systemText.includes(MARKER)) return { text: "pong" };
			if (request.messages.at(-1)?.role === "tool") {
				return { text: `tool result: ${request.lastToolTexts.join("\n")}` };
			}
			if (request.lastUserText.includes("ISO_AND_SHARED")) {
				return {
					tools: [
						{ name: `mcp__iso_${STATUS_TOOL}`, args: {} },
						{ name: `mcp__shared_${STATUS_TOOL}`, args: {} },
					],
				};
			}
			if (request.lastUserText.includes("ISO_STATUS")) {
				return { tools: [{ name: `mcp__iso_${STATUS_TOOL}`, args: {} }] };
			}
			return { text: "pong" };
		});
		server = activeServer;
		const modelsPath = await activeServer.writeModelsYml(agentDir);
		const activeAuth = createInMemoryAuthStorage();
		authStorage = activeAuth;
		const modelRegistry = new ModelRegistry(activeAuth, modelsPath);
		await modelRegistry.refresh();
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: MODEL },
		});
		const eventBus = new EventBus();
		const activeManager = new MCPManager(cwd, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		manager = activeManager;
		const configs: Record<string, MCPServerConfig> = {
			shared: isolationFixtureConfig(auditPath, { label: "shared" }),
			iso: isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent" }),
		};
		await activeManager.connectServers(configs, {}, undefined, 0);
		const startup = await activeManager.waitForStartup(0);
		check(startup.failed.length === 0, `MCP startup failed: ${JSON.stringify(startup.failed)}`);
		MCPManager.setInstance(activeManager);
		const activePool = new SubagentWorkerPool({
			maxWorkers: () => 1,
			idleMs: 600_000,
			hostsOnMain: false,
			worker: { initTimeoutMs: 60_000 },
		});
		pool = activePool;
		setSubagentWorkerPoolForTests(activePool);

		const runOptions = (id: string, task: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions => ({
			cwd,
			agent: AGENT,
			task,
			index: 0,
			id,
			description: `smoke ${id}`,
			modelOverride: MODEL,
			structured: false,
			settings,
			authStorage: activeAuth,
			modelRegistry,
			eventBus,
			artifactsDir: path.join(root, "artifacts"),
			enableLsp: false,
			enableMCP: true,
			mcpManager: activeManager,
			taskDepth: 0,
			...extra,
		});

		const rootIso = await readFixtureStatus(activeManager, "iso");
		const rootShared = await readFixtureStatus(activeManager, "shared");
		const [a, b] = await Promise.all([
			runSubprocess(runOptions("SmokeA", "ISO_AND_SHARED")),
			runSubprocess(runOptions("SmokeB", "ISO_AND_SHARED")),
		]);
		check(!a.error && !b.error, `child run failed: ${a.error ?? b.error}`);
		const aIso = pidValues(a.output).find(pid => pid !== rootShared.pid);
		const bIso = pidValues(b.output).find(pid => pid !== rootShared.pid);
		if (aIso === undefined || bIso === undefined) {
			throw new Error(`missing private PIDs: A=${a.output} B=${b.output}`);
		}
		check(aIso !== bIso, `children shared a private PID ${aIso}`);
		check(aIso !== rootIso.pid && bIso !== rootIso.pid, "child used the root's isolated instance");
		check(a.output.includes(String(rootShared.pid)), "child A did not reach the root's shared server");
		check(b.output.includes(String(rootShared.pid)), "child B did not reach the root's shared server");
		console.log(
			`isolation-smoke: root shared=${rootShared.pid} root iso=${rootIso.pid} childA=${aIso} childB=${bIso}`,
		);

		const followA = await runSubagentFollowUpTurn({
			id: "SmokeA",
			agent: AGENT,
			message: "ISO_STATUS",
			structured: false,
		});
		check(pidValues(followA.output).includes(aIso), `live follow-up lost private PID ${aIso}`);
		console.log(`isolation-smoke: live follow-up kept childA=${aIso}`);

		await AgentLifecycleManager.global().park("SmokeA");
		await waitForIsolationExit(auditPath, aIso);
		const afterPark = livePids(await readIsolationAudit(auditPath));
		check(!afterPark.includes(aIso), `parked child A still alive (${aIso})`);
		check(afterPark.includes(bIso), `sibling B died with A (${bIso})`);
		check(afterPark.includes(rootShared.pid), "root shared server died with parked child");
		check(afterPark.includes(rootIso.pid), "root isolated server died with parked child");
		console.log(`isolation-smoke: parked A closed ${aIso}; sibling=${bIso} root preserved`);

		await activeManager.disconnectAll();
		const deadline = Date.now() + 15_000;
		let survivors = livePids(await readIsolationAudit(auditPath));
		while (survivors.length > 0 && Date.now() < deadline) {
			await Bun.sleep(10);
			survivors = livePids(await readIsolationAudit(auditPath));
		}
		check(survivors.length === 0, `fixture processes survived teardown: ${survivors.join(",")}`);
		console.log(`isolation-smoke: teardown left no fixture processes (${Date.now() - startedAt}ms)`);
	} finally {
		await cleanup();
	}
}

const watchdog = setTimeout(() => {
	console.error(`isolation-smoke FAILED: exceeded ${SCRIPT_TIMEOUT_MS}ms`);
	process.exit(1);
}, SCRIPT_TIMEOUT_MS);
watchdog.unref?.();
try {
	await main();
} catch (error) {
	console.error(`isolation-smoke FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	clearTimeout(watchdog);
}
