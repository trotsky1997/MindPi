/**
 * In-process replacement for pi-acp's PiRpcProcess.
 *
 * pi-acp originally spawned `pi --mode rpc` as a child process and spoke a
 * newline-delimited JSON-RPC protocol to it. Running ACP natively inside pi, we
 * instead drive the in-process AgentSession directly: this class exposes the
 * exact same public surface PiRpcProcess had (spawn/onEvent/dispose/
 * consumePreludeLines + the per-command methods), but each method calls the
 * AgentSession (or its runtime) and events are forwarded from
 * `session.subscribe`. No subprocess, no NDJSON.
 *
 * The ACP mode entry installs a runtime provider via `setAcpRuntimeProvider`
 * before any session is created. Each `spawn({ cwd })` obtains an
 * AgentSessionRuntime for that cwd from the provider.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";

export class PiRpcSpawnError extends Error {
	code?: string;
	constructor(message: string, opts?: { code?: string; cause?: unknown }) {
		super(message);
		this.name = "PiRpcSpawnError";
		this.code = opts?.code;
		(this as { cause?: unknown }).cause = opts?.cause;
	}
}

export type PiRpcEvent = Record<string, unknown>;

export interface AcpRuntimeProvider {
	/**
	 * Create or obtain an AgentSessionRuntime for the given working directory.
	 * `sessionPath`, when provided, asks the runtime to open/persist that exact
	 * session file (mirrors pi --session <path>).
	 */
	createRuntime(params: { cwd: string; sessionPath?: string }): Promise<AgentSessionRuntime>;
}

let runtimeProvider: AcpRuntimeProvider | undefined;

/** Install the provider that backs in-process ACP sessions. Called by the ACP mode entry. */
export function setAcpRuntimeProvider(provider: AcpRuntimeProvider): void {
	runtimeProvider = provider;
}

type SpawnParams = {
	cwd: string;
	piCommand?: string;
	sessionPath?: string;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export class PiRpcProcess {
	private readonly runtime: AgentSessionRuntime;
	private eventHandlers: Array<(ev: PiRpcEvent) => void> = [];
	private unsubscribe?: () => void;
	private disposed = false;

	private constructor(runtime: AgentSessionRuntime) {
		this.runtime = runtime;
		this.attach(runtime.session);
		// Re-subscribe when the runtime rebinds to a new session (fork/switch).
		runtime.setRebindSession(async (session: AgentSession) => {
			this.attach(session);
		});
	}

	private attach(session: AgentSession): void {
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => {
			// AgentSessionEvent is structurally the PiRpcEvent pi-acp consumes
			// (rpc-mode serialized these verbatim).
			const ev = event as unknown as PiRpcEvent;
			for (const h of this.eventHandlers) h(ev);
		});
	}

	private get session(): AgentSession {
		return this.runtime.session;
	}

	static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
		if (!runtimeProvider) {
			throw new PiRpcSpawnError("ACP runtime provider not installed (internal error)");
		}
		let runtime: AgentSessionRuntime;
		try {
			runtime = await runtimeProvider.createRuntime({ cwd: params.cwd, sessionPath: params.sessionPath });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw new PiRpcSpawnError(`Could not start pi session: ${message}`, { cause: e });
		}
		return new PiRpcProcess(runtime);
	}

	onEvent(handler: (ev: PiRpcEvent) => void): () => void {
		this.eventHandlers.push(handler);
		return () => {
			this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
		};
	}

	dispose(_signal: NodeJS.Signals | number = "SIGTERM"): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		try {
			void this.runtime.dispose();
		} catch {
			// ignore
		}
	}

	/** In-process there is no human-readable stdout prelude. */
	consumePreludeLines(): string[] {
		return [];
	}

	async prompt(message: string, images: unknown[] = []): Promise<void> {
		await this.session.prompt(message, {
			images: images as never,
			source: "rpc",
		});
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async getState(): Promise<unknown> {
		const s = this.session;
		return {
			model: s.model,
			thinkingLevel: s.thinkingLevel,
			isStreaming: s.isStreaming,
			isCompacting: s.isCompacting,
			steeringMode: s.steeringMode,
			followUpMode: s.followUpMode,
			sessionFile: s.sessionFile,
			sessionId: s.sessionId,
			sessionName: s.sessionName,
			autoCompactionEnabled: s.autoCompactionEnabled,
			messageCount: s.messages.length,
			pendingMessageCount: s.pendingMessageCount,
		};
	}

	async getAvailableModels(): Promise<unknown> {
		const models = await this.session.modelRegistry.getAvailable();
		return { models };
	}

	async setModel(provider: string, modelId: string): Promise<unknown> {
		const models = await this.session.modelRegistry.getAvailable();
		const model = models.find((m) => m.provider === provider && m.id === modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await this.session.setModel(model);
		return model;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(level);
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.session.setFollowUpMode(mode);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.session.setSteeringMode(mode);
	}

	async compact(customInstructions?: string): Promise<unknown> {
		return this.session.compact(customInstructions);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		this.session.setAutoCompactionEnabled(enabled);
	}

	async getSessionStats(): Promise<unknown> {
		return this.session.getSessionStats();
	}

	async setSessionName(name: string): Promise<void> {
		this.session.setSessionName(name);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const path = await this.session.exportToHtml(outputPath);
		return { path };
	}

	async switchSession(sessionPath: string): Promise<void> {
		await this.runtime.switchSession(sessionPath);
	}

	async getMessages(): Promise<unknown> {
		return { messages: this.session.messages };
	}

	async getCommands(): Promise<unknown> {
		const commands: Array<{ name: string; description?: string; source: string; sourceInfo?: unknown }> = [];
		for (const command of this.session.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			});
		}
		for (const template of this.session.promptTemplates) {
			commands.push({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			});
		}
		for (const skill of this.session.resourceLoader.getSkills().skills) {
			commands.push({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			});
		}
		return { commands };
	}
}

/** Mirrors pi-acp/src/pi-rpc/command.ts — retained for API compatibility. */
export function getPiCommand(override?: string): string {
	return override ?? "pi";
}

export function shouldUseShellForPiCommand(_cmd: string): boolean {
	return false;
}
