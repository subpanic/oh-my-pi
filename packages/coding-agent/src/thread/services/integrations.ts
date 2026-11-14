/**
 * Integrations bridged into subagent worker threads.
 *
 * - **MCP** (`"mcp-manager"`): a main `MCPManager` crosses by reference; the worker gets a
 *   {@link RemoteMCPManager}. Tools come back as plain views ({@link toWorkerCustomTool}), re-sent
 *   only when main's tool views changed since the worker's last read for that view, whose
 *   `execute` runs the main-side MCP tool (streaming `onUpdate` and abort signals cross), tool and
 *   notification subscriptions are held on main per worker and dropped when it exits, and the
 *   worker's `MCPManager.instance()/load()/available()` answer from main's process global. A worker
 *   never connects MCP servers itself (`createAgentSession` skips discovery off the main thread).
 *   Owner-bound agent scopes cross as their own kind (`"mcp-agent-scope"`); each acquisition is
 *   tracked per worker and closed when it exits. A worker exit also aborts acquisitions that are
 *   still starting (a stalled handshake cannot outlive its owner), and one that resolves after the
 *   worker is gone is closed instead of retained.
 * - **Tool contexts** (`"custom-tool-context"`, see `./tool-context`): main-thread tools called from a
 *   worker child receive a snapshot context instead of the worker's live objects.
 * - **`LocalProtocolOptions`** (`"local-protocol-options"`): a main-side options object reaches a
 *   worker with synchronous getters (`rpcSync`), since `resolveLocalRoot` reads them synchronously;
 *   a worker-side one reaches main as a snapshot of its current values.
 * - **Prepared extensions** (`"prepared-extension"`): a `PreparedExtension` crosses as its module
 *   path; the receiver re-imports the module on first bind, so the factory runs in the receiving
 *   thread against that thread's `ExtensionAPI`. Model providers such factories register in a
 *   worker are dropped by the worker's model-registry mirror: the parent bound the same prepared
 *   extensions to main's registry, which the mirror follows (see `./auth`).
 *
 * Main-side values that are plain functions (no type to match a codec on) are converted by
 * {@link bridgeIntegrationOptions} before an `ExecutorOptions` object crosses a link.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { importExtensionModule } from "../../extensibility/extensions/loader";
import type { ExtensionFactory, PreparedExtension } from "../../extensibility/extensions/types";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import {
	MCPAgentScope,
	MCPManager,
	type MCPManagerApi,
	type MCPManagerGlobal,
	type MCPToolScope,
} from "../../mcp/manager";
import type { ExecutorOptions } from "../../task/executor";
import { isMainThread } from "../identity";
import type { MainThreadLink, WorkerThreadLink } from "../protocol";
import { type RpcCodec, type RpcServe, rpcSync } from "../rpc";
import { trackWorkerSubscription } from "./support";
import type { ThreadService, WorkerPeer } from "../services";
import {
	MCP_AGENT_SCOPE_KIND,
	MCP_MANAGER_KIND,
	type McpManagerProtocol,
	type McpToolsReply,
	RemoteMCPManager,
} from "./mcp-remote";
import { toWorkerTelemetryConfig } from "./telemetry";
import { toolContextCodec } from "./tool-context";

/** Codec kind of `LocalProtocolOptions`. */
export const LOCAL_PROTOCOL_OPTIONS_KIND = "local-protocol-options";
/** Codec kind of `PreparedExtension`. */
export const PREPARED_EXTENSION_KIND = "prepared-extension";

