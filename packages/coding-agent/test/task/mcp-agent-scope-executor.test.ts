/**
 * End-to-end runtime contract for per-agent MCP isolation through the real
 * subagent spawn path: `runSubprocess` in pooled workers, child
 * `createAgentSession`s, and a deterministic scripted OpenAI-compatible model
 * server (no external requests).
 *
 * Two children on one worker must each get a private instance of the opted-in
 * server and share the root's ordinary server; a live follow-up keeps the
 * private process, parking one child closes only its process, a warm revive gets
 * a fresh one, and a cold persisted revive acquires from the canonical root.
 * Resource reads resolve through the child's own manager, never the root's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { validateAgentAccountPools } from "../../src/config/account-pools";
import { ModelRegistry } from "../../src/config/model-registry";
import type { SettingsMirrorSource, SettingsMirrorState } from "../../src/config/settings";
import { Settings } from "../../src/config/settings";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import {
	type ExecutorOptions,
	type SubagentToolResult,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "../../src/task/executor";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { cfgTaskAgentAccountPools } from "../../src/task/settings";
import type { AgentDefinition } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	STATUS_TOOL,
	STATE_TOOL,
	fixtureStatusUri,
	isolationFixtureConfig,
	livePids,
	readFixtureStatus,
	readIsolationAudit,
	spawnedPids,
	waitForIsolationExit,
	waitForIsolationSpawn,
} from "../helpers/isolation-fixture";
import { ScriptedModelServer } from "../fixtures/scripted-model-server";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "scripted/scripted-model";
const TEST_TIMEOUT_MS = 120_000;
const SCRIPT_ID = Bun.randomUUIDv7("hex");
const AGENT_MARKER = `omp-mcp-isolation-agent-${SCRIPT_ID}`;

const AGENT: AgentDefinition = {
	name: "task",
	description: "isolation e2e agent",
	systemPrompt: `You are a test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read", "task"],
	spawns: "*",
};

const NESTED_AGENT: AgentDefinition = {
	name: "isolation-nested",
	description: "nested isolation e2e agent",
	systemPrompt: `You are a nested test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read"],
};

function pidValues(text: string): number[] {
	return [...text.matchAll(/"pid"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
}

/**
 * A real Settings instance whose raw layers can be replaced without the write-time validators
 * (the worker-mirror path). Lets a test corrupt live owner policy after a child was spawned,
 * exactly as a mirrored main-thread setting can change under a running child.
 */
