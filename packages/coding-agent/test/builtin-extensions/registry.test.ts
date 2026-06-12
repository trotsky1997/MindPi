import { describe, expect, it } from "vitest";
import { getBuiltinExtensionFactories } from "../../src/core/builtin-extensions/index.ts";

describe("getBuiltinExtensionFactories", () => {
	it("returns nothing by default (built-ins are opt-in)", () => {
		expect(getBuiltinExtensionFactories()).toHaveLength(0);
		expect(getBuiltinExtensionFactories({})).toHaveLength(0);
	});

	it("returns only the built-ins explicitly enabled", () => {
		expect(getBuiltinExtensionFactories({ mcp: true })).toHaveLength(1);
		expect(getBuiltinExtensionFactories({ hooks: true, todo: true })).toHaveLength(2);
		const all = getBuiltinExtensionFactories({ hooks: true, mcp: true, todo: true });
		expect(all).toHaveLength(3);
		for (const f of all) expect(typeof f).toBe("function");
	});
});