/** Boot globals of {@link integrationsThreadService}. */
export interface IntegrationsThreadGlobals {
	/** Main's process-global MCP manager accessors; `instance`/`available` are synchronous for the worker. */
	readonly mcp: MCPManagerGlobal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom tool views
// ─────────────────────────────────────────────────────────────────────────────

/** On a tool: its cached cross-thread view. */
const kWorkerToolView = Symbol("thread.integrations.toolView");
/** On a view: the tool it was built from. */
const kViewSource = Symbol("thread.integrations.viewSource");

function isViewOf<TParams extends TSchema, TDetails>(
	tool: CustomTool<TParams, TDetails>,
	value: unknown,
): value is CustomTool<TParams, TDetails> {
	return typeof value === "object" && value !== null && Reflect.get(value, kViewSource) === tool;
}

/**
 * Main side: the cross-thread form of a custom tool — its data fields plus `execute`/`onSession`
 * running on this thread, with the synchronous approval hooks marked {@link rpcSync}. Render and
 * describe hooks are dropped: only the main-thread UI renders tool calls. Cached on the tool, so
 * repeated sends export the same functions. `parameters` must be structured-clone data (JSON
 * schema); TypeBox symbol metadata does not cross.
 */
export function toWorkerCustomTool<TParams extends TSchema, TDetails>(
	tool: CustomTool<TParams, TDetails>,
): CustomTool<TParams, TDetails> {
	const cached: unknown = Reflect.get(tool, kWorkerToolView);
	if (isViewOf(tool, cached)) return cached;
	const view: CustomTool<TParams, TDetails> = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (toolCallId, params, onUpdate, ctx, signal) => tool.execute(toolCallId, params, onUpdate, ctx, signal),
	};
	if (tool.strict !== undefined) view.strict = tool.strict;
	if (tool.hidden !== undefined) view.hidden = tool.hidden;
	if (tool.loadMode !== undefined) view.loadMode = tool.loadMode;
	if (tool.deferrable !== undefined) view.deferrable = tool.deferrable;
	if (tool.readsSkillUris !== undefined) view.readsSkillUris = tool.readsSkillUris;
	if (tool.mcpServerName !== undefined) view.mcpServerName = tool.mcpServerName;
	if (tool.mcpToolName !== undefined) view.mcpToolName = tool.mcpToolName;
	if (tool.mcpReadOnlyHint !== undefined) view.mcpReadOnlyHint = tool.mcpReadOnlyHint;
	if (tool.legacyName !== undefined) view.legacyName = tool.legacyName;
	if (tool.approval !== undefined) view.approval = tool.approval;
	const onSession = tool.onSession;
	if (onSession) view.onSession = (event, ctx) => onSession.call(tool, event, ctx);
	const cacheTargets = tool.approvalCacheTargets;
	if (cacheTargets) view.approvalCacheTargets = rpcSync((args: unknown) => cacheTargets.call(tool, args));
	const approvalDetails = tool.formatApprovalDetails;
	if (approvalDetails) view.formatApprovalDetails = rpcSync((args: unknown) => approvalDetails.call(tool, args));
	// Non-enumerable and symbol-keyed: neither the link's walker nor structured clone sends it.
	Object.defineProperty(view, kViewSource, { value: tool });
	// A frozen tool rejects the cache; its views are then rebuilt per send.
	Reflect.set(tool, kWorkerToolView, view);
	return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main side: convert the integration fields of `options` that cannot cross as-is into forms that
 * behave identically in a worker. Call once on the options a main-thread caller hands to a
 * worker-hosted `runSubprocess`; returns a shallow copy (other fields are untouched).
 *
 * - `extensionRoots`, `preparedSession.promptSuffix`: called synchronously by the child → `rpcSync`.
 * - `customTools`: {@link toWorkerCustomTool} views.
 * - `parentTelemetry`: `toWorkerTelemetryConfig` (captures the active span as the child's parent, so
 *   call this inside the parent's `execute_tool task` context).
 *
 * Everything else in this module's scope crosses automatically through codecs and exported
 * classes (`mcpManager` roots and owner-bound agent scopes, `localProtocolOptions`,
 * `preloadedPreparedExtensions`, tool contexts); `perCallModelGrants` crosses intact (its
 * `settings` becomes the worker's live mirror).
 */
export function bridgeIntegrationOptions(options: ExecutorOptions): ExecutorOptions {
	const bridged: ExecutorOptions = { ...options };
	const extensionRoots = options.extensionRoots;
	if (extensionRoots) bridged.extensionRoots = rpcSync(() => extensionRoots());
	const seance = options.preparedSession;
	if (seance) {
		const promptSuffix = seance.promptSuffix;
		bridged.preparedSession = {
			fork: seance.fork,
			promptSuffix: rpcSync((resolvedModel?: string) => promptSuffix(resolvedModel)),
		};
	}
	if (options.customTools) bridged.customTools = options.customTools.map(tool => toWorkerCustomTool(tool));
	if (options.parentTelemetry) bridged.parentTelemetry = toWorkerTelemetryConfig(options.parentTelemetry);
	return bridged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local protocol options
// ─────────────────────────────────────────────────────────────────────────────

type WireLocalProtocolOptions =
	| { readonly mode: "live"; readonly artifactsDir?: () => string | null; readonly sessionId?: () => string | null }
	| { readonly mode: "snapshot"; readonly artifactsDir: string | null; readonly sessionId: string | null };

function isLocalProtocolOptions(value: unknown): value is LocalProtocolOptions {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
	let getters = 0;
	for (const key in value) {
		if (key !== "getArtifactsDir" && key !== "getSessionId") return false;
		const getter: unknown = Reflect.get(value, key);
		if (getter === undefined) continue;
		if (typeof getter !== "function") return false;
		getters++;
	}
	return getters > 0;
}

function encodeLocalProtocolOptions(options: LocalProtocolOptions): WireLocalProtocolOptions {
	const { getArtifactsDir, getSessionId } = options;
	if (isMainThread()) {
		return {
			mode: "live",
			artifactsDir: getArtifactsDir && rpcSync(() => getArtifactsDir()),
			sessionId: getSessionId && rpcSync(() => getSessionId()),
		};
	}
	// Main never blocks on a worker, so it gets the values current at send time.
	return { mode: "snapshot", artifactsDir: getArtifactsDir?.() ?? null, sessionId: getSessionId?.() ?? null };
}

function optionalGetter(value: unknown): (() => string | null) | undefined {
	if (typeof value !== "function") return undefined;
	return () => {
		const result: unknown = value();
		return typeof result === "string" ? result : null;
	};
}

function decodeLocalProtocolOptions(data: unknown): LocalProtocolOptions {
	if (typeof data !== "object" || data === null) throw new Error("local-protocol-options: malformed wire value");
	const artifactsDir: unknown = Reflect.get(data, "artifactsDir");
	const sessionId: unknown = Reflect.get(data, "sessionId");
	if (Reflect.get(data, "mode") === "live") {
		return { getArtifactsDir: optionalGetter(artifactsDir), getSessionId: optionalGetter(sessionId) };
	}
	const dir = typeof artifactsDir === "string" ? artifactsDir : null;
	const id = typeof sessionId === "string" ? sessionId : null;
	return { getArtifactsDir: () => dir, getSessionId: () => id };
}

const localProtocolOptionsCodec: RpcCodec<LocalProtocolOptions> = {
	kind: LOCAL_PROTOCOL_OPTIONS_KIND,
	is: isLocalProtocolOptions,
	encode: encodeLocalProtocolOptions,
	decode: decodeLocalProtocolOptions,
};

// ─────────────────────────────────────────────────────────────────────────────
// Prepared extensions
// ─────────────────────────────────────────────────────────────────────────────

interface WirePreparedExtension {
	readonly path: string;
	readonly resolvedPath: string;
	readonly error: string | null;
	readonly loadable: boolean;
}

/** This thread's import of each extension module, by resolved path. */
const extensionImports = new Map<string, Promise<PreparedExtension>>();

function isPreparedExtension(value: unknown): value is PreparedExtension {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const factory: unknown = Reflect.get(value, "factory");
	const error: unknown = Reflect.get(value, "error");
	return (
		typeof Reflect.get(value, "path") === "string" &&
		typeof Reflect.get(value, "resolvedPath") === "string" &&
		(factory === null || typeof factory === "function") &&
		(error === null || typeof error === "string")
	);
}

/** A factory that imports `resolvedPath` in the calling thread on first use and runs its export. */
function threadLocalFactory(resolvedPath: string): ExtensionFactory {
	return async api => {
		let pending = extensionImports.get(resolvedPath);
		if (!pending) {
			pending = importExtensionModule(resolvedPath, resolvedPath);
			extensionImports.set(resolvedPath, pending);
		}
		const prepared = await pending;
		if (!prepared.factory) throw new Error(prepared.error ?? `Extension ${resolvedPath} exports no factory`);
		await prepared.factory(api);
	};
}

function isWirePreparedExtension(value: unknown): value is WirePreparedExtension {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "path") === "string" &&
		typeof Reflect.get(value, "resolvedPath") === "string" &&
		typeof Reflect.get(value, "loadable") === "boolean"
	);
}

const preparedExtensionCodec: RpcCodec<PreparedExtension> = {
	kind: PREPARED_EXTENSION_KIND,
	is: isPreparedExtension,
	encode: prepared => ({
		path: prepared.path,
		resolvedPath: prepared.resolvedPath,
		error: prepared.error,
		loadable: prepared.factory !== null,
	}),
	decode: data => {
		if (!isWirePreparedExtension(data)) throw new Error("prepared-extension: malformed wire value");
		return {
			path: data.path,
			resolvedPath: data.resolvedPath,
			error: data.error,
			factory: data.loadable ? threadLocalFactory(data.resolvedPath) : null,
		};
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// MCP manager (main side)
// ─────────────────────────────────────────────────────────────────────────────

/** Main-side subscriptions and owned scopes one worker holds, dropped when it exits. */
class PeerIntegrationState {
	readonly subscriptions = new Set<() => void>();
	/** Scopes acquired through this worker's link; each acquisition is a distinct, independently owned handle. */
	readonly #scopes = new Set<MCPAgentScope>();
	/**
	 * Aborted when this worker exits: cancels acquisitions still starting there, so a stalled
	 * handshake cannot leave a private process owned by a dead worker.
	 */
	readonly #acquisitionAbort = new AbortController();
	/** Set once the worker exited: anything acquired afterwards is closed instead of retained. */
	#released = false;

	/** Signal to combine with a caller's acquisition signal; aborting cancels startup and rejects. */
	get acquisitionSignal(): AbortSignal {
		return this.#acquisitionAbort.signal;
	}

	/** Take ownership of a scope acquired for this worker; a late acquisition is closed immediately. */
	own(scope: MCPAgentScope): void {
		if (this.#released) {
			this.#close(scope);
			return;
		}
		this.#scopes.add(scope);
	}

	/** The caller disposed `scope`; stop closing it again when this worker exits. */
	forget(scope: MCPManagerApi): void {
		if (scope instanceof MCPAgentScope) this.#scopes.delete(scope);
	}

	release(): void {
		this.#released = true;
		// Cancel acquisitions whose private startup is still in flight; the late-result guard below
		// only covers a resolver that raced the abort.
		this.#acquisitionAbort.abort(new Error("MCP worker exited during scope acquisition"));
		// Each unsubscribe deletes its own (already visited) entry, which Set iteration tolerates.
		for (const unsubscribe of this.subscriptions) {
			try {
				unsubscribe();
			} catch (error) {
				logger.debug("Worker MCP unsubscribe failed", { error: String(error) });
			}
		}
		for (const scope of this.#scopes) this.#close(scope);
		this.#scopes.clear();
	}

	/** Close one scope's private instances and listeners off the caller's path; idempotent and root-safe. */
	#close(scope: MCPAgentScope): void {
		this.#scopes.delete(scope);
		try {
			scope
				.disposeAgentScope()
				.catch((error: unknown) => logger.debug("Worker MCP scope disposal failed", { error: String(error) }));
		} catch (error) {
			// One scope must not keep the worker's remaining handles open.
			logger.debug("Worker MCP scope disposal failed", { error: String(error) });
		}
	}
}

const kPeerIntegrations = Symbol("thread.integrations.peer");

function peerState(link: MainThreadLink): PeerIntegrationState {
	const existing: unknown = Reflect.get(link, kPeerIntegrations);
	if (existing instanceof PeerIntegrationState) return existing;
	const state = new PeerIntegrationState();
	Reflect.set(link, kPeerIntegrations, state);
	return state;
}

/** Swallow a rejection from a worker callback (its link may be closing). */
function settleQuietly(result: unknown): void {
	if (result instanceof Promise) {
		result.catch((error: unknown) => logger.debug("Worker MCP listener failed", { error: String(error) }));
	}
}

/** `scope`'s tools as worker views, omitted when `knownVersion` is still current. */
function toolsReply(manager: MCPManagerApi, knownVersion: number, scope: MCPToolScope | undefined): McpToolsReply {
	const version = manager.toolViewsRevision;
	if (version === knownVersion) return { version };
	return { version, tools: manager.getTools(scope).map(tool => toWorkerCustomTool(tool)) };
}

function serveMcpManager(state: PeerIntegrationState): RpcServe<MCPManagerApi, McpManagerProtocol> {
	return {
		toolViewsRevision: manager => manager.toolViewsRevision,
		createAgentScope: async (manager, signal) => {
			// A worker that dies mid-startup aborts its pending acquisition instead of leaving a
			// private handshake (possibly `timeout: 0`) alive with no future owner.
			const scope = await manager.createAgentScope(
				signal ? AbortSignal.any([state.acquisitionSignal, signal]) : state.acquisitionSignal,
			);
			// Every acquisition is a new owner-bound handle, including the zero-private subset case.
			if (scope instanceof MCPAgentScope) state.own(scope);
			return scope;
		},
		disposeAgentScope: async manager => {
			state.forget(manager);
			await manager.disposeAgentScope();
		},
		tools: (manager, knownVersion, scope) => toolsReply(manager, knownVersion, scope),
		openToolScope: (manager, scope, seed) => manager.openToolScope(scope, seed),
		trackToolCall: (manager, scope, toolCallId) =>
			trackWorkerSubscription(state.subscriptions, manager.trackToolCall(scope, toolCallId)),
		onToolsChanged: (manager, listener) =>
			trackWorkerSubscription(
				state.subscriptions,
				manager.addToolsChangedListener(() => settleQuietly(listener())),
			),
		onNotification: (manager, listener) =>
			trackWorkerSubscription(
				state.subscriptions,
				manager.addNotificationListener((serverName, method, params) =>
					settleQuietly(listener(serverName, method, params)),
				),
			),
		connectedServers: manager => manager.getConnectedServers(),
		serverResources: (manager, name) => manager.getServerResources(name),
		ensureServerResources: (manager, name) => manager.ensureServerResources(name),
		waitForPendingConnections: manager => manager.waitForPendingConnections(),
		readServerResource: (manager, name, uri, options) => manager.readServerResource(name, uri, options),
		serverInstructions: manager => manager.getServerInstructions(),
		reconcileBrowserFilter: (manager, enabled) => manager.reconcileBrowserFilter(enabled),
	};
}

function mainGlobals(): IntegrationsThreadGlobals {
	return {
		mcp: {
			instance: rpcSync(() => MCPManager.instance()),
			load: () => MCPManager.load(),
			available: rpcSync(() => MCPManager.available()),
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker side
// ─────────────────────────────────────────────────────────────────────────────

function remoteManagerOrUndefined(value: unknown): MCPManagerApi | undefined {
	if (value === undefined || value === null) return undefined;
	if (value instanceof RemoteMCPManager) return value;
	throw new Error("integrations: main returned a non-MCP manager value");
}

function isIntegrationsGlobals(value: unknown): value is { mcp: Record<string, unknown> } {
	if (typeof value !== "object" || value === null) return false;
	const mcp: unknown = Reflect.get(value, "mcp");
	return (
		typeof mcp === "object" &&
		mcp !== null &&
		typeof Reflect.get(mcp, "instance") === "function" &&
		typeof Reflect.get(mcp, "load") === "function" &&
		typeof Reflect.get(mcp, "available") === "function"
	);
}

/** Install main's MCP globals as this worker's `MCPManager` accessors. */
function installMcpGlobal(mcp: Record<string, unknown>): void {
	const { instance, load, available } = mcp;
	if (typeof instance !== "function" || typeof load !== "function" || typeof available !== "function") return;
	MCPManager.installGlobal({
		instance: () => remoteManagerOrUndefined(instance()),
		load: async () => remoteManagerOrUndefined(await load()),
		available: () => available() === true,
	});
}

function registerCodecs(link: MainThreadLink | WorkerThreadLink): void {
	link.codec(toolContextCodec);
	link.codec(localProtocolOptionsCodec);
	link.codec(preparedExtensionCodec);
}

/** MCP, tool-context, local-protocol and prepared-extension bridging for subagent workers. */
export const integrationsThreadService: ThreadService = {
	name: "integrations",

	installMain(peer: WorkerPeer): void {
		registerCodecs(peer.link);
		const state = peerState(peer.link);
		// Scope recognition first: owner-bound scopes are never the root singleton, and the
		// registration order is the encoder's precedence if that ever changes.
		peer.link.exportClass<MCPManagerApi, McpManagerProtocol>(
			MCP_AGENT_SCOPE_KIND,
			(value): value is MCPManagerApi => value instanceof MCPAgentScope,
			serveMcpManager(state),
		);
		peer.link.exportClass<MCPManagerApi, McpManagerProtocol>(
			MCP_MANAGER_KIND,
			(value): value is MCPManagerApi => value instanceof MCPManager,
			serveMcpManager(state),
		);
	},

	globals(): IntegrationsThreadGlobals {
		return mainGlobals();
	},

	onWorkerExit(peer: WorkerPeer): void {
		peerState(peer.link).release();
	},

	installWorker(link: WorkerThreadLink): void {
		registerCodecs(link);
		link.importClass<RemoteMCPManager, McpManagerProtocol>(MCP_MANAGER_KIND, remote => new RemoteMCPManager(remote));
		link.importClass<RemoteMCPManager, McpManagerProtocol>(
			MCP_AGENT_SCOPE_KIND,
			remote => new RemoteMCPManager(remote, true),
		);
	},

	boot(globals: unknown): void {
		if (!isIntegrationsGlobals(globals)) throw new Error("integrations service: malformed boot globals");
		installMcpGlobal(globals.mcp);
	},
};
