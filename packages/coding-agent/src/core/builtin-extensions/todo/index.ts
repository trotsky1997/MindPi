/**
 * Built-in todo extension.
 *
 * Ported from pi-manage-todo-list: provides a `manage_todo_list` tool
 * (read/write operations), a read-only progress widget, and a `/todos` command.
 * State persists via tool-result details and is reconstructed from the session
 * on load/resume/fork/tree navigation.
 */
import type { ExtensionAPI, ExtensionContext } from "../../extensions/types.ts";
import { TodoStateManager } from "./state-manager.ts";
import { createManageTodoListTool } from "./tool.ts";
import { clearWidget, updateWidget } from "./ui/todo-widget.ts";

export default function todoExtension(pi: ExtensionAPI): void {
	const state = new TodoStateManager();

	let currentCtx: ExtensionContext | undefined;

	const onTodoUpdate = () => {
		if (currentCtx) {
			updateWidget(state, currentCtx);
		}
	};

	const reconstructState = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.loadFromSession(ctx);
		updateWidget(state, ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.on("turn_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		updateWidget(state, ctx);
	});

	pi.registerTool(createManageTodoListTool(state, onTodoUpdate));

	pi.registerCommand("todos", {
		description: "Toggle todo list widget or clear todos (/todos clear)",
		handler: async (args, ctx) => {
			currentCtx = ctx;

			if (args?.trim().toLowerCase() === "clear") {
				state.clear();
				clearWidget(ctx);
				ctx.ui.notify("Todo list cleared.", "info");
				return;
			}

			const todos = state.read();
			if (todos.length === 0) {
				ctx.ui.notify("No todos. The LLM will create them when working on complex tasks.", "info");
			} else {
				updateWidget(state, ctx);
				ctx.ui.notify(`${state.getStats().completed}/${state.getStats().total} todos completed.`, "info");
			}
		},
	});
}
