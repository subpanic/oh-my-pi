/**
 * Per-agent MCP isolation is an OMP-owned, stdio-only config option.
 *
 * These tests exercise the real loaders, runtime validator, capability
 * equivalence, schema, and config writer. The contract is fail-closed: an
 * invalid `isolation` value or a remote transport rejects the opt-in at the raw
 * loader boundary and by `validateServerConfig`, so it is never silently
 * discarded and the server launched shared. The rejected entry reserves its
 * name so a same-named lower-priority definition cannot launch in its place.
 *
 * `isolation` is also a connection-lifecycle input: a shared definition and an
 * isolated definition of one endpoint must both survive deduplication.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { isSameMCPConnection, mcpCapability, type MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import {
	loadAllMCPConfigs,
	type LoadMCPConfigsOptions,
	type LoadMCPConfigsResult,
	validateServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp/config";
import { addMCPServer, readMCPConfigFile, updateMCPServer } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { __resetDirsFromEnvForTests, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery";

/**
 * Environment snapshot for every test. `setAgentDir()` rewrites the agent dir,
 * and an inherited profile or foreign config root would let developer MCP
 * servers leak into the fixture (DEVELOPMENT.md test-isolation rules).
 */
const ENV_KEYS = [
	"HOME",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"CLAUDE_CONFIG_DIR",
	"COPILOT_HOME",
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

let tempHome = "";
let tempAgentDir = "";
let tempCwd = "";

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
	// Drop inherited agent/profile and foreign config roots before creating the
	// fixture, so discovery cannot read a developer's real MCP definitions.
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"CLAUDE_CONFIG_DIR",
		"COPILOT_HOME",
	] as const) {
		restoreEnvValue(key, undefined);
	}
	// Rebuild module directory state from the cleaned env before the fixture
	// overrides the agent dir, so inherited overrides cannot linger in caches.
	__resetDirsFromEnvForTests();
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-isolation-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-isolation-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-isolation-cwd-"));
	restoreEnvValue("HOME", tempHome);
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

type ProviderId = "native" | "standalone" | "plugin";

async function writeRawServers(file: string, servers: Record<string, unknown>): Promise<void> {
	const target = path.join(tempCwd, file);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, JSON.stringify({ mcpServers: servers }, null, 2));
	clearFsCache();
}

async function loadProvider(provider: ProviderId, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	return loadAllMCPConfigs(tempCwd, {
		filterExa: false,
		...options,
		extensionRoots: {
			explicit: provider === "plugin" ? [path.join(tempCwd, "plugin")] : [],
			mode: provider === "plugin" ? "explicit-only" : "merge",
			configured: [],
			configuredLevel: "project",
		},
	});
}

/** Loaded configs are narrowed before reading stdio-only fields. */
function stdioConfig(config: MCPServerConfig | undefined): MCPStdioServerConfig | undefined {
	return config?.type === "stdio" ? config : undefined;
}

