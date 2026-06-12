import { describe, expect, it } from "vitest";
import { normalizePiAssistantText, normalizePiMessageText } from "../../src/modes/acp/translate/pi-messages.ts";
import { toolResultToText } from "../../src/modes/acp/translate/pi-tools.ts";
import { promptToPiMessage } from "../../src/modes/acp/translate/prompt.ts";

describe("normalizePiMessageText", () => {
	it("passes through plain strings", () => {
		expect(normalizePiMessageText("hello")).toBe("hello");
	});

	it("joins text blocks and ignores non-text", () => {
		expect(
			normalizePiMessageText([
				{ type: "text", text: "a" },
				{ type: "image", data: "..." },
				{ type: "text", text: "b" },
			]),
		).toBe("ab");
	});

	it("returns empty string for non-array, non-string", () => {
		expect(normalizePiMessageText(null)).toBe("");
		expect(normalizePiMessageText({ text: "x" })).toBe("");
	});
});

describe("normalizePiAssistantText", () => {
	it("only joins text blocks (arrays only)", () => {
		expect(normalizePiAssistantText([{ type: "text", text: "hi" }])).toBe("hi");
		// unlike message text, a bare string is not passed through
		expect(normalizePiAssistantText("hi")).toBe("");
	});
});

describe("toolResultToText", () => {
	it("returns content text blocks when present", () => {
		expect(toolResultToText({ content: [{ type: "text", text: "out" }] })).toBe("out");
	});

	it("prefers details.diff for edit-like results", () => {
		expect(toolResultToText({ details: { diff: "@@ -1 +1 @@\n-a\n+b" } })).toContain("@@");
	});

	it("formats bash stdout/stderr/exit code from details", () => {
		const text = toolResultToText({ details: { stdout: "hello\n", stderr: "oops\n", exitCode: 1 } });
		expect(text).toContain("hello");
		expect(text).toContain("stderr:");
		expect(text).toContain("oops");
		expect(text).toContain("exit code: 1");
	});

	it("falls back to JSON for unknown shapes", () => {
		const text = toolResultToText({ weird: { nested: true } });
		expect(text).toContain("weird");
		expect(text).toContain("nested");
	});

	it("returns empty string for falsy result", () => {
		expect(toolResultToText(null)).toBe("");
		expect(toolResultToText(undefined)).toBe("");
	});
});

describe("promptToPiMessage", () => {
	it("concatenates text blocks", () => {
		const { message, images } = promptToPiMessage([
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		] as never);
		expect(message).toBe("Hello world");
		expect(images).toHaveLength(0);
	});

	it("extracts images into the images array (no data-url prefix)", () => {
		const { message, images } = promptToPiMessage([
			{ type: "text", text: "see:" },
			{ type: "image", mimeType: "image/png", data: "BASE64DATA" },
		] as never);
		expect(message).toBe("see:");
		expect(images).toEqual([{ type: "image", mimeType: "image/png", data: "BASE64DATA" }]);
	});

	it("renders resource_link as a context hint", () => {
		const { message } = promptToPiMessage([{ type: "resource_link", uri: "file:///x.ts" }] as never);
		expect(message).toContain("[Context] file:///x.ts");
	});

	it("inlines embedded text resources", () => {
		const { message } = promptToPiMessage([
			{ type: "resource", resource: { uri: "file:///r.md", text: "BODY", mimeType: "text/markdown" } },
		] as never);
		expect(message).toContain("[Embedded Context] file:///r.md (text/markdown)");
		expect(message).toContain("BODY");
	});

	it("marks audio as unsupported rather than dropping it", () => {
		const { message } = promptToPiMessage([
			{ type: "audio", mimeType: "audio/wav", data: Buffer.from("xx").toString("base64") },
		] as never);
		expect(message).toContain("[Audio]");
		expect(message).toContain("not supported");
	});

	it("ignores unknown block types", () => {
		const { message, images } = promptToPiMessage([{ type: "totally_unknown" }] as never);
		expect(message).toBe("");
		expect(images).toHaveLength(0);
	});
});
