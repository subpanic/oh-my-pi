/**
 * Caller-scoped MCP resource access: a session that explicitly disables MCP, or enables it but has
 * no manager of its own, must not read resources through the process-global manager. Only a caller
 * with no session, or a CLI-style session that leaves `enableMCP` unset, keeps global discovery.
 *
 * The global manager is a real stdio server; its audit log proves denied callers never issue a
 * `resources/read` request.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type IsolationAuditEvent, isolationFixtureConfig, readIsolationAudit } from "../helpers/isolation-fixture";

const RESOURCE_URL = "mcp://fixture://status";

let dir: string;
let auditPath: string;
let manager: MCPManager;

function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	};
}

async function resourceReads(): Promise<IsolationAuditEvent[]> {
	return (await readIsolationAudit(auditPath)).filter(
		event => event.event === "request" && event.method === "resources/read",
	);
}

async function resolveAs(session: ToolSession | undefined) {
	return InternalUrlRouter.instance().resolve(RESOURCE_URL, session ? sessionResolveContext(session) : undefined);
}

beforeEach(async () => {
	dir = path.join(os.tmpdir(), `omp-mcp-resource-caller-scope-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	auditPath = path.join(dir, "audit.jsonl");
	manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	await manager.connectServers({ global: isolationFixtureConfig(auditPath, { label: "global" }) }, {});
	const startup = await manager.waitForStartup(0);
	if (startup.failed.length > 0) throw new Error(`MCP startup failed: ${JSON.stringify(startup.failed)}`);
	MCPManager.setInstance(manager);
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	MCPManager.resetForTests();
	InternalUrlRouter.resetForTests();
	await manager.disconnectAll();
	removeSyncWithRetries(dir);
});

describe("caller-scoped MCP resources", () => {
	it("denies explicit MCP-disabled and enabled-without-own-manager callers without reading the global root", async () => {
		const before = (await resourceReads()).length;

		// Explicitly disabled, even with a stale manager attached: denial wins.
		await expect(resolveAs(toolSession({ enableMCP: false }))).rejects.toThrow("No MCP manager");
		await expect(resolveAs(toolSession({ enableMCP: false, mcpManager: manager }))).rejects.toThrow("No MCP manager");
		// Explicitly enabled but no manager of its own: it may not borrow the global root.
		await expect(resolveAs(toolSession({ enableMCP: true }))).rejects.toThrow("No MCP manager");

		expect((await resourceReads()).length).toBe(before);
	});

	it("serves a caller's own manager and the CLI-style global fallback", async () => {
		const before = (await resourceReads()).length;

		const own = await resolveAs(toolSession({ enableMCP: true, mcpManager: manager }));
		expect(JSON.parse(own.content)).toMatchObject({ label: "global" });

		// CLI-style session: `enableMCP` is unset, so manager discovery stays with the process global.
		const cli = await resolveAs(toolSession());
		expect(JSON.parse(cli.content)).toMatchObject({ label: "global" });

		// No session at all is the other documented global fallback.
		const noSession = await resolveAs(undefined);
		expect(JSON.parse(noSession.content)).toMatchObject({ label: "global" });

		expect((await resourceReads()).length).toBeGreaterThan(before);
	});
});
