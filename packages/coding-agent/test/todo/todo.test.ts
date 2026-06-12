import { describe, expect, it } from "vitest";
import { TodoStateManager } from "../../src/core/builtin-extensions/todo/state-manager.ts";
import type { TodoItem } from "../../src/core/builtin-extensions/todo/types.ts";

function item(id: number, status: TodoItem["status"]): TodoItem {
	return { id, title: `task ${id}`, description: `desc ${id}`, status };
}

describe("TodoStateManager", () => {
	it("writes and reads todos (array copy on read)", () => {
		const state = new TodoStateManager();
		const todos = [item(1, "not-started"), item(2, "in-progress")];
		state.write(todos);
		const read = state.read();
		expect(read).toHaveLength(2);
		// read() returns a new array, so pushing to it does not grow internal state
		read.push(item(3, "completed"));
		expect(state.read()).toHaveLength(2);
		// write() deep-copies input, so mutating the source array's items afterward is isolated
		todos[0].title = "external-mutation";
		expect(state.read()[0].title).toBe("task 1");
	});

	it("computes stats", () => {
		const state = new TodoStateManager();
		state.write([item(1, "completed"), item(2, "completed"), item(3, "in-progress"), item(4, "not-started")]);
		expect(state.getStats()).toEqual({ total: 4, completed: 2, inProgress: 1, notStarted: 1 });
	});

	it("clears", () => {
		const state = new TodoStateManager();
		state.write([item(1, "completed")]);
		state.clear();
		expect(state.read()).toHaveLength(0);
	});

	it("validates required fields and statuses", () => {
		const state = new TodoStateManager();
		expect(state.validate([item(1, "completed")]).valid).toBe(true);
		const bad = state.validate([{ id: 1, title: "", description: "", status: "bogus" as TodoItem["status"] }]);
		expect(bad.valid).toBe(false);
		expect(bad.errors.length).toBeGreaterThan(0);
	});

	it("reconstructs from session tool results", () => {
		const state = new TodoStateManager();
		const branch = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "manage_todo_list",
					details: { operation: "write", todos: [item(1, "completed"), item(2, "not-started")] },
				},
			},
		];
		const ctx = { sessionManager: { getBranch: () => branch } } as never;
		state.loadFromSession(ctx);
		expect(state.read()).toHaveLength(2);
		expect(state.getStats().completed).toBe(1);
	});
});
