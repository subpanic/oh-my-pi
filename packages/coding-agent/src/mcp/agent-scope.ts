/**
 * Owner-bound MCP view for one live agent session.
 *
 * A scope merges its canonical root manager's shared servers with private
 * {@link MCPManager} instances for the servers opted into per-agent isolation.
 * The private manager owns its own transports and processes; it is never
 * installed as the process-global manager and never uses a persistent tool
 * cache. With no opted-in definitions a scope creates no connections at all
 * and delegates every route to the root, so default behavior stays shared —
 * while the view remains subscribed so a later root opt-in can be reconciled
 * into it instead of silently lending the root's isolated instance.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import { logger } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import type { MCPAuthHandler, MCPManager, MCPManagerApi, MCPToolScope } from "./manager";
import type {
	MCPServerConfig,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
} from "./types";

/** One server definition a scope starts privately. */
export interface MCPAgentIsolationDefinition {
	readonly config: MCPServerConfig;
	readonly source: SourceMeta | undefined;
}

/** A freshly started private manager plus the servers whose startup failed. */
export interface MCPAgentPrivateStartup {
	readonly manager: MCPManager;
	readonly errors: Map<string, string>;
}

/** Raised when an opted-in server cannot be started for a new scope. */
export class MCPAgentScopeStartupError extends Error {
	readonly failures: ReadonlyArray<{ readonly serverName: string; readonly error: string }>;

	constructor(failures: ReadonlyMap<string, string>) {
		const details = [...failures].map(([serverName, error]) => `${serverName}: ${error}`).join("; ");
		super(`MCP agent isolation failed to start: ${details}`);
		this.name = "MCPAgentScopeStartupError";
		this.failures = [...failures].map(([serverName, error]) => ({ serverName, error }));
	}
}

type MCPNotificationListener = (serverName: string, method: string, params: unknown) => void;

/** Bounded buffer for notifications received before a scope's first listener attaches. */
const AGENT_SCOPE_NOTIFICATION_CAP = 100;