function warningText(calls: unknown[][]): string {
	return calls
		.map(args => args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
		.join("\n");
}

describe.each([
	["native", ".omp/mcp.json"],
	["standalone", ".mcp.json"],
	["plugin", "plugin/.mcp.json"],
] as const)("%s loader isolation handling", (provider, file) => {
	test("carries a stdio isolation opt-in into the runtime config", async () => {
		await writeRawServers(file, {
			isolated: {
				type: "stdio",
				command: "/bin/echo",
				args: ["isolated"],
				env: { GREETING: "hello" },
				cwd: "/tmp/agent-work",
				isolation: "agent",
			},
			shared: { type: "stdio", command: "/bin/echo", args: ["shared"] },
		});

		const { configs, sources } = await loadProvider(provider);

		const isolated = stdioConfig(configs.isolated);
		const shared = stdioConfig(configs.shared);
		expect(Object.keys(configs).sort()).toEqual(["isolated", "shared"]);
		expect(isolated?.isolation).toBe("agent");
		// The opt-in must not disturb the rest of the stdio definition.
		expect(isolated?.type).toBe("stdio");
		expect(isolated?.command).toBe("/bin/echo");
		expect(isolated?.args).toEqual(["isolated"]);
		expect(isolated?.env).toEqual({ GREETING: "hello" });
		expect(isolated?.cwd).toBe("/tmp/agent-work");
		expect(shared?.isolation).toBeUndefined();
		// Explicit plugin roots are user-scope sources; file configs stay project.
		expect(sources.isolated?.level).toBe(provider === "plugin" ? "user" : "project");
	});

	test("drops a server with an invalid isolation value instead of launching it shared", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await writeRawServers(file, {
			"bad-string": { command: "/bin/echo", isolation: "shared" },
			"bad-null": { command: "/bin/echo", isolation: null },
			"bad-bool": { command: "/bin/echo", isolation: true },
			"bad-transport": { type: "websocket", command: "/bin/echo", isolation: "agent" },
			good: { command: "/bin/echo", isolation: "agent" },
		});

		const { configs } = await loadProvider(provider);

		// Fail closed: the invalid entries are gone, not present with the option
		// erased (which would have launched a shared process). A malformed
		// explicit transport is not inferred as stdio despite the command.
		expect(Object.keys(configs)).toEqual(["good"]);
		expect(stdioConfig(configs.good)?.isolation).toBe("agent");
		const warnings = warningText(warn.mock.calls);
		expect(warnings).toContain("bad-string");
		expect(warnings).toContain("bad-transport");
		// Invalid values are not echoed back (they may carry arbitrary data).
		expect(warnings).not.toContain('"shared"');
	});

	test("drops HTTP, SSE, and inferred-remote isolation opt-ins", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await writeRawServers(file, {
			"remote-http": { type: "http", url: "https://mcp.example/http", isolation: "agent" },
			"remote-sse": { type: "sse", url: "https://mcp.example/sse", isolation: "agent" },
			"remote-inferred": { url: "https://mcp.example/inferred", isolation: "agent" },
			local: { type: "stdio", command: "/bin/echo", isolation: "agent" },
		});

		const { configs } = await loadProvider(provider);

		expect(Object.keys(configs)).toEqual(["local"]);
		expect(stdioConfig(configs.local)?.isolation).toBe("agent");
		expect(warningText(warn.mock.calls)).toContain("remote-http");
	});
});

describe("isolation and deduplication", () => {
	test("shared aliases still collapse as before", async () => {
		await writeRawServers(path.join(".omp", "mcp.json"), {
			"shared-a": { type: "stdio", command: "/bin/echo", args: ["same"] },
			"shared-b": { type: "stdio", command: "/bin/echo", args: ["same"] },
		});

		const { configs } = await loadProvider("native");

		expect(Object.keys(configs)).toHaveLength(1);
		expect(stdioConfig(Object.values(configs)[0])?.isolation).toBeUndefined();
	});

	test("a shared and an isolated definition of one endpoint both survive", async () => {
		await writeRawServers(path.join(".omp", "mcp.json"), {
			"work-shared": { type: "stdio", command: "/bin/echo", args: ["same"], cwd: "/tmp/work" },
			"work-isolated": {
				type: "stdio",
				command: "/bin/echo",
				args: ["same"],
				cwd: "/tmp/work",
				isolation: "agent",
			},
		});

		const { configs } = await loadProvider("native");

		expect(Object.keys(configs).sort()).toEqual(["work-isolated", "work-shared"]);
		expect(stdioConfig(configs["work-isolated"])?.isolation).toBe("agent");
		expect(stdioConfig(configs["work-shared"])?.isolation).toBeUndefined();
	});

	test("isSameMCPConnection treats the isolation lifecycle as a connection input", () => {
		const base = {
			name: "fixture",
			command: "/bin/echo",
			args: ["same"],
			cwd: "/tmp/work",
			_source: { provider: "test", providerName: "test", path: "/tmp/mcp.json", level: "project" as const },
		};
		const shared: MCPServer = { ...base };
		const isolated: MCPServer = { ...base, name: "fixture-agent", isolation: "agent" };

		expect(isSameMCPConnection(shared, isolated)).toBe(false);
		expect(isSameMCPConnection(shared, { ...base, name: "other" })).toBe(true);
		expect(isSameMCPConnection(isolated, { ...isolated, name: "other-isolated" })).toBe(true);

		// A rejected opt-in only reserves its name; it must never alias-shadow a
		// differently named real connection.
		const reservation: MCPServer = {
			name: "rejected",
			enabled: false,
			isolationError: "invalid isolation",
			_source: base._source,
		};
		expect(isSameMCPConnection(reservation, shared)).toBe(false);
	});
});

