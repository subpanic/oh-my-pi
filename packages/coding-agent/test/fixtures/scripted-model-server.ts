/**
 * Deterministic OpenAI-compatible SSE server for tests that must drive a real
 * child agent without an external model.
 *
 * The caller supplies the reply policy; this fixture only owns the wire shape
 * (`/v1/chat/completions`, streamed chunks, a final usage frame) and a generated
 * `models.yml` so a worker's mirrored model registry can discover it.
 */
import * as path from "node:path";

export interface ScriptedChatMessage {
	role: string;
	content?: unknown;
}

export interface ScriptedToolCall {
	name: string;
	args: Record<string, unknown>;
}

export type ScriptedReply = { text: string } | { tools: ScriptedToolCall[] } | { hold: true };

export interface ScriptedRequest {
	messages: ScriptedChatMessage[];
	/** Non-tool message text joined for easy marker checks. */
	systemText: string;
	lastUserText: string;
	/** Tool names the provider was offered in this request. */
	toolNames: string[];
	/** Text of every tool-result message, in order. */
	toolTexts: string[];
	/** Tool-result texts at the end of the conversation: the current turn's results only. */
	lastToolTexts: string[];
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function isChatMessage(value: unknown): value is ScriptedChatMessage {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "role") === "string";
}

function chunks(reply: ScriptedReply): string {
	const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: "scripted-model" };
	const calls = "tools" in reply ? reply.tools : undefined;
	const delta =
		calls === undefined
			? { role: "assistant", content: "text" in reply ? reply.text : "held" }
			: {
					role: "assistant",
					tool_calls: calls.map((call, index) => ({
						index,
						id: `call_${index}_${call.name}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.args) },
					})),
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls === undefined ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

export class ScriptedModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #reply: (request: ScriptedRequest) => ScriptedReply;
	#held = Promise.withResolvers<void>();
	#heldStop: (() => void) | undefined;

	constructor(reply: (request: ScriptedRequest) => ScriptedReply) {
		this.#reply = reply;
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	/** Resolves once a `hold` reply is waiting for the caller to abort; reset after it settles. */
	held(): Promise<void> {
		return this.#held.promise;
	}

	/** End a held request early (a stand-in for the client closing the stream). */
	releaseHeld(): void {
		this.#heldStop?.();
	}

	/** Write the `models.yml` a worker's model-registry mirror reads to discover this server. */
	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  scripted:",
				`    baseUrl: http://127.0.0.1:${this.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: scripted-model",
				"        name: Scripted Model",
				"        reasoning: false",
				"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({
				object: "list",
				data: [{ id: "scripted-model", object: "model", owned_by: "scripted" }],
			});
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const rawTools: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "tools") : undefined;
		const toolNames = Array.isArray(rawTools)
			? rawTools.flatMap(tool => {
					if (typeof tool !== "object" || tool === null) return [];
					const fn: unknown = Reflect.get(tool, "function");
					const resolved =
						typeof fn === "object" && fn !== null ? Reflect.get(fn, "name") : Reflect.get(tool, "name");
					return typeof resolved === "string" ? [resolved] : [];
				})
			: [];
		const lastUser = messages.findLast(message => message.role === "user");
		const lastToolTexts: string[] = [];
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "tool") break;
			lastToolTexts.unshift(messageText(message.content));
		}
		const reply = this.#reply({
			messages,
			systemText: messages
				.filter(message => message.role === "system" || message.role === "developer")
				.map(message => messageText(message.content))
				.join("\n"),
			lastUserText: lastUser ? messageText(lastUser.content) : "",
			toolNames,
			toolTexts: messages.filter(message => message.role === "tool").map(message => messageText(message.content)),
			lastToolTexts,
		});
		if ("hold" in reply) {
			this.#held.resolve();
			const stopped = Promise.withResolvers<void>();
			this.#heldStop = () => stopped.resolve();
			if (request.signal.aborted) stopped.resolve();
			else request.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
			await stopped.promise;
			this.#heldStop = undefined;
			this.#held = Promise.withResolvers<void>();
			return new Response(chunks({ text: "held" }), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}
}
