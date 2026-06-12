import { describe, expect, it } from "vitest";
import { PiRpcProcess, setAcpRuntimeProvider } from "../../src/modes/acp/pi-rpc-inprocess.ts";

// Build a stub AgentSession exposing the getters/methods the adapter reads.
function makeStubSession(overrides: Record<string, unknown> = {}) {
	const listeners: Array<(e: unknown) => void> = [];
	return {
		listeners,
		model: { provider: "openai", id: "m1" },
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionFile: "/tmp/s.jsonl",
		sessionId: "sess-1",
		sessionName: "My Session",
		autoCompactionEnabled: true,
		messages: [{ role: "user", content: "hi" }],
		pendingMessageCount: 0,
		modelRegistry: {
			getAvailable: async () => [{ provider: "openai", id: "m1" }],
		},
		extensionRunner: {
			getRegisteredCommands: () => [{ invocationName: "doit", description: "Do it", sourceInfo: { kind: "ext" } }],
		},
		promptTemplates: [{ name: "tmpl", description: "A template", sourceInfo: { kind: "prompt" } }],
		resourceLoader: {
			getSkills: () => ({ skills: [{ name: "review", description: "Review", sourceInfo: { kind: "skill" } }] }),
		},
		subscribe(fn: (e: unknown) => void) {
			listeners.push(fn);
			return () => {};
		},
		...overrides,
	};
}

function makeStubRuntime(session: ReturnType<typeof makeStubSession>) {
	return {
		session,
		setRebindSession(_fn: unknown) {},
		dispose() {},
	};
}

async function spawnWithSession(session: ReturnType<typeof makeStubSession>): Promise<PiRpcProcess> {
	setAcpRuntimeProvider({
		createRuntime: async () => makeStubRuntime(session) as never,
	});
	return PiRpcProcess.spawn({ cwd: "/tmp" });
}

describe("PiRpcProcess in-process adapter", () => {
	it("getState mirrors AgentSession getters", async () => {
		const proc = await spawnWithSession(makeStubSession());
		const state = (await proc.getState()) as Record<string, unknown>;
		expect(state.sessionId).toBe("sess-1");
		expect(state.sessionName).toBe("My Session");
		expect(state.thinkingLevel).toBe("off");
		expect(state.messageCount).toBe(1);
		expect(state.autoCompactionEnabled).toBe(true);
		proc.dispose();
	});

	it("getAvailableModels wraps the registry list", async () => {
		const proc = await spawnWithSession(makeStubSession());
		const res = (await proc.getAvailableModels()) as { models: unknown[] };
		expect(res.models).toHaveLength(1);
		proc.dispose();
	});

	it("getMessages returns the session messages", async () => {
		const proc = await spawnWithSession(makeStubSession());
		const res = (await proc.getMessages()) as { messages: unknown[] };
		expect(res.messages).toHaveLength(1);
		proc.dispose();
	});

	it("getCommands aggregates extension, prompt, and skill commands", async () => {
		const proc = await spawnWithSession(makeStubSession());
		const res = (await proc.getCommands()) as { commands: Array<{ name: string; source: string }> };
		const byName = Object.fromEntries(res.commands.map((c) => [c.name, c.source]));
		expect(byName.doit).toBe("extension");
		expect(byName.tmpl).toBe("prompt");
		expect(byName["skill:review"]).toBe("skill");
		proc.dispose();
	});

	it("forwards subscribed session events to onEvent handlers", async () => {
		const session = makeStubSession();
		const proc = await spawnWithSession(session);
		const received: unknown[] = [];
		proc.onEvent((e) => received.push(e));
		// Emit through the stub's subscribe channel (as AgentSession would).
		for (const l of session.listeners) l({ type: "agent_start" });
		expect(received).toEqual([{ type: "agent_start" }]);
		proc.dispose();
	});

	it("setModel throws when the model is not available", async () => {
		const proc = await spawnWithSession(makeStubSession());
		await expect(proc.setModel("openai", "nonexistent")).rejects.toThrow(/Model not found/);
		proc.dispose();
	});
});
