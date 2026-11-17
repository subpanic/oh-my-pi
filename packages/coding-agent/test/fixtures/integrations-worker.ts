import { type MessagePort, parentPort } from "node:worker_threads";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { CustomTool, CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { bindPreparedExtensions } from "../../src/extensibility/extensions/loader";
import type { PreparedExtension } from "../../src/extensibility/extensions/types";
import { type LocalProtocolOptions, resolveLocalRoot } from "../../src/internal-urls/local-protocol";
import { MCPManager, type MCPManagerApi } from "../../src/mcp/manager";
import { SessionManager } from "../../src/session/session-manager";
import { createMCPProxyTools, type ExecutorOptions } from "../../src/task/executor";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { RemoteMCPManager } from "../../src/thread/services/mcp-remote";
import { settingsThreadService } from "../../src/thread/services/settings";

/** Outcome of one tool call made from the worker. */
export interface ToolCallOutcome {
	text: string;
	updates: string[];
	error?: string;
	errorName?: string;
}

/** One worker-held owner-bound scope as the worker reads it. */
export interface WorkerScopeSnapshot {
	servers: string[];
	tools: string[];
	revision: number;
}

/** One server notification as a worker listener receives it. */
export interface WorkerNotification {
	serverName: string;
	method: string;
	params: unknown;
}

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface IntegrationsProbe {
	/** What the worker's `MCPManager` statics report. */
	mcpGlobal(): Promise<{ available: boolean; remote: boolean; servers: string[]; tools: string[] }>;
	/** Acquire an independently owned scope from the worker's bound root and retain it under `handleId`. */
	mcpScopeCreate(handleId: string): Promise<WorkerScopeSnapshot>;
	/** Start acquiring a scope but return before it resolves; the worker retains it under `handleId` when it does. */
	mcpScopeCreateDeferred(handleId: string): Promise<void>;
	/** Acquire a sibling scope from the canonical root through the worker-held `parentHandleId`. */
	mcpScopeNested(parentHandleId: string, handleId: string): Promise<WorkerScopeSnapshot>;
	/** The retained scope's current view; unlike create, does not acquire. */
	mcpScopeSnapshot(handleId: string): Promise<WorkerScopeSnapshot>;
	/** Call an MCP tool through the retained scope's own view, selecting the server explicitly. */
	mcpScopeCall(
		handleId: string,
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<ToolCallOutcome>;
	/** Read an MCP resource through the retained scope and parse its JSON text. */
	mcpScopeReadResource(handleId: string, serverName: string, uri: string): Promise<Record<string, unknown>>;
	/** Server-provided instructions as this scope merges them. */
	mcpScopeInstructions(handleId: string): Promise<Record<string, string>>;
	/** The bound view's effective tool revision. */
	mcpScopeRevision(handleId: string): Promise<number>;
	/** Subscribe the retained scope's listener; notification frames are read with `mcpScopeLastNotification`. */
	mcpScopeWatch(handleId: string): Promise<void>;
	/** The last notification the retained scope's listener saw, or null. */
	mcpScopeLastNotification(handleId: string): Promise<WorkerNotification | null>;
	/** Dispose only the retained scope; its siblings stay live. */
	mcpScopeDispose(handleId: string): Promise<void>;
	/** Dispose the retained scope but keep its proxy addressable for disposed-view assertions. */
	mcpScopeDisposeRetained(handleId: string): Promise<void>;
	/** Each scope's MCP tool names as this worker reads them, in order, through one `RemoteMCPManager`. */
	mcpViews(scopes: string[]): Promise<string[][]>;
	/** Call an MCP tool through `createMCPProxyTools(MCPManager.instance())`, as a child session would. */
	mcpCall(
		registry: ModelRegistry,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ToolCallOutcome>;
	/** Call as `scope`, pausing after attribution until both participating workers have tracked their call. */
	mcpScopedCall(scope: string, toolName: string, toolCallId: string, barrier: Int32Array): Promise<ToolCallOutcome>;
	/** Subscribe to the remote manager's tool changes; the returned promise settles on the first one. */
	watchTools(): Promise<{ changed: Promise<void> }>;
	/** Execute a main-defined custom tool with a worker-side context; optionally abort on its first update. */
	customCall(
		tool: CustomTool,
		registry: ModelRegistry,
		args: Record<string, unknown>,
		abortOnUpdate?: boolean,
	): Promise<ToolCallOutcome & { abortsSeen: number }>;
	/** Read bridged executor options synchronously, as the child does. */
	readOptions(options: ExecutorOptions): Promise<{
		roots: unknown;
		localRoot: string;
		approvalTargets: readonly string[] | undefined;
	}>;
	/** Read local-protocol getters synchronously, twice with an awaited gap the test fills. */
	localRoot(options: LocalProtocolOptions): Promise<string>;
	/** Bind prepared extensions in this thread and list the commands they registered. */
	bindExtensions(prepared: PreparedExtension[], cwd: string): Promise<{ commands: string[]; errors: string[] }>;
}

function isTestGlobals(value: unknown): value is { ready(probe: IntegrationsProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.map(part => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

async function runTool(
	tool: CustomTool,
	ctx: CustomToolContext,
	args: Record<string, unknown>,
	abort: AbortSignal | "on-update" | undefined,
	toolCallId = "call-1",
): Promise<ToolCallOutcome> {
	const updates: string[] = [];
	const controller = new AbortController();
	const signal = abort instanceof AbortSignal ? abort : controller.signal;
	try {
		const result = await tool.execute(
			toolCallId,
			args,
			partial => {
				updates.push(resultText(partial));
				if (abort === "on-update") controller.abort();
			},
			ctx,
			signal,
		);
		return { text: resultText(result), updates };
	} catch (error) {
		return {
			text: "",
			updates,
			error: error instanceof Error ? error.message : String(error),
			errorName: error instanceof Error ? error.name : undefined,
		};
	}
}

function workerContext(registry: ModelRegistry, onAbort: () => void): CustomToolContext {
	return {
		sessionManager: SessionManager.inMemory("/tmp/worker-cwd"),
		modelRegistry: registry,
		model: undefined,
		isIdle: () => false,
		hasQueuedMessages: () => true,
		abort: onAbort,
		localProtocolOptions: { getArtifactsDir: () => "/tmp/worker-artifacts", getSessionId: () => "worker-session" },
	};
}

function buildProbe(): IntegrationsProbe {
	let unwatch: (() => void) | undefined;
	const scopes = new Map<string, MCPManagerApi>();
	const notificationUnsubscribes = new Map<string, () => void>();
	const notifications = new Map<string, WorkerNotification>();
	const requireScope = (handleId: string): MCPManagerApi => {
		const scope = scopes.get(handleId);
		if (!scope) throw new Error(`no retained MCP scope ${handleId}`);
		return scope;
	};
	const snapshot = (scope: MCPManagerApi): WorkerScopeSnapshot => ({
		servers: [...scope.getConnectedServers()].sort(),
		tools: scope
			.getTools()
			.flatMap(tool => (tool.mcpServerName && tool.mcpToolName ? [`${tool.mcpServerName}/${tool.mcpToolName}`] : []))
			.sort(),
		revision: scope.toolViewsRevision,
	});
	return {
		mcpGlobal: async () => {
			const manager = MCPManager.instance();
			return {
				available: MCPManager.available(),
				remote: manager instanceof RemoteMCPManager,
				servers: manager?.getConnectedServers() ?? [],
				tools: manager?.getTools().map(tool => tool.name) ?? [],
			};
		},
		mcpScopeCreate: async handleId => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			const scope = await manager.createAgentScope();
			scopes.set(handleId, scope);
			return snapshot(scope);
		},
		mcpScopeCreateDeferred: async handleId => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			// Retain after the promise settles without making the caller wait; a rejection is surfaced by the
			// tests that await the audit, never as an unhandled rejection in this worker.
			void manager
				.createAgentScope()
				.then(scope => {
					scopes.set(handleId, scope);
				})
				.catch(() => {});
		},
		mcpScopeNested: async (parentHandleId, handleId) => {
			const parent = requireScope(parentHandleId);
			const scope = await parent.createAgentScope();
			scopes.set(handleId, scope);
			return snapshot(scope);
		},
		mcpScopeSnapshot: async handleId => snapshot(requireScope(handleId)),
		mcpScopeCall: async (handleId, serverName, toolName, args) => {
			const scope = requireScope(handleId);
			const tool = scope
				.getTools()
				.find(candidate => candidate.mcpServerName === serverName && candidate.mcpToolName === toolName);
			if (!tool?.execute) throw new Error(`no ${serverName}/${toolName} in scope ${handleId}`);
			return runTool(tool, {} as CustomToolContext, args, undefined);
		},
		mcpScopeReadResource: async (handleId, serverName, uri) => {
			const result = await requireScope(handleId).readServerResource(serverName, uri);
			const text = result?.contents.flatMap(part => (part.text === undefined ? [] : [part.text])).join("\n") ?? "";
			return JSON.parse(text) as Record<string, unknown>;
		},
		mcpScopeInstructions: async handleId => {
			return Object.fromEntries(requireScope(handleId).getServerInstructions());
		},
		mcpScopeRevision: async handleId => requireScope(handleId).toolViewsRevision,
		mcpScopeWatch: async handleId => {
			const scope = requireScope(handleId);
			notificationUnsubscribes.get(handleId)?.();
			notifications.delete(handleId);
			const unsubscribe = scope.addNotificationListener((serverName, method, params) => {
				notifications.set(handleId, { serverName, method, params });
			});
			notificationUnsubscribes.set(handleId, unsubscribe);
		},
		mcpScopeLastNotification: async handleId => notifications.get(handleId) ?? null,
		mcpScopeDispose: async handleId => {
			const scope = scopes.get(handleId);
			notificationUnsubscribes.get(handleId)?.();
			notificationUnsubscribes.delete(handleId);
			notifications.delete(handleId);
			scopes.delete(handleId);
			await scope?.disposeAgentScope();
		},
		mcpScopeDisposeRetained: async handleId => {
			notificationUnsubscribes.get(handleId)?.();
			notificationUnsubscribes.delete(handleId);
			notifications.delete(handleId);
			await requireScope(handleId).disposeAgentScope();
		},
		mcpViews: async scopesToRead => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			return scopesToRead.map(scope => manager.getTools(scope).map(tool => tool.mcpToolName ?? ""));
		},
		mcpCall: async (registry, toolName, args, signal) => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			manager.openToolScope("worker-child");
			const tool = createMCPProxyTools(manager, "worker-child").find(candidate => candidate.name === toolName);
			if (!tool) throw new Error(`no proxy for ${toolName}`);
			return runTool(
				tool,
				workerContext(registry, () => {}),
				args,
				signal,
			);
		},
		mcpScopedCall: async (scope, toolName, toolCallId, barrier) => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			manager.openToolScope(scope);
			const tool = createMCPProxyTools(manager, scope).find(candidate => candidate.mcpToolName === toolName);
			if (!tool) throw new Error(`no proxy for ${toolName}`);
			const trackToolCall = manager.trackToolCall;
			manager.trackToolCall = (callScope, callId) => {
				const release = trackToolCall.call(manager, callScope, callId);
				Atomics.add(barrier, 0, 1);
				Atomics.notify(barrier, 0);
				while (true) {
					const count = Atomics.load(barrier, 0);
					if (count >= 2) break;
					Atomics.wait(barrier, 0, count);
				}
				return release;
			};
			try {
				return await runTool(tool, {} as CustomToolContext, {}, undefined, toolCallId);
			} finally {
				manager.trackToolCall = trackToolCall;
			}
		},
		watchTools: async () => {
			unwatch?.();
			const { promise, resolve } = Promise.withResolvers<void>();
			unwatch = MCPManager.instance()?.addToolsChangedListener(() => resolve());
			return { changed: promise };
		},
		customCall: async (tool, registry, args, abortOnUpdate) => {
			let abortsSeen = 0;
			const outcome = await runTool(
				tool,
				workerContext(registry, () => {
					abortsSeen++;
				}),
				args,
				abortOnUpdate ? "on-update" : undefined,
			);
			return { ...outcome, abortsSeen };
		},
		readOptions: async options => ({
			roots: options.extensionRoots?.(),
			localRoot: options.localProtocolOptions ? resolveLocalRoot(options.localProtocolOptions) : "",
			approvalTargets: options.customTools?.[0]?.approvalCacheTargets?.({ path: "a.txt" }),
		}),
		localRoot: async options => resolveLocalRoot(options),
		bindExtensions: async (prepared, cwd) => {
			const result = await bindPreparedExtensions(prepared, cwd);
			return {
				commands: result.extensions.flatMap(extension => [...extension.commands.keys()]),
				errors: result.errors.map(entry => entry.error),
			};
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "integrations-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	const services = [settingsThreadService, authService, integrationsThreadService];
	for (const service of services) service.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("integrations fixture: missing test globals");
		await test.ready(buildProbe());
	});
	port.postMessage({ ready: true });
});
