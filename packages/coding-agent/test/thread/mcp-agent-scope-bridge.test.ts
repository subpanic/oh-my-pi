/**
 * Worker-bridge runtime contract for per-agent MCP isolation.
 *
 * A real worker acquires owner-bound scopes from main's root manager over the
 * integrations RPC service. Each scope must combine the root's existing shared
 * servers with its own private instance of every opted-in server; private
 * instances must be real, distinct processes whose tools, resources,
 * instructions and notifications never leak into a sibling or the root, and
 * disposing one scope or losing its worker must close only its own processes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import type { IntegrationsProbe, WorkerScopeSnapshot } from "../fixtures/integrations-worker";
import type { FixtureStatus } from "../helpers/isolation-fixture";
import {
	ADD_TOOL_TOOL,
	DYNAMIC_TOOL,
	NOTIFY_TOOL,
	STATE_TOOL,
	STATUS_TOOL,
	callFixtureStatus,
	isolationFixtureConfig,
	livePids,
	parseFixtureStatus,
	readFixtureStatus,
	readIsolationAudit,
	spawnedPids,
	waitForIsolationAudit,
	waitForIsolationExit,
	waitForIsolationSpawn,
} from "../helpers/isolation-fixture";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

interface Stack {
	dir: string;
	auditPath: string;
	manager: MCPManager;
	fixture: ServiceWorker<IntegrationsProbe>;
	configs: Record<string, MCPServerConfig>;
	stopped: boolean;
}

const stacks: Stack[] = [];

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs}ms`);
		await Bun.sleep(10);
	}
}

/** Acquire a worker scope and wait for its private server's tools; startup may resolve before the handshake. */
async function openScope(stack: Stack, handleId: string, expectIso = true): Promise<WorkerScopeSnapshot> {
	const snapshot = await stack.fixture.probe.mcpScopeCreate(handleId);
	if (expectIso) {
		await waitFor(async () =>
			(await stack.fixture.probe.mcpScopeSnapshot(handleId)).tools.includes("iso/fixture_status"),
		);
	}
	return snapshot;
}