describe("isolation precedence and filtering", () => {
	test("the user denylist still suppresses an isolated server", async () => {
		await writeRawServers(path.join(".omp", "mcp.json"), {
			isolated: { command: "/bin/echo", isolation: "agent" },
			kept: { command: "/bin/echo", isolation: "agent" },
		});
		await Bun.write(
			path.join(tempAgentDir, "mcp.json"),
			JSON.stringify({ mcpServers: {}, disabledServers: ["isolated"] }),
		);
		clearFsCache();

		const { configs } = await loadProvider("native");

		expect(Object.keys(configs)).toEqual(["kept"]);
		expect(stdioConfig(configs.kept)?.isolation).toBe("agent");
	});

	test("scope filtering applies before an isolated project server can shadow the user one", async () => {
		await writeRawServers(path.join(".omp", "mcp.json"), {
			context: { command: "/bin/echo", args: ["same"], isolation: "agent" },
		});
		await Bun.write(
			path.join(tempAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					context: { command: "/bin/echo", args: ["same"], isolation: "agent" },
				},
			}),
		);
		clearFsCache();

		const { configs, sources } = await loadProvider("native", { enableProjectConfig: false });

		expect(Object.keys(configs)).toEqual(["context"]);
		expect(sources.context?.level).toBe("user");
		expect(stdioConfig(configs.context)?.isolation).toBe("agent");
	});

	test("an invalid higher-priority opt-in blocks a same-named lower-priority shared server", async () => {
		// Project native config wins over the user native config. Rejecting its
		// isolation opt-in must reserve the name, not fall through to the user
		// definition (which would silently launch the server shared).
		await writeRawServers(path.join(".omp", "mcp.json"), {
			dup: { command: "/bin/echo", isolation: "shared" },
		});
		await Bun.write(
			path.join(tempAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					dup: { command: "/bin/echo" },
					other: { command: "/bin/echo" },
				},
			}),
		);
		clearFsCache();

		const { configs } = await loadProvider("native");

		expect(Object.keys(configs)).toEqual(["other"]);
		expect(stdioConfig(configs.other)?.isolation).toBeUndefined();
	});

	test("force-enabling the name does not revive a rejected remote opt-in", async () => {
		await writeRawServers(path.join(".omp", "mcp.json"), {
			dup: { type: "http", url: "https://mcp.example/dup", isolation: "agent" },
		});
		await Bun.write(
			path.join(tempAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { dup: { type: "http", url: "https://mcp.example/dup" } },
				enabledServers: ["dup"],
			}),
		);
		clearFsCache();

		const { configs } = await loadProvider("native");

		// The reservation is suppressed unconditionally; the user allowlist can
		// neither enable it nor resurrect the same-named shared definition.
		expect(configs).toEqual({});
	});

	test("a higher-priority plugin reservation blocks a same-named standalone server", async () => {
		await writeRawServers(path.join("plugin", ".mcp.json"), {
			dup: { command: "/bin/echo", isolation: "shared" },
		});
		await writeRawServers(".mcp.json", {
			dup: { command: "/bin/echo" },
			kept: { command: "/bin/echo" },
		});

		const { configs } = await loadProvider("plugin");

		expect(Object.keys(configs)).toEqual(["kept"]);
	});

	test("a plugin isolation opt-in without an endpoint still reserves its name", async () => {
		// Endpoint validation must not run before the opt-in check: otherwise an
		// invalid (or unusable) higher-priority plugin definition is silently
		// skipped and the same-named standalone server launches shared.
		await writeRawServers(path.join("plugin", ".mcp.json"), {
			dup: { isolation: "shared" },
			"agent-no-endpoint": { isolation: "agent" },
		});
		await writeRawServers(".mcp.json", {
			dup: { command: "/bin/echo" },
			"agent-no-endpoint": { command: "/bin/echo" },
			kept: { command: "/bin/echo" },
		});

		const { configs } = await loadProvider("plugin");

		expect(Object.keys(configs)).toEqual(["kept"]);
	});

	test("a foreign provider format ignores the OMP-only option", async () => {
		await writeRawServers(path.join(".cursor", "mcp.json"), {
			foreign: { command: "/bin/echo", isolation: "agent" },
		});

		const { configs } = await loadAllMCPConfigs(tempCwd, { filterExa: false });

		// Cursor's format has no such key; translating providers must not grow the
		// OMP contract, so the server loads shared.
		expect(Object.keys(configs)).toContain("foreign");
		expect(stdioConfig(configs.foreign)?.isolation).toBeUndefined();
	});
});

