/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */

import type { MCPAgentIsolation, MCPRequestIdFormat } from "../mcp/types";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Encoding for outgoing JSON-RPC request ids (default: `"number"`) */
	requestIdFormat?: MCPRequestIdFormat;
	/** Include server-provided instructions in the system prompt (default: true) */
	instructions?: boolean;
	/**
	 * Per-agent isolation for OMP-owned stdio configs (default: shared).
	 *
	 * `"agent"` gives each live agent a private instance; omitted keeps one
	 * session-wide instance shared by root and children. Remote transports
	 * cannot opt in.
	 */
	isolation?: MCPAgentIsolation;
	/**
	 * Set by OMP-owned loaders when an `isolation` opt-in must be rejected.
	 *
	 * The entry exists only to reserve the server name at deduplication so a
	 * lower-priority same-named definition cannot silently launch shared in its
	 * place. It carries no connection fields and is suppressed before any
	 * launch; capability validation also rejects it.
	 */
	isolationError?: string;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/**
	 * `literal`: env values are opaque plugin package data (Agent Plugins
	 * §§4.1/9.2) — exempt from env-name lookup and `!command` resolution.
	 */
	envPolicy?: "literal";
	/** Env keys whose values are final package data (expanded by the provider). */
	envLiteralKeys?: string[];
	/** Working directory for stdio transport */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/**
	 * `origin-locked`: configured headers are literal package data pinned to the
	 * configured URL's origin (Agent Plugins §7.2.1) — never expanded, never
	 * forwarded cross-origin, and client-generated headers win case-insensitively.
	 */
	headerPolicy?: "origin-locked";
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

/**
 * Interpret an explicit transport value from an untyped config.
 *
 * `"absent"` means the transport must be inferred from command/url; `"invalid"`
 * means the config named a transport this client does not implement. An
 * isolated opt-in must not fall back to command inference in that case: the
 * value is explicit even when malformed, so fail closed.
 */
export function readMCPTransport(value: unknown): "stdio" | "sse" | "http" | "absent" | "invalid" {
	if (value === undefined) return "absent";
	return value === "stdio" || value === "sse" || value === "http" ? value : "invalid";
}

/**
 * Effective transport kind for a server whose explicit `transport` may be unset.
 *
 * Matches the inference used when canonical servers become legacy configs:
 * an explicit transport wins, then a command means stdio, then a URL means
 * HTTP, and an empty definition degrades to stdio.
 */
export function resolveMCPTransport(server: {
	transport?: unknown;
	command?: unknown;
	url?: unknown;
}): "stdio" | "sse" | "http" {
	const transport = readMCPTransport(server.transport);
	if (transport === "stdio" || transport === "sse" || transport === "http") return transport;
	const hasCommand = typeof server.command === "string" && server.command.length > 0;
	const hasUrl = typeof server.url === "string" && server.url.length > 0;
	return hasCommand ? "stdio" : hasUrl ? "http" : "stdio";
}

/**
 * Interpret an OMP-owned `isolation` value.
 *
 * `"absent"` keeps shared behavior; `"agent"` opts into a private instance per
 * live agent. Any other present value — including non-strings and `null` — is
 * `"invalid"`: loaders and the runtime validator must reject the entry rather
 * than drop the option and launch the server shared.
 */
export function readMCPAgentIsolation(value: unknown): MCPAgentIsolation | "absent" | "invalid" {
	if (value === undefined) return "absent";
	return value === "agent" ? "agent" : "invalid";
}

/**
 * Validate an OMP-owned `isolation` value against its server transport.
 *
 * Returns the canonical opt-in when acceptable, otherwise a rejection message
 * that names the reason without echoing credentials. Loaders use this to emit
 * a name-reserving, non-connectable entry instead of dropping the opt-in and
 * launching the server shared.
 */
export function inspectMCPAgentIsolation(
	value: unknown,
	server: { transport?: unknown; command?: unknown; url?: unknown },
): { isolation?: MCPAgentIsolation; error?: string } {
	const isolation = readMCPAgentIsolation(value);
	if (isolation === "invalid") return { error: "invalid isolation value" };
	if (isolation === "absent") return {};

	// An explicit but unknown transport is not inferable as stdio: the config
	// named something this client cannot run, so an isolation opt-in fails
	// closed even when a command is present.
	const explicitTransport = readMCPTransport(server.transport);
	if (
		explicitTransport === "invalid" ||
		explicitTransport === "http" ||
		explicitTransport === "sse" ||
		(explicitTransport === "absent" && resolveMCPTransport(server) !== "stdio")
	) {
		return { error: 'isolation "agent" requires the stdio transport' };
	}
	return { isolation };
}

/** Compare the transport inputs that determine which MCP endpoint gets connected. */
export function isSameMCPConnection(left: MCPServer, right: MCPServer): boolean {
	// A rejected opt-in reserves only its name; it is never a connection, so it
	// must not equivalence-shadow a differently named valid server.
	if (left.isolationError !== undefined || right.isolationError !== undefined) return false;
	if (!Bun.deepEquals(left.auth, right.auth) || !Bun.deepEquals(left.oauth, right.oauth)) return false;
	// A shared and an isolated definition of the same endpoint are different
	// lifecycles (one session-wide process vs. one per live agent), so they must
	// both survive deduplication instead of one shadowing the other.
	if (left.isolation !== right.isolation) return false;
	// Normalize against the allocator's own default so an explicit "number" is
	// equivalent to leaving the option unset, not a distinct connection.
	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;

	const leftTransport = left.transport ?? (left.command ? "stdio" : left.url ? "http" : "stdio");
	const rightTransport = right.transport ?? (right.command ? "stdio" : right.url ? "http" : "stdio");
	if (leftTransport !== rightTransport) return false;

	if (leftTransport === "stdio") {
		// Effective literal keys: `envPolicy: "literal"` makes every env value
		// literal (equivalent to an envLiteralKeys set covering all keys), and an
		// inert policy on an env-less server must not distinguish otherwise
		// identical connections. Insertion order is irrelevant; compare as sets.
		const literalKeysOf = (server: MCPServer): string[] =>
			server.envPolicy === "literal"
				? Object.keys(server.env ?? {}).sort()
				: [...(server.envLiteralKeys ?? [])].sort();
		return (
			left.command === right.command &&
			Bun.deepEquals(left.args, right.args) &&
			Bun.deepEquals(left.env, right.env) &&
			Bun.deepEquals(literalKeysOf(left), literalKeysOf(right)) &&
			left.cwd === right.cwd
		);
	}

	return left.url === right.url && Bun.deepEquals(left.headers, right.headers);
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	equivalent: isSameMCPConnection,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (server.isolationError !== undefined) return server.isolationError;
		if (!server.command && !server.url) return "Must have command or url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		const isolation = readMCPAgentIsolation(server.isolation);
		if (isolation === "invalid") {
			return 'isolation must be "agent" when set';
		}
		const explicitTransport = readMCPTransport(server.transport);
		const isolatedTransport = explicitTransport === "absent" ? resolveMCPTransport(server) : explicitTransport;
		if (isolation === "agent" && isolatedTransport !== "stdio") {
			return 'isolation "agent" is only supported for stdio servers';
		}

		return undefined;
	},
});