async function openStack(options: {
	isolated: boolean;
	handshakeDelayMs?: number;
	timeout?: number;
	stallInstance?: number;
	exitDelayMs?: number;
	unboundedPrivateStartup?: boolean;
}): Promise<Stack> {
	const dir = path.join(os.tmpdir(), `omp-mcp-agent-scope-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	const auditPath = path.join(dir, "audit.jsonl");
	const configs: Record<string, MCPServerConfig> = {
		shared: isolationFixtureConfig(auditPath, { label: "shared" }),
	};
	if (options.isolated) {
		configs.iso = isolationFixtureConfig(auditPath, {
			label: "iso",
			isolation: "agent",
			handshakeDelayMs: options.handshakeDelayMs,
			timeout: options.timeout,
			stallInstance: options.stallInstance,
			exitDelayMs: options.exitDelayMs,
		});
	}
	const manager = new MCPManager(dir, null, async () => ({ configs, sources: {}, exaApiKeys: [] }));
	if (options.unboundedPrivateStartup) {
		// The private manager inherits this discovery window; zero makes a stalled handshake outlive
		// every request timeout, so only the worker-exit abort can end the acquisition.
		await manager.discoverAndConnect({
			startupTimeoutMs: 0,
			filterExa: false,
			filterBrowser: false,
			enableProjectConfig: false,
		});
	} else {
		await manager.connectServers(configs, {});
		const startup = await manager.waitForStartup(0);
		if (startup.failed.length > 0) throw new Error(`MCP startup failed: ${JSON.stringify(startup.failed)}`);
	}
	MCPManager.setInstance(manager);
	const fixture = await startServiceWorker<IntegrationsProbe>(
		new URL("../fixtures/integrations-worker.ts", import.meta.url),
		[settingsThreadService, authService, integrationsThreadService],
	);
	const stack: Stack = { dir, auditPath, manager, fixture, configs, stopped: false };
	stacks.push(stack);
	return stack;
}

async function stopStack(stack: Stack): Promise<void> {
	if (!stack.stopped) {
		stack.stopped = true;
		await stack.fixture.stop();
	}
	MCPManager.resetForTests();
	await stack.manager.disconnectAll();
	removeSyncWithRetries(stack.dir);
}

afterEach(async () => {
	for (const stack of stacks.splice(0).reverse()) await stopStack(stack);
});

function statusFromOutcome(outcome: { text: string; error?: string }): FixtureStatus {
	if (outcome.error) throw new Error(`MCP call failed: ${outcome.error}`);
	return parseFixtureStatus(JSON.parse(outcome.text));
}

describe("worker-owned MCP agent scopes", () => {
	it("delegates a worker scope to the root when no server is opted in, spawning nothing", async () => {
		const stack = await openStack({ isolated: false });
		const before = spawnedPids(await readIsolationAudit(stack.auditPath));
		const shared = await readFixtureStatus(stack.manager, "shared");

		const snapshot = await openScope(stack, "delegating", false);
		expect(snapshot.servers).toEqual(["shared"]);
		expect(snapshot.tools).toContain("shared/fixture_status");
		expect(await stack.fixture.probe.mcpScopeRevision("delegating")).toBe(stack.manager.toolViewsRevision);

		// No opted-in server means no private process: the scope delegates every route to the root.
		expect(spawnedPids(await readIsolationAudit(stack.auditPath))).toEqual(before);
		const status = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("delegating", "shared", STATUS_TOOL, {}));
		expect(status.pid).toBe(shared.pid);
		await stack.fixture.probe.mcpScopeDispose("delegating");
		expect(livePids(await readIsolationAudit(stack.auditPath))).toEqual(before);
	}, 30_000);

	it("gives two simultaneous scopes on one worker private isolated instances while sharing the root's shared server", async () => {
		const stack = await openStack({ isolated: true });
		const rootIso = await readFixtureStatus(stack.manager, "iso");
		const rootShared = await readFixtureStatus(stack.manager, "shared");

		const a = await openScope(stack, "a");
		const b = await openScope(stack, "b");
		expect(a.servers).toEqual(["iso", "shared"]);
		expect(b.servers).toEqual(["iso", "shared"]);
		expect(a.tools).toContain("iso/fixture_status");
		expect(a.tools).toContain("shared/fixture_status");

		const aIso = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const bIso = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "iso", STATUS_TOOL, {}));
		const aShared = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "shared", STATUS_TOOL, {}));
		const bShared = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "shared", STATUS_TOOL, {}));

		expect(aIso.pid).not.toBe(rootIso.pid);
		expect(bIso.pid).not.toBe(rootIso.pid);
		expect(aIso.pid).not.toBe(bIso.pid);
		expect(aShared.pid).toBe(rootShared.pid);
		expect(bShared.pid).toBe(rootShared.pid);

		// Mutable state proves the isolated processes are independent, not a shared alias.
		await stack.fixture.probe.mcpScopeCall("a", "iso", STATE_TOOL, { state: "alpha" });
		const aAfter = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const bAfter = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "iso", STATUS_TOOL, {}));
		const rootAfter = await callFixtureStatus(stack.manager.getTools(), "iso");
		expect(aAfter.state).toBe("alpha");
		expect(bAfter.state).toBe("ready");
		expect(rootAfter.state).toBe("ready");

		// The shared server is one real process for root and both scopes.
		await stack.fixture.probe.mcpScopeCall("a", "shared", STATE_TOOL, { state: "shared-alpha" });
		expect((await readFixtureStatus(stack.manager, "shared")).state).toBe("shared-alpha");
		expect(statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "shared", STATUS_TOOL, {})).state).toBe(
			"shared-alpha",
		);
	}, 30_000);

	it("routes resources and instructions through the bound owner, never a sibling or root process", async () => {
		const stack = await openStack({ isolated: true });
		const rootIso = await readFixtureStatus(stack.manager, "iso");
		const shared = await readFixtureStatus(stack.manager, "shared");
		await openScope(stack, "a");
		await openScope(stack, "b");

		const aIso = await stack.fixture.probe.mcpScopeReadResource("a", "iso", "fixture://status");
		const bIso = await stack.fixture.probe.mcpScopeReadResource("b", "iso", "fixture://status");
		const aShared = await stack.fixture.probe.mcpScopeReadResource("a", "shared", "fixture://status");
		const aInstructions = await stack.fixture.probe.mcpScopeInstructions("a");
		const bInstructions = await stack.fixture.probe.mcpScopeInstructions("b");
		const rootInstructions = stack.manager.getServerInstructions();

		expect(aIso.pid).not.toBe(rootIso.pid);
		expect(aIso.pid).not.toBe(bIso.pid);
		expect(aShared.pid).toBe(shared.pid);
		expect(aInstructions.iso).toContain(`pid=${aIso.pid}`);
		expect(bInstructions.iso).toContain(`pid=${bIso.pid}`);
		expect(rootInstructions.get("iso")).toContain(`pid=${rootIso.pid}`);
		expect(rootInstructions.get("shared")).toContain(`pid=${shared.pid}`);
	}, 30_000);

	it("delivers a private server's notifications only to the scope that owns it", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		await openScope(stack, "b");
		await stack.fixture.probe.mcpScopeWatch("a");
		await stack.fixture.probe.mcpScopeWatch("b");

		const aStatus = statusFromOutcome(
			await stack.fixture.probe.mcpScopeCall("a", "iso", NOTIFY_TOOL, { marker: "private-a" }),
		);
		await waitFor(async () => (await stack.fixture.probe.mcpScopeLastNotification("a")) !== null);
		const frame = await stack.fixture.probe.mcpScopeLastNotification("a");
		if (!frame) throw new Error("owning scope never saw its private notification");
		expect(frame.serverName).toBe("iso");
		expect(frame.method).toBe("notifications/fixture/state");
		expect(frame.params).toMatchObject({ pid: aStatus.pid, marker: "private-a" });
		// Both listeners are registered before the call; main dispatches one frame synchronously, so the
		// sibling that does not own this process must still have seen nothing.
		expect(await stack.fixture.probe.mcpScopeLastNotification("b")).toBeNull();
	}, 30_000);

	it("keeps dynamic tool grants inside the scope that provoked them and advances only its revision", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		await openScope(stack, "b");
		const beforeA = await stack.fixture.probe.mcpScopeRevision("a");
		const beforeB = await stack.fixture.probe.mcpScopeRevision("b");
		const rootRevision = stack.manager.toolViewsRevision;

		await stack.fixture.probe.mcpScopeCall("a", "iso", ADD_TOOL_TOOL, {});
		await waitFor(async () => (await stack.fixture.probe.mcpScopeRevision("a")) > beforeA);
		// The existing sibling never sees A's private grant and its effective view did not change.
		const existingB = await stack.fixture.probe.mcpScopeSnapshot("b");
		expect(existingB.tools).not.toContain("iso/fixture_dynamic");
		expect(await stack.fixture.probe.mcpScopeRevision("b")).toBe(beforeB);
		// A's own process added the tool; a fresh scope from the canonical root starts with a new
		// process that never ran the fixture mutation, and the root's revision is untouched.
		const freshA = await openScope(stack, "a-tools");
		expect(freshA.tools).not.toContain("iso/fixture_dynamic");
		const dynamic = await stack.fixture.probe.mcpScopeCall("a", "iso", DYNAMIC_TOOL, {});
		expect(dynamic.error).toBeUndefined();
		expect(JSON.parse(dynamic.text)).toMatchObject({ dynamic: true });
		const freshB = await openScope(stack, "b-tools");
		expect(freshB.tools).not.toContain("iso/fixture_dynamic");
		expect(stack.manager.toolViewsRevision).toBe(rootRevision);
	}, 30_000);

	it("disposes one scope without touching its sibling, the root's shared server, or a later handle", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		await openScope(stack, "b");
		const a = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const b = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "iso", STATUS_TOOL, {}));
		const shared = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "shared", STATUS_TOOL, {}));

		await stack.fixture.probe.mcpScopeDispose("a");
		await waitForIsolationExit(stack.auditPath, a.pid);
		const live = livePids(await readIsolationAudit(stack.auditPath));
		expect(live).toContain(b.pid);
		expect(live).toContain(shared.pid);
		// Repeated disposal is idempotent and a sibling still answers.
		await stack.fixture.probe.mcpScopeDispose("a");
		expect(statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "iso", STATUS_TOOL, {})).pid).toBe(b.pid);

		// A later acquisition is independent: disposing the earlier scope again cannot close it.
		await openScope(stack, "later");
		const later = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("later", "iso", STATUS_TOOL, {}));
		expect(later.pid).not.toBe(a.pid);
		expect(later.pid).not.toBe(b.pid);
		await stack.fixture.probe.mcpScopeDispose("a");
		expect(statusFromOutcome(await stack.fixture.probe.mcpScopeCall("later", "iso", STATUS_TOOL, {})).pid).toBe(
			later.pid,
		);
	}, 30_000);

	it("acquires a nested scope from the canonical root, not from the parent scope's private instances", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "parent");
		const parent = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("parent", "iso", STATUS_TOOL, {}));
		const nestedSnapshot = await stack.fixture.probe.mcpScopeNested("parent", "nested");
		await waitFor(async () =>
			(await stack.fixture.probe.mcpScopeSnapshot("nested")).tools.includes("iso/fixture_status"),
		);
		const nested = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("nested", "iso", STATUS_TOOL, {}));
		const shared = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("nested", "shared", STATUS_TOOL, {}));

		expect(nestedSnapshot.servers).toEqual(["iso", "shared"]);
		expect(nested.pid).not.toBe(parent.pid);
		expect(shared.pid).toBe(
			statusFromOutcome(await stack.fixture.probe.mcpScopeCall("parent", "shared", STATUS_TOOL, {})).pid,
		);
	}, 30_000);

	it("closes a worker's private scopes when the worker dies, leaving the root's servers alive", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		await openScope(stack, "b");
		const a = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const b = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("b", "iso", STATUS_TOOL, {}));
		const shared = await readFixtureStatus(stack.manager, "shared");
		const rootIso = await readFixtureStatus(stack.manager, "iso");

		stack.stopped = true;
		await stack.fixture.stop();
		await waitForIsolationExit(stack.auditPath, a.pid);
		await waitForIsolationExit(stack.auditPath, b.pid);
		const live = livePids(await readIsolationAudit(stack.auditPath));
		expect(live).toContain(shared.pid);
		expect(live).toContain(rootIso.pid);
		expect(live).not.toContain(a.pid);
		expect(live).not.toContain(b.pid);
	}, 30_000);

	it("clears a shared-only worker proxy's cached tools on disposal while preserving canonical sibling acquisition", async () => {
		const stack = await openStack({ isolated: false });
		const rootShared = await readFixtureStatus(stack.manager, "shared");
		const created = await openScope(stack, "shared", false);
		expect(created.tools).toContain("shared/fixture_status");
		const revisionBeforeDispose = created.revision;

		await stack.fixture.probe.mcpScopeDisposeRetained("shared");
		const disposed = await stack.fixture.probe.mcpScopeSnapshot("shared");
		expect(disposed.tools).toEqual([]);
		expect(disposed.servers).toEqual([]);
		expect(disposed.revision).toBeGreaterThan(revisionBeforeDispose);
		expect((await readFixtureStatus(stack.manager, "shared")).pid).toBe(rootShared.pid);

		// The retained disposed proxy still routes sibling acquisition from the canonical root.
		const fresh = await stack.fixture.probe.mcpScopeNested("shared", "fresh");
		await waitFor(async () =>
			(await stack.fixture.probe.mcpScopeSnapshot("fresh")).tools.includes("shared/fixture_status"),
		);
		expect(fresh.servers).toEqual(["shared"]);
		await stack.fixture.probe.mcpScopeDisposeRetained("shared");
		expect((await stack.fixture.probe.mcpScopeSnapshot("shared")).tools).toEqual([]);
		await stack.fixture.probe.mcpScopeDispose("fresh");
		expect(livePids(await readIsolationAudit(stack.auditPath))).toContain(rootShared.pid);
	}, 30_000);

	it("closes a scope whose acquisition resolves after its worker already exited", async () => {
		const stack = await openStack({ isolated: true, handshakeDelayMs: 400 });
		await openScope(stack, "first");
		const before = spawnedPids(await readIsolationAudit(stack.auditPath)).length;

		await stack.fixture.probe.mcpScopeCreateDeferred("late");
		// The private stdio process connects before its delayed handshake settles; wait for the real
		// spawn so this case proves late-result cleanup rather than an abort-before-start race.
		const after = await waitForIsolationSpawn(stack.auditPath, before + 1);
		const latePid = after[before];
		if (latePid === undefined) throw new Error("late acquisition never spawned");
		stack.stopped = true;
		await stack.fixture.stop();

		// The late scope was acquired for a dead owner, so main must close it instead of retaining it.
		await waitForIsolationExit(stack.auditPath, latePid);
		expect(livePids(await readIsolationAudit(stack.auditPath))).not.toContain(latePid);
	}, 30_000);

	it("aborts a truly stalled scope handshake when its worker exits, leaving completed scopes and the root alive", async () => {
		// `timeout: 0` disables the client request timeout and instance 4 never answers initialize, so
		// only the per-worker-exit abort can close this private startup.
		const stack = await openStack({
			isolated: true,
			timeout: 0,
			stallInstance: 4,
			unboundedPrivateStartup: true,
		});
		await openScope(stack, "completed");
		const completed = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("completed", "iso", STATUS_TOOL, {}));
		const rootShared = await readFixtureStatus(stack.manager, "shared");
		const rootIso = await readFixtureStatus(stack.manager, "iso");

		await stack.fixture.probe.mcpScopeCreateDeferred("hung");
		const spawned = await waitForIsolationSpawn(stack.auditPath, 4);
		const hungPid = spawned[3];
		if (hungPid === undefined) throw new Error("stalled acquisition never spawned");
		expect(livePids(await readIsolationAudit(stack.auditPath))).toContain(hungPid);

		// Disposing an unrelated completed scope must not abort the pending acquisition.
		await stack.fixture.probe.mcpScopeDispose("completed");
		await waitForIsolationExit(stack.auditPath, completed.pid);
		expect(livePids(await readIsolationAudit(stack.auditPath))).toContain(hungPid);

		stack.stopped = true;
		await stack.fixture.stop();
		await waitForIsolationExit(stack.auditPath, hungPid, 10_000);
		const live = livePids(await readIsolationAudit(stack.auditPath));
		expect(live).not.toContain(hungPid);
		expect(live).not.toContain(completed.pid);
		expect(live).toContain(rootShared.pid);
		expect(live).toContain(rootIso.pid);
	}, 30_000);

	it("replaces a private server config and disposes only its scope's new instance", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		const old = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const rootShared = await readFixtureStatus(stack.manager, "shared");
		const rootIso = await readFixtureStatus(stack.manager, "iso");

		// Only the isolated definition changes; the root connection stays. The bound scope's own
		// status identifies the real replacement PID, independent of any audit spawn ordering.
		const replacement = isolationFixtureConfig(stack.auditPath, {
			label: "iso",
			isolation: "agent",
			initialState: "replacement",
		});
		await stack.manager.updateServerConfig("iso", replacement);
		await waitForIsolationExit(stack.auditPath, old.pid);
		let replaced: FixtureStatus | undefined;
		await waitFor(async () => {
			try {
				const status = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
				if (status.pid === old.pid) return false;
				replaced = status;
				return status.state === "replacement";
			} catch {
				return false;
			}
		});
		if (!replaced) throw new Error("scope never reconciled the replacement instance");

		const disposed = await Promise.race([
			stack.fixture.probe.mcpScopeDisposeRetained("a").then(() => true),
			Bun.sleep(10_000).then(() => false),
		]);
		expect(disposed).toBe(true);
		await waitForIsolationExit(stack.auditPath, replaced.pid);
		expect(livePids(await readIsolationAudit(stack.auditPath))).not.toContain(replaced.pid);
		const snapshot = await stack.fixture.probe.mcpScopeSnapshot("a");
		expect(snapshot.tools).toEqual([]);
		expect((await readFixtureStatus(stack.manager, "shared")).pid).toBe(rootShared.pid);
		expect((await readFixtureStatus(stack.manager, "iso")).pid).toBe(rootIso.pid);

		await stack.manager.disconnectAll();
		await waitForIsolationAudit(stack.auditPath, current => livePids(current).length === 0, 15_000);
	}, 40_000);

	it("disposes a scope during replacement removal before the stalled replacement starts", async () => {
		// The old private server stays alive for 250 ms after EOF, letting disposal land inside the
		// reconcile's replacement-removal window. The replacement has no request timeout and a very
		// long handshake, so any start after disposal would remain visible.
		const stack = await openStack({ isolated: true, exitDelayMs: 250 });
		await openScope(stack, "a");
		const old = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const rootShared = await readFixtureStatus(stack.manager, "shared");
		const rootIso = await readFixtureStatus(stack.manager, "iso");
		const replacement = isolationFixtureConfig(stack.auditPath, {
			label: "iso",
			isolation: "agent",
			timeout: 0,
			handshakeDelayMs: 3_600_000,
		});
		await stack.manager.updateServerConfig("iso", replacement);
		await waitForIsolationAudit(
			stack.auditPath,
			current => current.some(event => event.event === "closing" && event.pid === old.pid),
			15_000,
		);
		const spawnedAtClose = spawnedPids(await readIsolationAudit(stack.auditPath)).length;
		expect(livePids(await readIsolationAudit(stack.auditPath))).toContain(old.pid);

		const disposed = await Promise.race([
			stack.fixture.probe.mcpScopeDisposeRetained("a").then(() => true),
			Bun.sleep(10_000).then(() => false),
		]);
		expect(disposed).toBe(true);
		// Disposal waited out the removal but must not have started the replacement handshake.
		expect(spawnedPids(await readIsolationAudit(stack.auditPath))).toHaveLength(spawnedAtClose);
		await waitForIsolationExit(stack.auditPath, old.pid);
		const live = livePids(await readIsolationAudit(stack.auditPath)).sort((left, right) => left - right);
		expect(live).toEqual([rootIso.pid, rootShared.pid].sort((left, right) => left - right));

		await stack.manager.disconnectAll();
		await waitForIsolationAudit(stack.auditPath, current => livePids(current).length === 0, 15_000);
	}, 40_000);

	it("root reset during a replaced-config reconcile never starts the stalled replacement", async () => {
		// The original isolated server takes 250 ms to exit after EOF, keeping the reconcile's
		// removed-config disconnect observable while root reset runs.
		const stack = await openStack({ isolated: true, exitDelayMs: 250 });
		await openScope(stack, "a");
		const old = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const before = spawnedPids(await readIsolationAudit(stack.auditPath)).length;
		const replacement = isolationFixtureConfig(stack.auditPath, {
			label: "iso",
			isolation: "agent",
			timeout: 0,
			stallInstance: before + 1,
		});
		await stack.manager.updateServerConfig("iso", replacement);
		await waitForIsolationAudit(
			stack.auditPath,
			current => current.some(event => event.event === "closing" && event.pid === old.pid),
			15_000,
		);
		expect(livePids(await readIsolationAudit(stack.auditPath))).toContain(old.pid);

		const resetAt = Date.now();
		const bounded = await Promise.race([
			stack.manager.disconnectAll().then(() => true),
			Bun.sleep(10_000).then(() => false),
		]);
		expect(bounded).toBe(true);
		await waitForIsolationAudit(stack.auditPath, current => livePids(current).length === 0, 15_000);
		const events = await readIsolationAudit(stack.auditPath);
		const postResetSpawns = events.filter(
			event =>
				event.event === "spawn" &&
				event.instance !== undefined &&
				event.instance > before &&
				(event.at ?? 0) > resetAt,
		);
		expect(postResetSpawns).toEqual([]);
		expect(livePids(events)).toEqual([]);
	}, 30_000);

	it("reconciles a live scope with fresh private instances across a root reload instead of leaving stale access", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		const before = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {}));
		const sharedBefore = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "shared", STATUS_TOOL, {}));

		await stack.manager.disconnectAll();
		await waitForIsolationExit(stack.auditPath, before.pid);
		await waitForIsolationExit(stack.auditPath, sharedBefore.pid);

		await stack.manager.connectServers(stack.configs, {});
		const startup = await stack.manager.waitForStartup(0);
		expect(startup.failed).toEqual([]);

		// The live scope stays subscribed across the reload and gets a fresh private instance, never the
		// root's shared one and never the closed process's stale id.
		let after: { pid: number } | undefined;
		await waitFor(async () => {
			try {
				const outcome = await stack.fixture.probe.mcpScopeCall("a", "iso", STATUS_TOOL, {});
				if (outcome.error) return false;
				after = JSON.parse(outcome.text) as { pid: number };
				return after.pid !== before.pid;
			} catch {
				return false;
			}
		});
		if (!after) throw new Error("scope never reconciled its isolated instance");
		const rootIso = await readFixtureStatus(stack.manager, "iso");
		expect(after.pid).not.toBe(rootIso.pid);
		const sharedAfter = statusFromOutcome(await stack.fixture.probe.mcpScopeCall("a", "shared", STATUS_TOOL, {}));
		expect(sharedAfter.pid).not.toBe(sharedBefore.pid);
	}, 40_000);

	it("closes every child scope when the root shuts down, leaving no fixture processes", async () => {
		const stack = await openStack({ isolated: true });
		await openScope(stack, "a");
		await openScope(stack, "b");
		await waitForIsolationSpawn(stack.auditPath, 3);

		await stack.manager.disconnectAll();
		const deadline = Date.now() + 15_000;
		while (livePids(await readIsolationAudit(stack.auditPath)).length > 0) {
			if (Date.now() > deadline) {
				throw new Error(
					`children survived root shutdown: ${JSON.stringify(await readIsolationAudit(stack.auditPath))}`,
				);
			}
			await Bun.sleep(10);
		}
		expect(livePids(await readIsolationAudit(stack.auditPath))).toEqual([]);
		// The worker's now-dead scopes dispose idempotently after root shutdown.
		await stack.fixture.probe.mcpScopeDispose("a");
		expect(livePids(await readIsolationAudit(stack.auditPath))).toEqual([]);
	}, 30_000);
});