describe("runtime validation", () => {
	test("accepts stdio isolation and rejects it everywhere else", () => {
		expect(validateServerConfig("local", { type: "stdio", command: "/bin/echo", isolation: "agent" })).toEqual([]);
		expect(validateServerConfig("local", { command: "/bin/echo", isolation: "agent" })).toEqual([]);

		// HTTP/SSE configs do not declare `isolation`, but parsed JSON can carry
		// the key; the runtime validator must still reject it.
		const remoteHttp = {
			type: "http",
			url: "https://mcp.example/http",
			isolation: "agent",
		} as unknown as MCPServerConfig;
		const httpErrors = validateServerConfig("remote", remoteHttp);
		expect(httpErrors.join("\n")).toContain("isolation");
		expect(httpErrors.join("\n")).toContain("stdio");

		const remoteSse = {
			type: "sse",
			url: "https://mcp.example/sse",
			isolation: "agent",
		} as unknown as MCPServerConfig;
		const sseErrors = validateServerConfig("remote", remoteSse);
		expect(sseErrors.join("\n")).toContain("isolation");

		// A malformed explicit transport must not be inferred as stdio just
		// because a command is present.
		const unknownTransport = {
			type: "websocket",
			command: "/bin/echo",
			isolation: "agent",
		} as unknown as MCPServerConfig;
		expect(validateServerConfig("remote", unknownTransport).join("\n")).toContain("isolation");
	});

	test("rejects values outside the literal even when parsed JSON bypasses the type", () => {
		// Config files are untyped JSON; the validator is the last fail-closed
		// boundary before a connection is attempted.
		const invalid = { type: "stdio", command: "/bin/echo", isolation: "shared" } as unknown as MCPServerConfig;
		const nullish = { type: "stdio", command: "/bin/echo", isolation: null } as unknown as MCPServerConfig;

		expect(validateServerConfig("fixture", invalid).join("\n")).toContain('"isolation" must be "agent"');
		expect(validateServerConfig("fixture", nullish).join("\n")).toContain('"isolation" must be "agent"');
	});

	test("capability validation applies the same fail-closed rules", () => {
		const source = { provider: "test", providerName: "test", path: "/tmp/mcp.json", level: "project" as const };
		const remote: MCPServer = {
			name: "remote",
			url: "https://mcp.example/http",
			transport: "http",
			isolation: "agent",
			_source: source,
		};
		const invalid = {
			name: "bad",
			command: "/bin/echo",
			isolation: "shared",
			_source: source,
		} as unknown as MCPServer;

		expect(mcpCapability.validate?.(remote)).toContain("isolation");
		// Explicit unknown transport plus a command must not pass as stdio.
		const unknownTransport = {
			name: "unknown",
			command: "/bin/echo",
			transport: "websocket",
			isolation: "agent",
			_source: source,
		} as unknown as MCPServer;
		expect(mcpCapability.validate?.(unknownTransport)).toContain("isolation");
		expect(mcpCapability.validate?.(invalid)).toContain('"agent"');
		expect(
			mcpCapability.validate?.({
				name: "local",
				command: "/bin/echo",
				isolation: "agent",
				_source: source,
			}),
		).toBeUndefined();

		// Reservation entries from a rejected opt-in are never loadable.
		const reservation: MCPServer = {
			name: "reserved",
			enabled: false,
			isolationError: "invalid isolation",
			_source: source,
		};
		expect(mcpCapability.validate?.(reservation)).toBe("invalid isolation");
	});
});

