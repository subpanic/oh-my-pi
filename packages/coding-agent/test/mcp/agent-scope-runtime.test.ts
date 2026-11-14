/**
 * Direct runtime contract for per-agent MCP isolation on real processes.
 *
 * These tests drive `MCPManager`/`MCPAgentScope` without the worker bridge:
 * every opted-in server must produce a real private process per acquired scope,
 * shared servers must stay single-instance, and owner-bound views must keep
 * tools, catalogs, resources, instructions, notifications and mutable server
 * state apart. Failure and pending-startup paths must never fall back to the
 * root's shared instance.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MCPAgentScope, MCPAgentScopeStartupError, MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { createMCPProxyTools } from "../../src/task/executor";
import {
	ADD_TOOL_TOOL,
	DYNAMIC_TOOL,
	type IsolationFixtureOptions,
	NOTIFY_TOOL,
	callFixtureStatus,
	callFixtureTool,
	isolationFixtureConfig,
	livePids,
	readFixtureStatus,
	readIsolationAudit,
	setFixtureState,
	spawnedPids,
	waitForIsolationAudit,
	waitForIsolationExit,
	waitForIsolationSpawn,
} from "../helpers/isolation-fixture";

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs}ms`);
		await Bun.sleep(10);
	}
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs}ms`);
		await Bun.sleep(10);
	}
}

function mcpToolNames(manager: { getTools(): readonly { mcpServerName?: string; mcpToolName?: string }[] }): string[] {
	return manager
		.getTools()
		.flatMap(tool => (tool.mcpServerName && tool.mcpToolName ? [`${tool.mcpServerName}/${tool.mcpToolName}`] : []))
		.sort();
}

describe("per-agent MCP isolation runtime", () => {
	let dir: string;
	let auditPath: string;
	let manager: MCPManager;
	let configs: Record<string, MCPServerConfig>;
	const scopes: MCPAgentScope[] = [];

	beforeEach(() => {
		dir = path.join(os.tmpdir(), `omp-mcp-agent-scope-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		auditPath = path.join(dir, "audit.jsonl");
		manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		configs = {
			shared: isolationFixtureConfig(auditPath, { label: "shared" }),
			iso: isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent" }),
		};
	});

	afterEach(async () => {
		for (const scope of scopes.splice(0)) await scope.disposeAgentScope().catch(() => {});
		await manager.disconnectAll();
		removeSyncWithRetries(dir);
	});

	async function connect(isoOptions: IsolationFixtureOptions = {}) {
		configs.iso = isolationFixtureConfig(auditPath, {
			label: "iso",
			isolation: "agent",
			...isoOptions,
		});
		await manager.connectServers(configs, {}, undefined, 0);
		const startup = await manager.waitForStartup(0);
		if (startup.failed.length > 0) throw new Error(`MCP startup failed: ${JSON.stringify(startup.failed)}`);
	}

	async function acquire(): Promise<MCPAgentScope> {
		const scope = await manager.createAgentScope();
		if (!(scope instanceof MCPAgentScope)) throw new Error("expected an owner-bound MCPAgentScope");
		scopes.push(scope);
		// Creation may resolve inside the startup window while the private handshake is still landing.
		await waitFor(() => scope.getTools().some(tool => tool.mcpServerName === "iso"));
		return scope;
	}

	it("returns a delegating scope, not the root, and starts no process when nothing is opted in", async () => {
		const plain = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		const plainConfigs = { shared: isolationFixtureConfig(auditPath, { label: "shared" }) };
		try {
			await plain.connectServers(plainConfigs, {}, undefined, 0);
			await plain.waitForStartup(0);
			const relative = await readFixtureStatus(plain, "shared");
			const before = spawnedPids(await readIsolationAudit(auditPath));
			const scope = await plain.createAgentScope();
			expect(scope).toBeInstanceOf(MCPAgentScope);
			expect(scope).not.toBe(plain);
			// The scope has no private instance; every shared route still reaches the root's process.
			expect(
				scope
					.getTools()
					.map(tool => tool.name)
					.sort(),
			).toEqual(
				plain
					.getTools()
					.map(tool => tool.name)
					.sort(),
			);
			expect(await readFixtureStatus(scope, "shared")).toEqual(relative);
			expect(spawnedPids(await readIsolationAudit(auditPath))).toEqual(before);
			await scope.disposeAgentScope();
			await plain.disposeAgentScope();
			expect(livePids(await readIsolationAudit(auditPath))).toEqual(before);
			expect((await readFixtureStatus(plain, "shared")).pid).toBe(relative.pid);
		} finally {
			await plain.disconnectAll();
		}
	}, 30_000);

	it("reconciles a private instance into a live zero-opt-in scope when a reload enables isolation", async () => {
		const plain = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		const sharedConfig = isolationFixtureConfig(auditPath, { label: "shared" });
		try {
			await plain.connectServers({ shared: sharedConfig }, {}, undefined, 0);
			await plain.waitForStartup(0);
			const shared = await readFixtureStatus(plain, "shared");
			const scope = await plain.createAgentScope();
			expect(await readFixtureStatus(scope, "shared")).toEqual(shared);

			await plain.connectServers(
				{
					shared: sharedConfig,
					iso: isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent" }),
				},
				{},
				undefined,
				0,
			);
			await plain.waitForStartup(0);
			let privateIso: { pid: number } | undefined;
			await waitForAsync(async () => {
				try {
					privateIso = await callFixtureStatus(scope.getTools(), "iso");
					return true;
				} catch {
					return false;
				}
			});
			if (!privateIso) throw new Error("scope never reconciled the opted-in server");
			const rootIso = await readFixtureStatus(plain, "iso");
			expect(privateIso.pid).not.toBe(rootIso.pid);
			expect(await readFixtureStatus(scope, "shared")).toEqual(shared);
			await scope.disposeAgentScope();
		} finally {
			await plain.disconnectAll();
		}
	}, 30_000);

	it("gives a scope a private instance of only the opted-in server while sharing the rest", async () => {
		await connect();
		const rootIso = await callFixtureStatus(manager.getTools(), "iso");
		const rootShared = await callFixtureStatus(manager.getTools(), "shared");
		expect(mcpToolNames(manager)).toContain("iso/fixture_status");

		const scope = await acquire();
		expect(scope).not.toBe(manager);
		expect(scope.getConnectedServers().sort()).toEqual(["iso", "shared"]);
		expect(mcpToolNames(scope)).toContain("iso/fixture_status");
		expect(mcpToolNames(scope)).toContain("shared/fixture_status");

		const scopeIso = await callFixtureStatus(scope.getTools(), "iso");
		const scopeShared = await callFixtureStatus(scope.getTools(), "shared");
		expect(scopeIso.pid).not.toBe(rootIso.pid);
		expect(scopeShared.pid).toBe(rootShared.pid);

		await setFixtureState(scope.getTools(), "iso", "private-state");
		expect((await callFixtureStatus(scope.getTools(), "iso")).state).toBe("private-state");
		expect((await callFixtureStatus(manager.getTools(), "iso")).state).toBe("ready");
	}, 30_000);

	it("keeps two scopes independent; disposing one leaves the other and the root alive", async () => {
		await connect();
		const a = await acquire();
		const b = await acquire();
		const aIso = await callFixtureStatus(a.getTools(), "iso");
		const bIso = await callFixtureStatus(b.getTools(), "iso");
		const shared = await readFixtureStatus(manager, "shared");
		expect(aIso.pid).not.toBe(bIso.pid);

		await setFixtureState(a.getTools(), "iso", "a-only");
		expect((await callFixtureStatus(b.getTools(), "iso")).state).toBe("ready");

		await a.disposeAgentScope();
		await waitForIsolationExit(auditPath, aIso.pid);
		await a.disposeAgentScope();
		// The root's disposal is a no-op and must not close a child scope's remaining processes.
		await manager.disposeAgentScope();
		const live = livePids(await readIsolationAudit(auditPath));
		expect(live).toContain(bIso.pid);
		expect(live).toContain(shared.pid);
		expect((await callFixtureStatus(b.getTools(), "iso")).pid).toBe(bIso.pid);
		expect((await callFixtureStatus(manager.getTools(), "shared")).pid).toBe(shared.pid);
	}, 30_000);

	it("acquires a nested scope as a sibling from the canonical root", async () => {
		await connect();
		const parent = await acquire();
		const parentIso = await callFixtureStatus(parent.getTools(), "iso");
		const nested = await parent.createAgentScope();
		if (!(nested instanceof MCPAgentScope)) throw new Error("expected a nested MCPAgentScope");
		scopes.push(nested);
		const nestedIso = await callFixtureStatus(nested.getTools(), "iso");
		const shared = await readFixtureStatus(manager, "shared");
		expect(nestedIso.pid).not.toBe(parentIso.pid);
		expect((await callFixtureStatus(nested.getTools(), "shared")).pid).toBe(shared.pid);
	}, 30_000);

	it("routes catalogs, resources, instructions and notifications to the owning process only", async () => {
		await connect();
		const rootIso = await readFixtureStatus(manager, "iso");
		const shared = await readFixtureStatus(manager, "shared");
		const a = await acquire();
		const b = await acquire();
		await waitFor(() => a.getServerResources("iso") !== undefined && b.getServerResources("iso") !== undefined);

		const aIso = await readFixtureStatus(a, "iso");
		const bIso = await readFixtureStatus(b, "iso");
		const aShared = await readFixtureStatus(a, "shared");
		expect(aIso.pid).not.toBe(rootIso.pid);
		expect(aIso.pid).not.toBe(bIso.pid);
		expect(aShared.pid).toBe(shared.pid);

		const rootInstructions = manager.getServerInstructions();
		const aInstructions = a.getServerInstructions();
		expect(rootInstructions.get("iso")).toContain(`pid=${rootIso.pid}`);
		expect(aInstructions.get("iso")).toContain(`pid=${aIso.pid}`);
		expect(aInstructions.get("shared")).toContain(`pid=${shared.pid}`);

		const rootFrames: string[] = [];
		const aFrames: string[] = [];
		const offRoot = manager.addNotificationListener(server => rootFrames.push(server));
		const privateHeard = Promise.withResolvers<void>();
		const sharedHeard = Promise.withResolvers<void>();
		const offScope = a.addNotificationListener(server => {
			aFrames.push(server);
			if (server === "iso") privateHeard.resolve();
			if (server === "shared") sharedHeard.resolve();
		});
		try {
			await callFixtureTool(a.getTools(), "iso", NOTIFY_TOOL, { marker: "private" });
			await privateHeard.promise;
			expect(aFrames).toContain("iso");
			expect(rootFrames).not.toContain("iso");

			await callFixtureTool(manager.getTools(), "shared", NOTIFY_TOOL, { marker: "shared" });
			await sharedHeard.promise;
			expect(aFrames).toContain("shared");
			expect(rootFrames).toContain("shared");
		} finally {
			offRoot();
			offScope();
		}
	}, 30_000);

	it("keeps dynamic grants inside the scope and bumps only the revisions whose effective view changed", async () => {
		await connect();
		const scope = await acquire();
		const rootRevision = manager.toolViewsRevision;
		const scopeRevision = scope.toolViewsRevision;

		await callFixtureTool(scope.getTools(), "iso", ADD_TOOL_TOOL);
		await waitFor(() => scope.getTools().some(tool => tool.mcpToolName === DYNAMIC_TOOL));
		expect(scope.toolViewsRevision).toBeGreaterThan(scopeRevision);
		expect(manager.toolViewsRevision).toBe(rootRevision);
		expect(manager.getTools().some(tool => tool.mcpToolName === DYNAMIC_TOOL)).toBe(false);

		// A shared-root tool change reaches the scope's effective view and advances its revision.
		const beforeSharedChange = scope.toolViewsRevision;
		await callFixtureTool(manager.getTools(), "shared", ADD_TOOL_TOOL);
		await waitFor(() =>
			scope.getTools().some(tool => tool.mcpToolName === DYNAMIC_TOOL && tool.mcpServerName === "shared"),
		);
		expect(scope.toolViewsRevision).toBeGreaterThan(beforeSharedChange);
	}, 30_000);

	it("forwards a scope's scoped private dynamic tool into a newly seeded non-owner view", async () => {
		await connect();
		const scope = await acquire();
		scope.openToolScope("parent");
		const loader = createMCPProxyTools(scope, "parent").find(
			tool => tool.mcpServerName === "iso" && tool.mcpToolName === ADD_TOOL_TOOL,
		);
		if (!loader?.execute) throw new Error("expected the private add-tool proxy");
		await loader.execute("scope-load", {}, undefined, {} as CustomToolContext);
		await waitFor(() => scope.getTools("parent").some(tool => tool.mcpToolName === DYNAMIC_TOOL));

		// A view opened from `parent` must inherit the private grant; an unseeded sibling must not.
		scope.openToolScope("seeded", "parent");
		scope.openToolScope("unseeded");
		expect(scope.getTools("seeded").some(tool => tool.mcpToolName === DYNAMIC_TOOL)).toBe(true);
		expect(scope.getTools("unseeded").some(tool => tool.mcpToolName === DYNAMIC_TOOL)).toBe(false);
	}, 30_000);

	it("rejects a private startup failure without falling back to the root's shared instance", async () => {
		// Two root instances (shared + root's own iso) succeed; the third process — the scope's private
		// iso — exits before its handshake.
		configs.iso = isolationFixtureConfig(auditPath, { label: "iso", isolation: "agent", maxInstances: 2 });
		await manager.connectServers(configs, {}, undefined, 0);
		const startup = await manager.waitForStartup(0);
		expect(startup.failed).toEqual([]);
		const rootIso = await readFixtureStatus(manager, "iso");
		const rootShared = await readFixtureStatus(manager, "shared");
		const before = spawnedPids(await readIsolationAudit(auditPath));
		expect(before).toHaveLength(2);

		let failure: unknown;
		try {
			await manager.createAgentScope();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MCPAgentScopeStartupError);
		if (!(failure instanceof MCPAgentScopeStartupError)) throw new Error("expected MCPAgentScopeStartupError");
		expect(failure.name).toBe("MCPAgentScopeStartupError");
		expect(failure.failures.map(entry => entry.serverName)).toEqual(["iso"]);

		// The failed private process exited; the root's own instances were never closed or reused.
		const after = await waitForIsolationAudit(auditPath, events => spawnedPids(events).length >= 3);
		const privatePid = spawnedPids(after)[2];
		if (privatePid === undefined) throw new Error("private startup never spawned");
		await waitForIsolationExit(auditPath, privatePid);
		const live = livePids(await readIsolationAudit(auditPath));
		expect(live).toContain(rootIso.pid);
		expect(live).toContain(rootShared.pid);
		expect(live).not.toContain(privatePid);
		expect((await readFixtureStatus(manager, "iso")).pid).toBe(rootIso.pid);
	}, 30_000);

	it("rejects a private startup failure that lands after the root's fast startup window", async () => {
		// Root shared and root iso are instances 1–2; the scope's private iso is 3 and fails its
		// initialize only after 500 ms, long after the root's 50 ms startup window.
		configs.iso = isolationFixtureConfig(auditPath, {
			label: "iso",
			isolation: "agent",
			failInitializeInstance: 3,
			failInitializeAfterMs: 500,
		});
		await manager.connectServers(configs, {}, undefined, 50);
		const rootStartup = await manager.waitForStartup(0);
		expect(rootStartup.failed).toEqual([]);
		const rootIso = await readFixtureStatus(manager, "iso");
		const rootShared = await readFixtureStatus(manager, "shared");
		const before = spawnedPids(await readIsolationAudit(auditPath));
		expect(before).toHaveLength(2);

		let failure: unknown;
		try {
			await manager.createAgentScope();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MCPAgentScopeStartupError);
		if (!(failure instanceof MCPAgentScopeStartupError)) throw new Error("expected MCPAgentScopeStartupError");
		expect(failure.failures.map(entry => entry.serverName)).toEqual(["iso"]);

		const spawned = await waitForIsolationSpawn(auditPath, 3);
		const privatePid = spawned[2];
		if (privatePid === undefined) throw new Error("late private startup never spawned");
		await waitForIsolationExit(auditPath, privatePid);
		const live = livePids(await readIsolationAudit(auditPath));
		expect(live).not.toContain(privatePid);
		expect(live).toContain(rootIso.pid);
		expect(live).toContain(rootShared.pid);
	}, 30_000);

	it("aborts a stalled private acquisition and releases its process before any request timeout", async () => {
		// A private manager inherits the root's discovery startup window. Zero makes the acquisition
		// await the stalled handshake indefinitely, so only the acquisition signal can end it.
		const stallAudit = path.join(dir, "stall.jsonl");
		const stallConfigs: Record<string, MCPServerConfig> = {
			shared: isolationFixtureConfig(stallAudit, { label: "shared" }),
			iso: isolationFixtureConfig(stallAudit, {
				label: "iso",
				isolation: "agent",
				timeout: 0,
				stallInstance: 4,
			}),
		};
		const stallManager = new MCPManager(dir, null, async () => ({
			configs: stallConfigs,
			sources: {},
			exaApiKeys: [],
		}));
		let sibling: MCPAgentScope | undefined;
		let fresh: MCPAgentScope | undefined;
		try {
			await stallManager.discoverAndConnect({
				startupTimeoutMs: 0,
				filterExa: false,
				filterBrowser: false,
				enableProjectConfig: false,
			});
			const rootIso = await readFixtureStatus(stallManager, "iso");
			const rootShared = await readFixtureStatus(stallManager, "shared");
			const siblingScope = await stallManager.createAgentScope();
			if (!(siblingScope instanceof MCPAgentScope)) {
				throw new Error("expected an owner-bound MCPAgentScope");
			}
			sibling = siblingScope;
			const siblingIso = await callFixtureStatus(sibling.getTools(), "iso");

			const controller = new AbortController();
			const pending = stallManager.createAgentScope(controller.signal);
			const spawned = await waitForIsolationSpawn(stallAudit, 4);
			const stalledPid = spawned[3];
			if (stalledPid === undefined) throw new Error("stalled acquisition never spawned");
			expect(livePids(await readIsolationAudit(stallAudit))).toContain(stalledPid);

			controller.abort();
			let failure: unknown;
			try {
				await pending;
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error("stalled acquisition did not reject");
			expect(failure.name).toBe("AbortError");

			// The pending handshake's process exits promptly and no scope handle is leaked.
			await waitForIsolationExit(stallAudit, stalledPid, 10_000);
			const live = livePids(await readIsolationAudit(stallAudit));
			expect(live).not.toContain(stalledPid);
			expect(live).toContain(siblingIso.pid);
			expect(live).toContain(rootIso.pid);
			expect(live).toContain(rootShared.pid);
			expect((await callFixtureStatus(sibling.getTools(), "iso")).pid).toBe(siblingIso.pid);

			// A later acquisition is independent and gets a fresh private process.
			const freshScope = await stallManager.createAgentScope();
			if (!(freshScope instanceof MCPAgentScope)) {
				throw new Error("expected an owner-bound MCPAgentScope");
			}
			fresh = freshScope;
			const freshIso = await callFixtureStatus(fresh.getTools(), "iso");
			expect(freshIso.pid).not.toBe(siblingIso.pid);
			expect(freshIso.pid).not.toBe(stalledPid);
		} finally {
			await sibling?.disposeAgentScope().catch(() => {});
			await fresh?.disposeAgentScope().catch(() => {});
			await stallManager.disconnectAll();
		}
	}, 30_000);

	it("waits for a slow private startup and publishes its tools before resolving", async () => {
		await connect({ handshakeDelayMs: 1_200 });
		const rootIso = await readFixtureStatus(manager, "iso");
		const scope = await manager.createAgentScope();
		if (!(scope instanceof MCPAgentScope)) throw new Error("expected an owner-bound MCPAgentScope");
		scopes.push(scope);

		// Strict acquisition waits for the full private handshake, not the root's fast window.
		expect(scope.getConnectedServers()).toContain("shared");
		expect(scope.getTools().some(tool => tool.mcpServerName === "iso")).toBe(true);
		const scopeIso = await callFixtureStatus(scope.getTools(), "iso");
		expect(scopeIso.pid).not.toBe(rootIso.pid);
	}, 30_000);

	it("reconciles a live scope with fresh private instances after a root reload", async () => {
		await connect();
		const scope = await acquire();
		const before = await readFixtureStatus(scope, "iso");
		await manager.disconnectAll();
		await waitForIsolationExit(auditPath, before.pid);

		await manager.connectServers(configs, {}, undefined, 0);
		await manager.waitForStartup(0);
		let after: { pid: number } | undefined;
		await waitForAsync(async () => {
			try {
				const status = await callFixtureStatus(scope.getTools(), "iso");
				after = status;
				return after.pid !== before.pid;
			} catch {
				return false;
			}
		});
		if (!after) throw new Error("scope never reconciled its isolated instance");
		const rootIso = await readFixtureStatus(manager, "iso");
		expect(after.pid).not.toBe(rootIso.pid);
	}, 40_000);
});
