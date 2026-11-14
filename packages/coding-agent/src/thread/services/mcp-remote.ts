/**
 * Worker side of the MCP manager bridge: {@link RemoteMCPManager} implements
 * {@link MCPManagerApi} over the main thread's manager (remote-object kind
 * {@link MCP_MANAGER_KIND} for the root, {@link MCP_AGENT_SCOPE_KIND} for an
 * owner-bound agent scope). Workers never own MCP connections: every tool
 * call, resource read and change subscription runs on main.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { MCPManagerApi, MCPToolScope } from "../../mcp/manager";
import type { MCPRequestOptions, MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "../../mcp/types";
import type { RemoteObject, RpcMethod } from "../rpc";

/** Remote-object kind of a main-thread `MCPManager`. */
export const MCP_MANAGER_KIND = "mcp-manager";
/** Remote-object kind of a main-thread owner-bound agent scope (`MCPAgentScope`). */
export const MCP_AGENT_SCOPE_KIND = "mcp-agent-scope";

/** Listener for server notification frames. */
export type McpNotificationListener = (serverName: string, method: string, params: unknown) => void;

/** Reply to {@link McpManagerProtocol.tools}. */
export interface McpToolsReply {
	/** Version of the bound manager's effective tool views; it changes whenever that view may have. */
	readonly version: number;
	/** The current tools; omitted when the caller already holds `version`. */
	readonly tools?: CustomTool<TSchema, MCPToolDetails>[];
}

/** Protocol a {@link RemoteMCPManager} speaks to its main-thread manager. */
export type McpManagerProtocol = {
	/** Effective tools revision of this bound manager, for {@link RemoteMCPManager.toolViewsRevision}. */
	toolViewsRevision: RpcMethod<[], number>;
	/**
	 * Acquire a new, independently owned owner-bound scope (no private connections when none is
	 * opted in). Aborting `signal` cancels startup, closes anything it started, and rejects.
	 */
	createAgentScope: RpcMethod<[signal: AbortSignal | undefined], MCPManagerApi>;
	/** Close only the private instances and listeners this bound scope owns; idempotent. */
	disposeAgentScope: RpcMethod<[], void>;
	/** One scope's tools as plain cross-thread views (data + `execute` running on main), unless `knownVersion` is current. */
	tools: RpcMethod<[knownVersion: number, scope: MCPToolScope | undefined], McpToolsReply>;
	openToolScope: RpcMethod<[scope: MCPToolScope, seed: MCPToolScope | undefined], void>;
	/** Attribute a tool call; the returned release is synchronous for the worker. */
	trackToolCall: RpcMethod<[scope: MCPToolScope, toolCallId: string], () => void>;
	/** Subscribe; the returned unsubscribe is synchronous for the worker. */
	onToolsChanged: RpcMethod<[listener: () => void], () => void>;
	onNotification: RpcMethod<[listener: McpNotificationListener], () => void>;
	connectedServers: RpcMethod<[], string[]>;
	serverResources: RpcMethod<
		[name: string],
		{ resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined
	>;
	ensureServerResources: RpcMethod<[name: string], void>;
	waitForPendingConnections: RpcMethod<[], void>;
	readServerResource: RpcMethod<
		[name: string, uri: string, options: MCPRequestOptions | undefined],
		MCPResourceReadResult | undefined
	>;
	serverInstructions: RpcMethod<[], Map<string, string>>;
	reconcileBrowserFilter: RpcMethod<[enabled: boolean], void>;
};

/** Worker-side proxy of one main-thread `MCPManager` or owner-bound `MCPAgentScope`. */
export class RemoteMCPManager implements MCPManagerApi {
	readonly #remote: RemoteObject<McpManagerProtocol>;
	/** Owner-bound scopes become inert for reads once disposed; the root's disposal is a no-op. */
	readonly #ownerBound: boolean;
	/** Set once an owner-bound view was disposed: reads are inert and cached tool views are dropped. */
	#disposed = false;
	/** Each scope's tool views at the version main last sent them; absent before the first fetch. */
	#toolsByScope = new Map<
		MCPToolScope | undefined,
		{ version: number; tools: CustomTool<TSchema, MCPToolDetails>[] }
	>();

	constructor(remote: RemoteObject<McpManagerProtocol>, ownerBound = false) {
		this.#remote = remote;
		this.#ownerBound = ownerBound;
	}

	/** Version of this bound manager's effective tools, read synchronously from main. */
	get toolViewsRevision(): number {
		return this.#remote.callSync("toolViewsRevision");
	}

	/**
	 * Acquire a scope from this bound manager's canonical root. The returned proxy is independently
	 * owned: disposing it leaves this manager and sibling scopes untouched. Aborting `signal` cancels
	 * the acquisition's startup (main's worker-exit signal is combined with it there) and rejects.
	 */
	async createAgentScope(signal?: AbortSignal): Promise<MCPManagerApi> {
		const scope: unknown = await this.#remote.call("createAgentScope", signal);
		if (!(scope instanceof RemoteMCPManager)) {
			throw new Error("mcp bridge: main returned a non-MCP agent scope");
		}
		return scope;
	}

	/**
	 * Close only this scope's private instances and become inert at once. The root manager's
	 * implementation is a no-op and keeps serving shared tools. Sibling acquisition stays available
	 * on a disposed scope: {@link createAgentScope} still delegates through main's canonical root.
	 */
	async disposeAgentScope(): Promise<void> {
		if (this.#ownerBound) {
			// Main's disposed view returns no tools, so a retained version cache must never satisfy a
			// later getTools without asking it; drop the views before the round trip as well.
			this.#disposed = true;
			this.#toolsByScope.clear();
		}
		await this.#remote.call("disposeAgentScope");
	}

	/** `scope`'s current tools; the views cross only when main's tool views changed since this scope's last call. */
	getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		if (this.#disposed) return [];
		const cached = this.#toolsByScope.get(scope);
		const reply = this.#remote.callSync("tools", cached?.version ?? 0, scope);
		if (!reply.tools) return cached?.tools ?? [];
		this.#toolsByScope.set(scope, { version: reply.version, tools: reply.tools });
		return reply.tools;
	}

	openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void {
		this.#remote.callSync("openToolScope", scope, seed);
	}

	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void {
		return this.#remote.callSync("trackToolCall", scope, toolCallId);
	}

	addToolsChangedListener(listener: () => void): () => void {
		return this.#remote.callSync("onToolsChanged", listener);
	}

	addNotificationListener(listener: McpNotificationListener): () => void {
		return this.#remote.callSync("onNotification", listener);
	}

	getConnectedServers(): string[] {
		return this.#remote.callSync("connectedServers");
	}

	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		return this.#remote.callSync("serverResources", name);
	}

	ensureServerResources(name: string): Promise<void> {
		return this.#remote.call("ensureServerResources", name);
	}

	waitForPendingConnections(): Promise<void> {
		return this.#remote.call("waitForPendingConnections");
	}

	readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		return this.#remote.call("readServerResource", name, uri, options);
	}

	getServerInstructions(): Map<string, string> {
		return this.#remote.callSync("serverInstructions");
	}

	reconcileBrowserFilter(enabled: boolean): Promise<void> {
		return this.#remote.call("reconcileBrowserFilter", enabled);
	}
}