describe("schema", () => {
	test("accepts the opt-in only on stdio servers", () => {
		expect(
			validateJsonSchemaValue(mcpSchema, {
				mcpServers: { fixture: { type: "stdio", command: "/bin/echo", isolation: "agent" } },
			}).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(mcpSchema, {
				mcpServers: { fixture: { type: "stdio", command: "/bin/echo" } },
			}).success,
		).toBe(true);

		for (const remote of [
			{ type: "http", url: "https://mcp.example/http", isolation: "agent" },
			{ type: "sse", url: "https://mcp.example/sse", isolation: "agent" },
		]) {
			expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: remote } }).success).toBe(false);
		}
	});

	test("rejects values outside the literal", () => {
		for (const isolation of ["shared", "agent ", "", 1, true, null]) {
			expect(
				validateJsonSchemaValue(mcpSchema, {
					mcpServers: { fixture: { type: "stdio", command: "/bin/echo", isolation } },
				}).success,
			).toBe(false);
		}
	});
});

describe("config writer roundtrip", () => {
	let configPath = "";

	beforeEach(() => {
		configPath = path.join(tempAgentDir, "mcp.json");
	});

	test("persists isolation for a stdio server and the loader sees it", async () => {
		await addMCPServer(configPath, "isolated", {
			type: "stdio",
			command: "/bin/echo",
			args: ["isolated"],
			env: { GREETING: "hello" },
			cwd: "/tmp/agent-work",
			isolation: "agent",
		});

		const written = await readMCPConfigFile(configPath);
		const writtenServer = stdioConfig(written.mcpServers?.isolated);
		expect(writtenServer?.isolation).toBe("agent");
		expect(writtenServer?.env).toEqual({ GREETING: "hello" });

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(tempCwd, { filterExa: false });
		expect(Object.keys(configs)).toEqual(["isolated"]);
		expect(stdioConfig(configs.isolated)?.isolation).toBe("agent");
		expect(stdioConfig(configs.isolated)?.cwd).toBe("/tmp/agent-work");
	});

	test("update writes an isolation opt-in and the loader sees it", async () => {
		await addMCPServer(configPath, "isolated", { type: "stdio", command: "/bin/echo" });
		await updateMCPServer(configPath, "isolated", {
			type: "stdio",
			command: "/bin/echo",
			args: ["next"],
			isolation: "agent",
		});

		const written = await readMCPConfigFile(configPath);
		expect(written.mcpServers?.isolated).toEqual({
			type: "stdio",
			command: "/bin/echo",
			args: ["next"],
			isolation: "agent",
		});

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(tempCwd, { filterExa: false });
		expect(Object.keys(configs)).toEqual(["isolated"]);
		expect(stdioConfig(configs.isolated)?.isolation).toBe("agent");
	});

	test("refuses to write remote or invalid isolation and leaves the file untouched", async () => {
		await addMCPServer(configPath, "local", { type: "stdio", command: "/bin/echo" });

		const remoteHttp = {
			type: "http",
			url: "https://mcp.example/http",
			isolation: "agent",
		} as unknown as MCPServerConfig;
		await expect(addMCPServer(configPath, "remote", remoteHttp)).rejects.toThrow(/isolation/);

		const invalid = { type: "stdio", command: "/bin/echo", isolation: "shared" } as unknown as MCPServerConfig;
		await expect(addMCPServer(configPath, "invalid", invalid)).rejects.toThrow(/isolation/);

		const written = await readMCPConfigFile(configPath);
		expect(Object.keys(written.mcpServers ?? {})).toEqual(["local"]);
	});
});
