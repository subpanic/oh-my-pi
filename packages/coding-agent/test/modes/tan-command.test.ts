/**
 * `/tan` is a live child: it must acquire its own owner-bound MCP view before
 * minting proxies, keep the shared root server, and close only its private
 * isolated instance when the clone parks. This test drives the real
 * `TanCommandController`, real SDK session/lease path, real stdio MCP fixture,
 * and a deterministic local scripted provider (no external model calls).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { TanCommandController } from "../../src/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createAgentSession } from "../../src/sdk";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	STATUS_TOOL,
	isolationFixtureConfig,
	livePids,
	readFixtureStatus,
	readIsolationAudit,
	waitForIsolationExit,
	waitForIsolationSpawn,
} from "../helpers/isolation-fixture";
import { ScriptedModelServer, type ScriptedRequest } from "../fixtures/scripted-model-server";

const MODEL = "scripted/scripted-model";
const TAN_MARKER = `omp-tan-isolation-${Bun.randomUUIDv7("hex")}`;
const TAN_WORK = "TAN_ISO_STATUS";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

/** Compact evidence of what the scripted provider was actually offered and asked. */
function scriptedRequestEvidence(): string {
	return JSON.stringify(
		scriptedRequests.map(request => ({
			lastUser: request.lastUserText.slice(0, 160),
			offersIso: request.toolNames.includes(`mcp__iso_${STATUS_TOOL}`),
			toolNames: request.toolNames,
			lastToolTexts: request.lastToolTexts,
		})),
	);
}

let root: string;
let cwd: string;
let auditPath: string;
let savedEnv: Record<string, string | undefined> = {};
let server: ScriptedModelServer;
let scriptedRequests: ScriptedRequest[] = [];
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let manager: MCPManager;
let eventBus: EventBus;
let parentManager: SessionManager;
let parentSession: AgentSession;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tan-isolation-"));
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

	scriptedRequests = [];
	server = new ScriptedModelServer(request => {
		scriptedRequests.push(request);
		const offersIso = request.toolNames.includes(`mcp__iso_${STATUS_TOOL}`);
		if (!offersIso || !request.lastUserText.includes(TAN_WORK)) {
			return { text: "pong" };
		}
		if (request.messages.at(-1)?.role === "tool") {
			return { text: `tool result: ${request.lastToolTexts.join("\n")}` };
		}
		return { tools: [{ name: `mcp__iso_${STATUS_TOOL}`, args: {} }] };
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
		// This test observes the clone's direct MCP proxy tool. With xd:// mounting
		// on, MCP tools are discoverable devices and never appear in the provider's
		// top-level tool list; keep them direct here, as the executor tests do.
		"tools.xdev": false,
		modelRoles: { default: MODEL },
	});
	eventBus = new EventBus();
	auditPath = path.join(root, "isolation.jsonl");
	manager = new MCPManager(cwd, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	const configs: Record<string, MCPServerConfig> = {
		shared: isolationFixtureConfig(auditPath, { label: "shared" }),
		iso: isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent" }),
	};
	await manager.connectServers(configs, {}, undefined, 0);
	const startup = await manager.waitForStartup(0);
	if (startup.failed.length > 0) throw new Error(`MCP startup failed: ${JSON.stringify(startup.failed)}`);
	MCPManager.setInstance(manager);

	parentManager = SessionManager.create(cwd, path.join(root, "sessions"));
	const model = modelRegistry.find("scripted", "scripted-model");
	if (!model) throw new Error("scripted model missing");
	const created = await createAgentSession({
		cwd,
		agentDir,
		settings,
		modelRegistry,
		authStorage,
		sessionManager: parentManager,
		model,
		customSystemPrompt: TAN_MARKER,
		mcpManager: manager,
		// A real root renders the manager's connected tools; the tan snapshot then
		// carries their logical names into the clone's presentation.
		mcpTools: manager.getTools(),
		enableMCP: true,
		toolNames: ["read"],
		eventBus,
		hasUI: false,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
	});
	parentSession = created.session;
});

afterEach(async () => {
	await parentSession?.dispose().catch(() => {});
	MCPManager.resetForTests();
	await manager?.disconnectAll();
	server?.stop();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	authStorage?.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

describe("TanCommandController MCP lease", () => {
	it("runs the clone on a private isolated instance and closes only that instance when it parks", async () => {
		const rootIso = await readFixtureStatus(manager, "iso");
		const rootShared = await readFixtureStatus(manager, "shared");
		const ctx = {
			session: parentSession,
			sessionManager: parentManager,
			settings,
			mcpManager: manager,
			showStatus: vi.fn(),
			showError: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new TanCommandController(ctx);
		expect(await controller.start(TAN_WORK)).toBe(true);

		const spawned = await waitForIsolationSpawn(auditPath, 3);
		const clonePid = spawned.find(pid => pid !== rootIso.pid && pid !== rootShared.pid);
		if (clonePid === undefined) throw new Error("tan clone never started a private instance");
		// The root SDK session owns its own AsyncJobManager; the controller registers
		// the tan job there. Await that exact job promise (no wall-clock polling).
		const sessionJobs = parentSession.asyncJobManager;
		if (!sessionJobs) throw new Error("tan parent session has no async job manager");
		const job = sessionJobs.getAllJobs().find(candidate => candidate.type === "task");
		if (!job) {
			throw new Error(
				`tan job missing from the session's job manager; jobs=${JSON.stringify(
					sessionJobs.getAllJobs().map(candidate => ({ type: candidate.type, status: candidate.status })),
				)}`,
			);
		}
		await job.promise;
		if (job.status !== "completed") {
			throw new Error(
				`tan job ${job.status}: ${job.errorText ?? "(no error text)"}; requests=${scriptedRequestEvidence()}`,
			);
		}
		// Prove the private route from the fixture audit, not only from process counts:
		// the clone's own pid must have served the status tool before its result settled.
		const audit = await readIsolationAudit(auditPath);
		const privateCall = audit.find(
			event =>
				event.event === "request" &&
				event.pid === clonePid &&
				event.method === "tools/call" &&
				event.name === STATUS_TOOL,
		);
		if (!privateCall) {
			throw new Error(
				`tan clone ${clonePid} never called ${STATUS_TOOL}; audit=${JSON.stringify(audit)}; requests=${scriptedRequestEvidence()}`,
			);
		}
		if (!job.resultText?.includes(String(clonePid))) {
			throw new Error(
				`tan result ${JSON.stringify(job.resultText)} did not carry private pid ${clonePid}; requests=${scriptedRequestEvidence()}`,
			);
		}
		expect(job.status).toBe("completed");
		expect(job.resultText).toContain(String(clonePid));

		// The clone parked in its finally block: its lease closes the private process, shared stays.
		await waitForIsolationExit(auditPath, clonePid);
		const live = livePids(await readIsolationAudit(auditPath));
		expect(live).not.toContain(clonePid);
		expect(live).toContain(rootIso.pid);
		expect(live).toContain(rootShared.pid);
		expect((await readFixtureStatus(manager, "iso")).pid).toBe(rootIso.pid);
		expect((await readFixtureStatus(manager, "shared")).pid).toBe(rootShared.pid);
	}, 60_000);
});