function createLiveSettingsMirror(base: Settings): {
	settings: Settings;
	corruptAccountPools(): void;
	restore(): void;
} {
	const valid: SettingsMirrorState = { ...base.mirrorState(), generation: 1 };
	let state = valid;
	const holder: { mirror?: Settings } = {};
	const source: SettingsMirrorSource = {
		write: () => state,
		refresh: async () => state,
		cloneForCwd: async () => {
			if (!holder.mirror) throw new Error("settings mirror not constructed");
			return holder.mirror;
		},
	};
	const createdMirror = Settings.mirror(source, state);
	holder.mirror = createdMirror;
	const liveMirror = createdMirror;
	const restore = (): void => {
		state = { ...valid, generation: state.generation + 1 };
		liveMirror.applyMirrorState(state);
	};
	return {
		settings: liveMirror,
		corruptAccountPools() {
			const overrides = structuredClone(state.overrides) as Record<string, unknown>;
			const task =
				typeof overrides.task === "object" && overrides.task !== null && !Array.isArray(overrides.task)
					? (overrides.task as Record<string, unknown>)
					: {};
			// A record passes Setting.accepts (so `get` returns it rather than the default),
			// while validateAgentAccountPools rejects the non-array provider value.
			overrides.task = { ...task, agentAccountPools: { task: { anthropic: "email:a@example.com" } } };
			state = { ...state, generation: state.generation + 1, overrides };
			liveMirror.applyMirrorState(state);
		},
		restore,
	};
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

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: ScriptedModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let manager: MCPManager;
let auditPath: string;
let eventBus: EventBus;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-isolation-executor-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();

	server = new ScriptedModelServer(request => {
		if (!request.systemText.includes(AGENT_MARKER)) return { text: "pong" };
		if (request.lastUserText.includes("ABORT_RETAIN")) {
			if (request.messages.at(-1)?.role === "tool") {
				// First result is set_state; ask for the status that proves the state landed, then hold.
				if (request.toolTexts.length < 2) {
					return { tools: [{ name: `mcp__iso_${STATUS_TOOL}`, args: {} }] };
				}
				return { hold: true };
			}
			return { tools: [{ name: `mcp__iso_${STATE_TOOL}`, args: { state: "abort-state" } }] };
		}
		if (request.messages.at(-1)?.role === "tool") {
			return { text: `tool result: ${request.lastToolTexts.join("\n")}` };
		}
		if (request.lastUserText.includes("SPAWN_NESTED")) {
			return {
				tools: [
					{ name: `mcp__iso_${STATUS_TOOL}`, args: {} },
					{
						name: "task",
						args: { agent: NESTED_AGENT.name, task: "ISO_STATUS", name: "nested" },
					},
				],
			};
		}
		if (request.lastUserText.includes("XDEV_ISO")) {
			if (request.messages.at(-1)?.role === "tool") {
				return { text: `tool result: ${request.lastToolTexts.join("\n")}` };
			}
			if (!request.toolNames.includes("write")) return { text: "write unavailable" };
			return {
				tools: [
					{
						name: "write",
						args: { path: `xd://mcp__iso_${STATUS_TOOL}`, content: "{}" },
					},
				],
			};
		}
		if (request.lastUserText.includes("ISO_AND_SHARED")) {
			return {
				tools: [
					{ name: `mcp__iso_${STATUS_TOOL}`, args: {} },
					{ name: `mcp__shared_${STATUS_TOOL}`, args: {} },
				],
			};
		}
		if (request.lastUserText.includes("READ_ISO")) {
			return {
				tools: [
					{ name: `mcp__iso_${STATUS_TOOL}`, args: {} },
					{ name: "read", args: { path: `mcp://${fixtureStatusUri("iso")}` } },
				],
			};
		}
		if (request.lastUserText.includes("SHARED_STATUS")) {
			return { tools: [{ name: `mcp__shared_${STATUS_TOOL}`, args: {} }] };
		}
		if (request.lastUserText.includes("ISO_STATUS")) {
			return { tools: [{ name: `mcp__iso_${STATUS_TOOL}`, args: {} }] };
		}
		return { text: "pong" };
	});
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: MODEL },
	});
	eventBus = new EventBus();
	auditPath = path.join(root, "isolation.jsonl");
	manager = new MCPManager(cwd, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	await manager.connectServers(
		{
			shared: isolationFixtureConfig(auditPath, { label: "shared" }),
			iso: isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent" }),
		},
		{},
	);
	const startup = await manager.waitForStartup(0);
	if (startup.failed.length > 0) throw new Error(`MCP startup failed: ${JSON.stringify(startup.failed)}`);
	MCPManager.setInstance(manager);
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	MCPManager.resetForTests();
	await manager.disconnectAll();
	server.stop();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

function runOptions(id: string, task: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task,
		index: 0,
		id,
		description: `isolation ${id}`,
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		eventBus,
		artifactsDir: path.join(root, "artifacts"),
		enableLsp: false,
		enableMCP: true,
		mcpManager: manager,
		inheritedSessionAgents: [NESTED_AGENT],
		taskDepth: 0,
		...extra,
	};
}