function sameTools(
	left: readonly CustomTool<TSchema, MCPToolDetails>[],
	right: readonly CustomTool<TSchema, MCPToolDetails>[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sortTools(tools: CustomTool<TSchema, MCPToolDetails>[]): CustomTool<TSchema, MCPToolDetails>[] {
	tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return tools;
}

export class MCPAgentScope implements MCPManagerApi {
	readonly #root: MCPManager;
	/** Servers whose root instances this view hides in favor of private ones. */
	#isolation: Set<string>;
	/** Isolated servers the current private manager is meant to serve. */
	#privateNames = new Set<string>();
	#private: MCPManager | null = null;
	/** A private manager whose handshake is still inside the startup window. */
	#pendingPrivate: MCPManager | null = null;
	#privateDefinitions = new Map<string, MCPAgentIsolationDefinition>();
	#privateToolsUnsubscribe: (() => void) | undefined;
	#privateNotificationsUnsubscribe: (() => void) | undefined;
	readonly #rootToolsUnsubscribe: () => void;
	readonly #rootNotificationsUnsubscribe: () => void;
	#toolsChangedListeners = new Set<() => void>();
	#notificationListeners = new Set<MCPNotificationListener>();
	#pendingNotifications: Array<{ server: string; method: string; params: unknown }> = [];
	#toolScopes = new Map<MCPToolScope, MCPToolScope | undefined>();
	#rootToolsSnapshot: CustomTool<TSchema, MCPToolDetails>[] = [];
	#privateToolsSnapshot: CustomTool<TSchema, MCPToolDetails>[] = [];
	/** Scope-owned monotonic revision added to the root's; private changes never bump the root's. */
	#scopeRevision = 0;
	/** Revision of the last applied isolation set; a stale queued reconcile stands down. */
	#isolationRevision = 0;
	/** Revisions accumulated from retired private managers, so replacement never lowers the view version. */
	#retiredPrivateRevision = 0;
	#syncTail: Promise<void> = Promise.resolve();
	/** Bumped by reset/disposal so a queued or running reconcile stops before starting new work. */
	#reconcileEpoch = 0;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(root: MCPManager, isolated: ReadonlySet<string>, isolationRevision = 0) {
		this.#root = root;
		this.#isolation = new Set(isolated);
		this.#isolationRevision = isolationRevision;
		this.#rootToolsUnsubscribe = root.addToolsChangedListener(() => this.#handleUnderlyingToolsChanged());
		// A dedicated fanout: attaching through addNotificationListener would drain the root's
		// startup buffer into this scope instead of the owning session.
		this.#rootNotificationsUnsubscribe = root.subscribeAgentScopeNotifications((serverName, method, params) => {
			if (this.#isolation.has(serverName)) return;
			this.#emitNotification(serverName, method, params);
		});
		this.#rootToolsSnapshot = [...this.#sharedRootTools()];
	}

	get toolViewsRevision(): number {
		return (
			this.#root.toolViewsRevision +
			this.#retiredPrivateRevision +
			(this.#private?.toolViewsRevision ?? 0) +
			this.#scopeRevision
		);
	}

	getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		if (this.#disposed) return [];
		const shared = this.#sharedRootTools(scope);
		const own = this.#privateTools(scope);
		if (own.length === 0) return shared;
		if (shared.length === 0) return own;
		return sortTools([...shared, ...own]);
	}

	openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void {
		if (this.#disposed) return;
		this.#toolScopes.set(scope, seed);
		this.#root.openToolScope(scope, seed);
		this.#private?.openToolScope(scope, seed);
	}

	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void {
		if (this.#disposed) return () => {};
		const releaseRoot = this.#root.trackToolCall(scope, toolCallId);
		const releasePrivate = this.#private?.trackToolCall(scope, toolCallId);
		return () => {
			releaseRoot();
			releasePrivate?.();
		};
	}

	addToolsChangedListener(listener: () => void): () => void {
		if (this.#disposed) return () => {};
		this.#toolsChangedListeners.add(listener);
		return () => {
			this.#toolsChangedListeners.delete(listener);
		};
	}

	addNotificationListener(listener: MCPNotificationListener): () => void {
		if (this.#disposed) return () => {};
		const wasEmpty = this.#notificationListeners.size === 0;
		this.#notificationListeners.add(listener);
		if (wasEmpty && this.#pendingNotifications.length > 0) {
			const pending = this.#pendingNotifications.splice(0);
			for (const frame of pending) {
				try {
					listener(frame.server, frame.method, frame.params);
				} catch (error) {
					logger.debug("MCP agent scope notification listener threw during buffered drain", {
						serverName: frame.server,
						method: frame.method,
						error,
					});
				}
			}
		}
		return () => {
			this.#notificationListeners.delete(listener);
		};
	}

	getConnectedServers(): string[] {
		if (this.#disposed) return [];
		const shared = this.#root.getConnectedServers();
		const own = this.#privateConnectedServers();
		if (this.#isolation.size === 0) return shared;
		const filtered = shared.filter(name => !this.#isolation.has(name));
		return own.length === 0 ? filtered : [...filtered, ...own];
	}

	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		if (this.#disposed) return undefined;
		if (this.#isolation.has(name)) {
			if (!this.#privateNames.has(name)) return undefined;
			return this.#private?.getServerResources(name);
		}
		return this.#root.getServerResources(name);
	}

	async ensureServerResources(name: string): Promise<void> {
		if (this.#disposed) return;
		if (this.#isolation.has(name)) {
			if (this.#privateNames.has(name)) await this.#private?.ensureServerResources(name);
			return;
		}
		await this.#root.ensureServerResources(name);
	}

	async waitForPendingConnections(): Promise<void> {
		if (this.#disposed) return;
		await Promise.all([
			this.#root.waitForPendingConnections(),
			this.#private?.waitForPendingConnections() ?? Promise.resolve(),
		]);
	}

	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		if (this.#disposed) return undefined;
		if (this.#isolation.has(name)) {
			if (!this.#privateNames.has(name)) return undefined;
			return this.#private?.readServerResource(name, uri, options);
		}
		return this.#root.readServerResource(name, uri, options);
	}

	getServerInstructions(): Map<string, string> {
		if (this.#disposed) return new Map();
		const instructions = new Map<string, string>();
		for (const [name, text] of this.#root.getServerInstructions()) {
			if (!this.#isolation.has(name)) instructions.set(name, text);
		}
		const privateManager = this.#private;
		if (privateManager) {
			for (const [name, text] of privateManager.getServerInstructions()) {
				if (this.#privateNames.has(name)) instructions.set(name, text);
			}
		}
		return new Map([...instructions].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
	}

	async reconcileBrowserFilter(enabled: boolean): Promise<void> {
		if (this.#disposed) return;
		await this.#root.reconcileBrowserFilter(enabled);
	}

	/** A scope always derives siblings from its canonical root, never from its own private instances. */
	createAgentScope(signal?: AbortSignal): Promise<MCPManagerApi> {
		return this.#root.createAgentScope(signal);
	}

	disposeAgentScope(): Promise<void> {
		const disposing = this.#disposePromise ?? this.#dispose();
		this.#disposePromise = disposing;
		return disposing;
	}

	/**
	 * Close private instances after a root shutdown or reload. The scope stays
	 * live and subscribed so the root's next discovery can reconcile it with a
	 * fresh private manager.
	 */
	reset(): Promise<void> {
		this.#reconcileEpoch++;
		this.#abortPendingPrivate();
		return this.#enqueue(async () => {
			if (this.#disposed) return;
			await this.#closePrivate();
		});
	}

	/** Immediately hide these servers from the shared branch; private instances reconcile separately. */
	retainIsolation(names: ReadonlySet<string>, revision = this.#isolationRevision): void {
		if (this.#disposed || revision < this.#isolationRevision) return;
		this.#isolationRevision = revision;
		this.#isolation = new Set(names);
		this.#privateNames = new Set([...this.#privateNames].filter(name => names.has(name)));
		this.#dropIsolatedPendingNotifications();
		this.#refreshToolsSnapshot();
	}

	/** Start this scope's private subset. `authoritative` is false only in a root-reset gap. */
	start(
		definitions: ReadonlyMap<string, MCPAgentIsolationDefinition>,
		authoritative: boolean,
		signal?: AbortSignal,
		revision = this.#isolationRevision,
	): Promise<void> {
		const epoch = this.#reconcileEpoch;
		return this.#enqueue(async () => {
			if (this.#disposed) return;
			await this.#reconcileLocked(definitions, { strict: true, authoritative, signal, revision, epoch });
		});
	}

	/** Reconcile live definitions after a root connect, disconnect, or reload. */
	reconcile(
		definitions: ReadonlyMap<string, MCPAgentIsolationDefinition>,
		revision = this.#isolationRevision,
	): Promise<void> {
		const epoch = this.#reconcileEpoch;
		return this.#enqueue(async () => {
			if (this.#disposed) return;
			await this.#reconcileLocked(definitions, { strict: false, authoritative: true, revision, epoch });
		});
	}

	setNotificationsEnabled(enabled: boolean): void {
		this.#private?.setNotificationsEnabled(enabled);
	}

	setAuthStorage(authStorage: AuthStorage): void {
		this.#private?.setAuthStorage(authStorage);
	}

	setAuthHandler(handler: MCPAuthHandler | undefined): void {
		this.#private?.setAuthHandler(handler);
	}

	async #dispose(): Promise<void> {
		this.#disposed = true;
		this.#reconcileEpoch++;
		// One transition bump: a versioned remote view must see the disposed view's
		// empty tool set instead of a version-only reply over stale cached proxies.
		this.#scopeRevision++;
		this.#root.unregisterAgentScope(this);
		this.#rootToolsUnsubscribe();
		this.#rootNotificationsUnsubscribe();
		this.#toolsChangedListeners.clear();
		this.#notificationListeners.clear();
		this.#pendingNotifications.length = 0;
		// Abort a handshake still inside its startup window instead of waiting for
		// its request timeout; the queued reconcile then finds a closed manager.
		this.#abortPendingPrivate();
		await this.#syncTail.catch(() => undefined);
		await this.#closePrivate();
	}

	/** Abort a private start that is still inside its startup window. */
	abortPendingPrivate(): void {
		this.#abortPendingPrivate();
	}

	#abortPendingPrivate(): void {
		const pending = this.#pendingPrivate;
		this.#pendingPrivate = null;
		if (pending) void pending.disconnectAll().catch(() => undefined);
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.#syncTail.then(task);
		this.#syncTail = run.catch(() => undefined);
		return run;
	}

	/** Whether reset/disposal or a newer isolation publish superseded this reconcile. */
	#reconcileStale(options: { revision?: number; epoch: number }): boolean {
		if (this.#disposed || options.epoch !== this.#reconcileEpoch) return true;
		return options.revision !== undefined && options.revision < this.#isolationRevision;
	}

	async #reconcileLocked(
		definitions: ReadonlyMap<string, MCPAgentIsolationDefinition>,
		options: { strict: boolean; authoritative: boolean; signal?: AbortSignal; revision?: number; epoch: number },
	): Promise<void> {
		if (this.#reconcileStale(options)) return;
		if (options.revision !== undefined) this.#isolationRevision = options.revision;
		if (options.authoritative) this.#isolation = new Set(definitions.keys());
		this.#privateNames = options.authoritative
			? new Set(definitions.keys())
			: new Set([...this.#privateNames].filter(name => this.#isolation.has(name)));
		this.#dropIsolatedPendingNotifications();
		// Hide isolated root instances before any handshake: no shared fallback while private startup is pending.
		this.#refreshToolsSnapshot();
		if (this.#reconcileStale(options)) return;

		if (definitions.size === 0) {
			await this.#closePrivate();
			return;
		}

		const manager = this.#private;
		if (!manager) {
			let startup: MCPAgentPrivateStartup | undefined;
			try {
				startup = await this.#root.createPrivateManager(
					definitions,
					created => {
						this.#pendingPrivate = created;
					},
					options.signal,
					// An acquisition must know whether its private subset actually
					// started, not merely whether it outlived the root's fast window.
					options.strict ? { waitForStartup: true, startupTimeoutMs: 0 } : undefined,
				);
			} catch (error) {
				if (options.strict) throw error;
				logger.error("MCP agent scope private startup failed", { error });
				return;
			} finally {
				this.#pendingPrivate = null;
			}
			if (!startup) return;
			if (options.signal?.aborted || this.#reconcileStale(options)) {
				await startup.manager.disconnectAll();
				return;
			}
			if (startup.errors.size > 0) {
				if (options.strict) {
					await startup.manager.disconnectAll();
					throw new MCPAgentScopeStartupError(startup.errors);
				}
				logger.error("MCP agent scope private servers failed to start", {
					failures: [...startup.errors.keys()],
				});
			}
			this.#private = startup.manager;
			// Failed names stay hidden from the shared branch but are retried by the
			// next reconcile; working private servers stay live.
			this.#privateDefinitions = new Map(definitions);
			for (const name of startup.errors.keys()) this.#privateDefinitions.delete(name);
			this.#attachPrivate(startup.manager);
			this.#refreshToolsSnapshot();
			return;
		}

		const previous = this.#privateDefinitions;
		const removed: string[] = [];
		const added: Array<[string, MCPAgentIsolationDefinition]> = [];
		for (const name of previous.keys()) {
			if (!definitions.has(name)) removed.push(name);
		}
		for (const [name, definition] of definitions) {
			const old = previous.get(name);
			if (!old || old.config !== definition.config) {
				if (old) removed.push(name);
				added.push([name, definition]);
			}
		}

		// Track the manager across the replacement teardown too: a disposal or root
		// reset during `disconnectServer` must cancel the replacement startup, not
		// wait for a fresh (possibly stalled) handshake.
		this.#pendingPrivate = manager;
		let failed: Set<string> | undefined;
		try {
			if (removed.length > 0) {
				await Promise.allSettled(
					removed.map(async name => {
						try {
							await manager.disconnectServer(name);
						} catch (error) {
							logger.debug("MCP agent scope failed to disconnect private server", {
								serverName: name,
								error,
							});
						} finally {
							// A stale reconcile may stop here; the next one must re-add this
							// name if the newer definitions still contain it.
							this.#privateDefinitions.delete(name);
						}
					}),
				);
			}
			if (this.#reconcileStale(options)) return;
			if (added.length > 0) {
				const configs: Record<string, MCPServerConfig> = {};
				const sources: Record<string, SourceMeta> = {};
				for (const [name, definition] of added) {
					configs[name] = definition.config;
					if (definition.source) sources[name] = definition.source;
				}
				try {
					const result = await manager.connectServers(
						configs,
						sources,
						undefined,
						this.#root.agentStartupTimeoutMs,
					);
					if (result.errors.size > 0) {
						failed = new Set(result.errors.keys());
						logger.error("MCP agent scope private servers failed to start", {
							failures: [...failed],
						});
					}
				} catch (error) {
					failed = new Set(added.map(([name]) => name));
					logger.error("MCP agent scope private connect failed", { error });
				}
				if (this.#reconcileStale(options)) {
					// These starts may already be live; record their definitions so a newer
					// config still diffs as a replacement instead of being skipped.
					for (const [name, definition] of added) {
						if (!failed?.has(name)) this.#privateDefinitions.set(name, definition);
					}
					return;
				}
			}
			this.#privateDefinitions = new Map(definitions);
			for (const name of failed ?? []) this.#privateDefinitions.delete(name);
			this.#refreshToolsSnapshot();
		} finally {
			if (this.#pendingPrivate === manager) this.#pendingPrivate = null;
		}
	}

	async #closePrivate(): Promise<void> {
		const manager = this.#private;
		const revisionBefore = manager?.toolViewsRevision ?? 0;
		if (manager) this.#retiredPrivateRevision += revisionBefore;
		this.#private = null;
		this.#privateDefinitions.clear();
		this.#privateNames.clear();
		this.#privateToolsUnsubscribe?.();
		this.#privateToolsUnsubscribe = undefined;
		this.#privateNotificationsUnsubscribe?.();
		this.#privateNotificationsUnsubscribe = undefined;
		if (manager) {
			await manager.disconnectAll();
			// Teardown may itself have changed the private view; keep the retired
			// sum monotonic so a version reader never sees it go backwards.
			this.#retiredPrivateRevision += Math.max(0, manager.toolViewsRevision - revisionBefore);
		}
		if (!this.#disposed) this.#refreshToolsSnapshot();
	}

	#attachPrivate(manager: MCPManager): void {
		this.#privateToolsUnsubscribe = manager.addToolsChangedListener(() => this.#handleUnderlyingToolsChanged());
		this.#privateNotificationsUnsubscribe = manager.addNotificationListener((serverName, method, params) => {
			this.#emitNotification(serverName, method, params);
		});
		for (const [scope, seed] of this.#toolScopes) manager.openToolScope(scope, seed);
	}

	#sharedRootTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		const tools = this.#root.getTools(scope);
		if (this.#isolation.size === 0) return tools;
		return tools.filter(tool => !this.#isolation.has(tool.mcpServerName ?? ""));
	}

	#privateTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		const manager = this.#private;
		if (!manager || this.#privateNames.size === 0) return [];
		return manager.getTools(scope).filter(tool => this.#privateNames.has(tool.mcpServerName ?? ""));
	}

	#privateConnectedServers(): string[] {
		const manager = this.#private;
		if (!manager || this.#privateNames.size === 0) return [];
		return manager.getConnectedServers().filter(name => this.#privateNames.has(name));
	}

	#refreshToolsSnapshot(notify = true): void {
		if (this.#disposed) return;
		const rootTools = [...this.#sharedRootTools()];
		const privateTools = [...this.#privateTools()];
		const changed =
			!sameTools(rootTools, this.#rootToolsSnapshot) || !sameTools(privateTools, this.#privateToolsSnapshot);
		this.#rootToolsSnapshot = rootTools;
		this.#privateToolsSnapshot = privateTools;
		if (!changed) return;
		this.#scopeRevision++;
		if (notify) this.#notifyToolsChanged();
	}

	/**
	 * A change in either backing manager may affect a scoped view even when the
	 * owner view is byte-identical (a tool granted to one session's call). Notify
	 * unconditionally so followers re-mint that session's proxies.
	 */
	#handleUnderlyingToolsChanged(): void {
		if (this.#disposed) return;
		this.#refreshToolsSnapshot(false);
		this.#scopeRevision++;
		this.#notifyToolsChanged();
	}

	#notifyToolsChanged(): void {
		for (const listener of this.#toolsChangedListeners) {
			try {
				listener();
			} catch (error) {
				logger.debug("MCP agent scope tools listener threw", { error });
			}
		}
	}

	#emitNotification(serverName: string, method: string, params: unknown): void {
		if (this.#disposed) return;
		if (this.#notificationListeners.size === 0) {
			this.#pendingNotifications.push({ server: serverName, method, params });
			if (this.#pendingNotifications.length > AGENT_SCOPE_NOTIFICATION_CAP) this.#pendingNotifications.shift();
			return;
		}
		for (const listener of this.#notificationListeners) {
			try {
				listener(serverName, method, params);
			} catch (error) {
				logger.debug("MCP agent scope notification listener threw", { serverName, method, error });
			}
		}
	}

	#dropIsolatedPendingNotifications(): void {
		if (this.#isolation.size === 0 || this.#pendingNotifications.length === 0) return;
		this.#pendingNotifications = this.#pendingNotifications.filter(frame => !this.#isolation.has(frame.server));
	}
}
