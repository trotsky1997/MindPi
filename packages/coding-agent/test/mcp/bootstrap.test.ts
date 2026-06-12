import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapDirectToolMetadata } from "../../src/core/builtin-extensions/mcp/init.ts";
import type { McpConfig } from "../../src/core/builtin-extensions/mcp/types.ts";

const tempDirs: string[] = [];

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-bootstrap-"));
	tempDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("bootstrapDirectToolMetadata", () => {
	it("is a no-op (returns []) when no servers request directTools", async () => {
		makeAgentDir();
		const config: McpConfig = {
			mcpServers: { plain: { command: "node", args: ["x.js"] } },
		};
		// No directTools configured -> nothing missing -> no connection attempt.
		const warmed = await bootstrapDirectToolMetadata(config, null, 1000);
		expect(warmed).toEqual([]);
	});

	it("is a no-op when the cache is already warm for a directTools server", async () => {
		const agentDir = makeAgentDir();
		const definition = { command: "node", args: ["x.js"], directTools: true };
		const config: McpConfig = { mcpServers: { srv: definition }, settings: { directTools: true } };
		// Pre-write a valid cache entry so the server is not "missing".
		// computeServerHash must match, so import it to build the entry.
		const { computeServerHash, saveMetadataCache } = await import(
			"../../src/core/builtin-extensions/mcp/metadata-cache.ts"
		);
		saveMetadataCache({
			version: 1,
			servers: {
				srv: { configHash: computeServerHash(definition), tools: [], resources: [], cachedAt: Date.now() },
			},
		});
		const { loadMetadataCache } = await import("../../src/core/builtin-extensions/mcp/metadata-cache.ts");
		const warmed = await bootstrapDirectToolMetadata(config, loadMetadataCache(), 1000);
		expect(warmed).toEqual([]);
		// agentDir untouched beyond the cache file we wrote
		void agentDir;
	});

	it("times out gracefully on an unreachable directTools server (no throw)", async () => {
		makeAgentDir();
		const config: McpConfig = {
			// a command that hangs without speaking MCP -> connect never completes
			mcpServers: { hang: { command: "sleep", args: ["60"], directTools: true } },
			settings: { directTools: true },
		};
		const start = Date.now();
		const warmed = await bootstrapDirectToolMetadata(config, null, 500);
		// did not warm it, did not throw, and respected the timeout budget
		expect(warmed).toEqual([]);
		expect(Date.now() - start).toBeLessThan(5000);
	});
});