/** A real main-thread root session, as main.ts hands the persisted reviver factory. */
function rootSession(): AgentSession {
	const model = modelRegistry.find("scripted", "scripted-model");
	if (!model) throw new Error("scripted model missing from the main registry");
	const agent = new Agent({ initialState: { model, systemPrompt: ["root"], tools: [] }, convertToLlm });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry,
		agentId: MAIN_AGENT_ID,
	});
	cleanups.push(() => session.dispose());
	return session;
}

describe("subagent MCP isolation through the real executor", () => {
	it(
		"gives two children on one worker distinct private instances and one shared root instance",
		async () => {
			const [a, b] = await Promise.all([
				runSubprocess(runOptions("A", "ISO_AND_SHARED")),
				runSubprocess(runOptions("B", "ISO_AND_SHARED")),
			]);
			expect(a.error).toBeUndefined();
			expect(b.error).toBeUndefined();
			expect(a.exitCode).toBe(0);
			expect(b.exitCode).toBe(0);

			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");
			const aPids = pidValues(a.output);
			const bPids = pidValues(b.output);
			expect(aPids).toContain(rootShared.pid);
			expect(bPids).toContain(rootShared.pid);
			const aIso = aPids.find(pid => pid !== rootShared.pid);
			const bIso = bPids.find(pid => pid !== rootShared.pid);
			expect(aIso).toBeDefined();
			expect(bIso).toBeDefined();
			expect(aIso).not.toBe(rootIso.pid);
			expect(bIso).not.toBe(rootIso.pid);
			expect(aIso).not.toBe(bIso);

			// Both live children are homed on the same worker, each holding its own scope.
			const homeA = AgentRegistry.global().get("A")?.session;
			const homeB = AgentRegistry.global().get("B")?.session;
			if (!(homeA instanceof RemoteAgentSession) || !(homeB instanceof RemoteAgentSession)) {
				throw new Error("expected worker-homed child sessions");
			}
			expect(homeA.home).toBe(homeB.home);

			// A live follow-up keeps the private process; parking it releases only that scope.
			const followA = await runSubagentFollowUpTurn({
				id: "A",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			if (aIso === undefined) throw new Error("child A never reached an isolated instance");
			expect(pidValues(followA.output)).toContain(aIso);
			await AgentLifecycleManager.global().park("A");
			await waitForIsolationExit(auditPath, aIso);
			if (bIso === undefined) throw new Error("child B never reached an isolated instance");
			const liveAfterPark = livePids(await readIsolationAudit(auditPath));
			expect(liveAfterPark).toContain(bIso);
			expect(liveAfterPark).toContain(rootShared.pid);
			expect(liveAfterPark).toContain(rootIso.pid);

			const followB = await runSubagentFollowUpTurn({
				id: "B",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			expect(pidValues(followB.output)).toContain(bIso);

			// A warm revive of the parked child gets a fresh private instance.
			const revivedA = await runSubagentFollowUpTurn({
				id: "A",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			const revivedPids = pidValues(revivedA.output);
			expect(revivedPids.length).toBeGreaterThan(0);
			const revivedIso = revivedPids.find(pid => pid !== rootShared.pid);
			expect(revivedIso).toBeDefined();
			expect(revivedIso).not.toBe(aIso);
			expect(revivedIso).not.toBe(rootIso.pid);
			expect(livePids(await readIsolationAudit(auditPath))).toContain(revivedIso as number);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"executes the mounted xd:// MCP route on the child's private process",
		async () => {
			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");
			const toolResults: SubagentToolResult[] = [];
			const result = await runSubprocess(
				runOptions("Xdev", "XDEV_ISO", {
					settings: settings.overlay({ "tools.xdev": true }),
					onToolResult: toolResult => toolResults.push(toolResult),
				}),
			);
			expect(result.error).toBeUndefined();
			const writeResult = toolResults.find(toolResult => toolResult.tool === "write");
			if (!writeResult) throw new Error("model never executed the mounted xd:// write route");
			expect(writeResult.isError).toBe(false);
			const mountedPid = pidValues(writeResult.text)[0];
			if (mountedPid === undefined) throw new Error(`xd:// write returned no PID: ${writeResult.text}`);
			expect(mountedPid).not.toBe(rootIso.pid);
			expect(mountedPid).not.toBe(rootShared.pid);
			expect(livePids(await readIsolationAudit(auditPath))).toContain(mountedPid);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"retains a kept-alive child's private PID and state across an ordinary run abort",
		async () => {
			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");
			const sibling = await runSubprocess(runOptions("AbortSibling", "ISO_STATUS"));
			expect(sibling.error).toBeUndefined();
			const siblingPid = pidValues(sibling.output).find(pid => pid !== rootShared.pid);
			if (siblingPid === undefined) throw new Error("sibling never reached an isolated instance");

			const controller = new AbortController();
			const statusSeen = Promise.withResolvers<SubagentToolResult>();
			const running = runSubprocess(
				runOptions("AbortRetain", "ABORT_RETAIN", {
					keepAlive: true,
					signal: controller.signal,
					onToolResult: result => {
						if (result.tool.includes("fixture_status")) statusSeen.resolve(result);
					},
				}),
			);
			await server.held();
			const statusResult = await statusSeen.promise;
			const abortedPid = pidValues(statusResult.text)[0];
			if (abortedPid === undefined) throw new Error("aborted child never reached an isolated instance");
			expect(statusResult.text).toContain("abort-state");

			controller.abort();
			server.releaseHeld();
			const aborted = await running;
			expect(aborted.aborted).toBe(true);

			// The run abort only stops the turn: the live child keeps its scope, process and mutable state.
			const follow = await runSubagentFollowUpTurn({
				id: "AbortRetain",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			expect(follow.error).toBeUndefined();
			expect(pidValues(follow.output)).toContain(abortedPid);
			expect(follow.output).toContain("abort-state");

			const siblingFollow = await runSubagentFollowUpTurn({
				id: "AbortSibling",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			expect(pidValues(siblingFollow.output)).toContain(siblingPid);

			await AgentLifecycleManager.global().park("AbortRetain");
			await waitForIsolationExit(auditPath, abortedPid);
			const live = livePids(await readIsolationAudit(auditPath));
			expect(live).toContain(siblingPid);
			expect(live).toContain(rootIso.pid);
			expect(live).toContain(rootShared.pid);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails a warm revive on malformed account pools before acquiring a scope or leaking the transcript",
		async () => {
			const mirror = createLiveSettingsMirror(settings);
			// Keep this child (and its warm revive) on main so the live Settings instance under test is
			// the exact capture parent, with no cross-thread state propagation window.
			const mainPool = new SubagentWorkerPool({ maxWorkers: () => 0, hostsOnMain: true, idleMs: 0 });
			setSubagentWorkerPoolForTests(mainPool);
			cleanups.push(() => mainPool.dispose());
			try {
				const rootIso = await readFixtureStatus(manager, "iso");
				const rootShared = await readFixtureStatus(manager, "shared");
				const first = await runSubprocess(runOptions("PoolRevive", "ISO_STATUS", { settings: mirror.settings }));
				expect(first.error).toBeUndefined();
				const privatePid = pidValues(first.output)[0];
				if (privatePid === undefined) throw new Error("isolated child never reached its private instance");
				expect(privatePid).not.toBe(rootIso.pid);
				const sessionFile = AgentRegistry.global().get("PoolRevive")?.sessionFile;
				if (!sessionFile) throw new Error("parked child lost its session file");

				await AgentLifecycleManager.global().park("PoolRevive");
				await waitForIsolationExit(auditPath, privatePid);
				const spawnedBefore = spawnedPids(await readIsolationAudit(auditPath)).length;

				// The live owner policy now yields an invalid record read: validation must throw before
				// acquireAgentMCPManager, so no private startup and no follower can exist.
				mirror.corruptAccountPools();
				const effectivePools = cfgTaskAgentAccountPools.get(mirror.settings);
				const taskPools: unknown = effectivePools.task;
				if (typeof taskPools !== "object" || taskPools === null) {
					throw new Error(`effective account pool is not the corrupted record: ${JSON.stringify(effectivePools)}`);
				}
				expect(Reflect.get(taskPools, "anthropic")).toBe("email:a@example.com");
				expect(() => validateAgentAccountPools(effectivePools)).toThrow("Invalid task.agentAccountPools");
				let failureText = "";
				try {
					const revived = await runSubagentFollowUpTurn({
						id: "PoolRevive",
						agent: AGENT,
						message: "ISO_STATUS",
						structured: false,
					});
					failureText = revived.error ?? revived.stderr ?? "";
				} catch (error) {
					failureText = error instanceof Error ? error.message : String(error);
				}
				expect(failureText).toContain("Invalid task.agentAccountPools");
				expect(spawnedPids(await readIsolationAudit(auditPath))).toHaveLength(spawnedBefore);
				const live = livePids(await readIsolationAudit(auditPath)).sort((left, right) => left - right);
				expect(live).toEqual([rootIso.pid, rootShared.pid].sort((left, right) => left - right));

				// The failed revival closed the transcript it opened; its writer lock is free again.
				const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
					suppressBreadcrumb: true,
					throwIfMissing: true,
				});
				try {
					expect(reopened.getEntries().length).toBeGreaterThan(0);
				} finally {
					await reopened.close();
				}
			} finally {
				setSubagentWorkerPoolForTests(pool);
				mirror.restore();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"gives a nested task-tool child its own private instance from the outer child's scope",
		async () => {
			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");
			const results: SubagentToolResult[] = [];
			const result = await runSubprocess(
				runOptions("NestedOuter", "SPAWN_NESTED", { onToolResult: toolResult => results.push(toolResult) }),
			);
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);

			const outerStatus = results.find(toolResult => toolResult.tool.includes("fixture_status"));
			const nestedTask = results.find(toolResult => toolResult.tool === "task");
			if (!outerStatus || !nestedTask) throw new Error("expected the outer MCP status and nested task results");
			const outerPid = pidValues(outerStatus.text)[0];
			const nestedPid = pidValues(nestedTask.text)[0];
			if (outerPid === undefined || nestedPid === undefined) throw new Error("missing nested/outer PIDs");
			expect(outerPid).not.toBe(rootIso.pid);
			expect(nestedPid).not.toBe(rootIso.pid);
			expect(nestedPid).not.toBe(outerPid);
			expect(nestedPid).not.toBe(rootShared.pid);

			const spawned = await waitForIsolationSpawn(auditPath, 4);
			expect(spawned).toContain(outerPid);
			expect(spawned).toContain(nestedPid);
			const live = livePids(await readIsolationAudit(auditPath));
			expect(live).toContain(outerPid);
			expect(live).toContain(nestedPid);
			expect(live).toContain(rootIso.pid);
			expect(live).toContain(rootShared.pid);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"surfaces a private startup failure instead of running the child on the root's isolated instance",
		async () => {
			await manager.disconnectAll();
			const failureAudit = path.join(root, "failure.jsonl");
			await manager.connectServers(
				{
					shared: isolationFixtureConfig(failureAudit, { label: "shared" }),
					iso: isolationFixtureConfig(failureAudit, {
						label: "iso",
						isolation: "agent",
						maxInstances: 2,
					}),
				},
				{},
				undefined,
				0,
			);
			const startup = await manager.waitForStartup(0);
			expect(startup.failed).toEqual([]);
			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");

			let output = "";
			let errorText = "";
			try {
				const result = await runSubprocess(runOptions("Failing", "ISO_STATUS"));
				output = result.output;
				errorText = result.error ?? "";
			} catch (error) {
				errorText = error instanceof Error ? error.message : String(error);
			}
			expect(errorText).toContain("MCP agent isolation failed to start");
			expect(output).not.toContain(String(rootIso.pid));
			expect(livePids(await readIsolationAudit(failureAudit))).toEqual(
				expect.arrayContaining([rootIso.pid, rootShared.pid]),
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"resolves a resource read through the child's own private server",
		async () => {
			const toolResults: SubagentToolResult[] = [];
			const result = await runSubprocess(
				runOptions("Resource", "READ_ISO", { onToolResult: toolResult => toolResults.push(toolResult) }),
			);
			expect(result.error).toBeUndefined();
			const rootIso = await readFixtureStatus(manager, "iso");
			const rootShared = await readFixtureStatus(manager, "shared");

			const statusResult = toolResults.find(toolResult => toolResult.tool.includes("fixture_status"));
			const readResult = toolResults.find(toolResult => toolResult.tool === "read");
			if (!statusResult) throw new Error("child never called fixture_status");
			if (!readResult) throw new Error("child never called read for fixture://iso/status");
			expect(readResult.isError).toBe(false);
			expect(readResult.text.length).toBeGreaterThan(0);
			const statusPid = pidValues(statusResult.text)[0];
			const readPid = pidValues(readResult.text)[0];
			if (statusPid === undefined) throw new Error("status tool returned no PID");
			if (readPid === undefined) throw new Error(`resource read returned no PID: ${readResult.text}`);
			expect(readPid).toBe(statusPid);
			expect(readPid).not.toBe(rootIso.pid);
			expect(readPid).not.toBe(rootShared.pid);
			expect(livePids(await readIsolationAudit(auditPath))).toContain(readPid);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cold-revives a parked child through the canonical root with a fresh private instance",
		async () => {
			const first = await runSubprocess(runOptions("Cold", "ISO_STATUS"));
			expect(first.error).toBeUndefined();
			const rootIso = await readFixtureStatus(manager, "iso");
			const firstPids = pidValues(first.output).filter(pid => pid !== rootIso.pid);
			expect(firstPids).toHaveLength(1);
			const [firstIso] = firstPids;
			if (firstIso === undefined) throw new Error("first run never reached an isolated instance");
			const home = AgentRegistry.global().get("Cold")?.session;
			if (!(home instanceof RemoteAgentSession)) throw new Error("expected a worker-homed child");
			await AgentLifecycleManager.global().park("Cold");
			await waitForIsolationExit(auditPath, firstIso);
			const worker = pool.forThread(home.home);
			if (!worker) throw new Error("expected the child's home worker");
			worker.terminate("cold revive test");

			const lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: rootSession(),
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
					eventBus,
				}),
				() => 0,
			);
			const revived = await runSubagentFollowUpTurn({
				id: "Cold",
				agent: AGENT,
				message: "ISO_STATUS",
				structured: false,
			});
			expect(revived.error).toBeUndefined();
			const revivedPids = pidValues(revived.output).filter(pid => pid !== rootIso.pid);
			expect(revivedPids).toHaveLength(1);
			expect(revivedPids[0]).not.toBe(firstIso);
			expect(livePids(await readIsolationAudit(auditPath))).toContain(revivedPids[0]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs a shared-only child on the root's process and starts none of its own",
		async () => {
			await manager.disconnectAll();
			const sharedOnly: Record<string, MCPServerConfig> = {
				shared: isolationFixtureConfig(auditPath, { label: "shared" }),
			};
			await manager.connectServers(sharedOnly, {});
			await manager.waitForStartup(0);
			const before = spawnedPids(await readIsolationAudit(auditPath));
			const shared = await readFixtureStatus(manager, "shared");

			const result = await runSubprocess(runOptions("Plain", "SHARED_STATUS"));
			expect(result.error).toBeUndefined();
			expect(pidValues(result.output)).toEqual([shared.pid]);
			expect(spawnedPids(await readIsolationAudit(auditPath))).toEqual(before);
		},
		TEST_TIMEOUT_MS,
	);
});
