import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSessionSnapshot, deserializeSessionPayload, detectSessionFormat } from "../../src/core/hcp/session.ts";

describe("detectSessionFormat", () => {
	it("detects ATIF", () => {
		expect(detectSessionFormat({ schema_version: "ATIF-v1.7", steps: [] })).toBe("atif");
	});

	it("detects Qwen35", () => {
		expect(detectSessionFormat({ id: "x", messages: [], meta: { endpoint: "e" } })).toBe("qwen35");
	});

	it("falls back to pi-session", () => {
		expect(detectSessionFormat({ messages: [] })).toBe("pi-session");
	});
});

describe("decodeSessionSnapshot", () => {
	it("decodes inline snapshot_json", () => {
		const decoded = decodeSessionSnapshot({ snapshot_json: '{"id":"a","messages":[]}' });
		expect((decoded as { id: string }).id).toBe("a");
	});

	it("decodes base64+json snapshots", () => {
		const raw = JSON.stringify({ id: "b", messages: [] });
		const decoded = decodeSessionSnapshot({
			snapshot: { content: Buffer.from(raw, "utf8").toString("base64"), encoding: "base64+json" },
		});
		expect((decoded as { id: string }).id).toBe("b");
	});

	it("decodes zlib+base64+json snapshots", () => {
		const raw = JSON.stringify({ id: "c", messages: [] });
		const decoded = decodeSessionSnapshot({
			snapshot: { content: deflateSync(Buffer.from(raw, "utf8")).toString("base64"), encoding: "zlib+base64+json" },
		});
		expect((decoded as { id: string }).id).toBe("c");
	});

	it("returns undefined when no snapshot is present", () => {
		expect(decodeSessionSnapshot({})).toBeUndefined();
	});

	it("throws on unsupported encoding", () => {
		expect(() => decodeSessionSnapshot({ snapshot: { content: "x", encoding: "rot13" } })).toThrow(
			/Unsupported session snapshot encoding/,
		);
	});
});

describe("deserializeSessionPayload", () => {
	it("normalizes a pi-session record", () => {
		const record = deserializeSessionPayload({ id: "s1", messages: [{ role: "user", content: "hi" }] });
		expect(record.id).toBe("s1");
		expect(record.messages).toHaveLength(1);
	});

	it("converts an ATIF trajectory", () => {
		const record = deserializeSessionPayload({
			schema_version: "ATIF-v1.7",
			agent: { name: "x" },
			steps: [{ step_id: 1, source: "user", message: "hello" }],
		});
		expect(record.messages[0].role).toBe("user");
		expect(record.messages[0].content).toBe("hello");
	});
});
