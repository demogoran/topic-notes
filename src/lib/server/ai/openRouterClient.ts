import { OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_APP_TITLE } from '$app/env/private';
import { writeFile } from 'fs/promises';
import { error } from '@sveltejs/kit';
import type { ChatMessage } from '#lib/server/ai/organize';
import { audioFormatFromMime, type OrganizeResult } from '#lib/server/ai/organize';
import { buildOrganizeMessages, parseOrganizeResponse, type ExistingCategory } from '#lib/server/ai/organize';
import {
	buildDetectTypeMessages,
	buildFormatMessages,
	parseDetectTypeResponse,
	parseFormatResponse
} from '#lib/server/ai/noteTypes';
import type { DetectedType, FormatResult, NoteType } from '#lib/shared/types';

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string | null } }>;
	error?: { message: string };
}

interface StreamChunk {
	choices?: Array<{ delta?: { content?: string | null } }>;
}

interface TranscribeOptions {
	audio: Buffer;
	mimeType: string;
	languageHint?: 'en' | 'uk' | null;
}

/**
 * OpenRouter plugin — thin, typed client over the chat-completions API.
 * Model ids come from env so the plugin can be re-pointed without code changes.
 */
export class OpenRouterClient {
	constructor(
		private readonly apiKey: string = OPENROUTER_API_KEY ?? '',
		private readonly baseUrl = 'https://api.neuralwatt.com/v1',//'https://openrouter.ai/api/v1',
		private readonly model = OPENROUTER_MODEL,
		private readonly appTitle = OPENROUTER_APP_TITLE
	) { }


	async organize(transcript: string, existing: ExistingCategory[]): Promise<OrganizeResult> {
		const raw = await this.chat(buildOrganizeMessages(transcript, existing));
		return parseOrganizeResponse(raw, transcript);
	}

	/** Step 1 of the capture workflow — an explicit LLM call to pick the best note type. */
	async detectType(transcript: string): Promise<DetectedType> {
		const raw = await this.chat(buildDetectTypeMessages(transcript));
		return parseDetectTypeResponse(raw);
	}

	/** Step 2 of the capture workflow — an explicit, type-specific LLM call. */
	async formatNote(transcript: string, type: NoteType): Promise<FormatResult> {
		const raw = await this.chat(buildFormatMessages(transcript, type));
		const parsed = parseFormatResponse(raw, type, transcript);
		return {
			type,
			language: parsed.language,
			text: parsed.text,
			categories: parsed.categories.map((name) => ({ name, categoryId: null })),
			todos: parsed.todos
		};
	}

	async transcribe({ audio, mimeType, languageHint }: TranscribeOptions): Promise<string> {
		const langLine =
			languageHint === 'uk'
				? 'The audio is in Ukrainian.'
				: languageHint === 'en'
					? 'The audio is in English.'
					: 'The audio is in English or Ukrainian.';

		const raw = await this.chat([
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: `Transcribe this audio recording exactly as spoken. ${langLine} Return only the transcript text.`
					},
					{
						type: 'input_audio',
						input_audio: { data: audio.toString('base64'), format: audioFormatFromMime(mimeType) }
					}
				]
			}
		]);

		console.log('transcribe response:', raw);
		return raw.trim();
	}

	/**
	 * Streaming chat for the realtime note-chat mode. Returns an async generator
	 * of plain text deltas (SSE frames from the provider are parsed server-side).
	 */
	async chatStream(messages: ChatMessage[]): Promise<AsyncGenerator<string>> {
		if (this.apiKey.length === 0) {
			throw error(503, 'AI service is not configured: set OPENROUTER_API_KEY in .env');
		}
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://voicenotes.local',
					'X-Title': this.appTitle
				},
				body: JSON.stringify({
					model: this.model,
					messages,
					temperature: 0.4,
					max_tokens: 2048,
					stream: true
				})
			});
		} catch {
			throw error(502, 'Could not reach the AI service');
		}
		if (!res.ok || !res.body) {
			const detail = await res.text().catch(() => '');
			throw error(502, `AI request failed (${res.status})${detail.slice(0, 200)}`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		return (async function* () {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE frames are separated by a blank line
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) {
					for (const line of frame.split('\n')) {
						const trimmed = line.trim();
						if (!trimmed.startsWith('data:')) continue;
						const payload = trimmed.slice(5).trim();
						if (!payload || payload === '[DONE]') continue;
						try {
							const chunk = JSON.parse(payload) as StreamChunk;
							const delta = chunk.choices?.[0]?.delta?.content;
							if (delta) yield delta;
						} catch {
							// ignore malformed keep-alive/comment frames
						}
					}
				}
			}
		})();
	}

	/** Non-streaming chat completion (exposed for simple one-shot helpers). */
	async chat(messages: ChatMessage[]): Promise<string> {
		if (this.apiKey.length === 0) {
			throw error(503, 'AI service is not configured: set OPENROUTER_API_KEY in .env');
		}
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://voicenotes.local',
					'X-Title': this.appTitle
				},
				body: JSON.stringify({
					model: this.model,
					messages,
					temperature: 0.2,
					max_tokens: 1024
				})
			});
		} catch {
			throw error(502, 'Could not reach the AI service');
		}

		const body = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
		if (!res.ok || body.error) {
			const msg = body.error?.message ?? `AI request failed (${res.status})`;
			throw error(502, msg);
		}
		const content = body.choices?.[0]?.message?.content;
		if (!content) throw error(502, 'AI returned an empty response');
		return content;
	}
}

let client: OpenRouterClient | null = null;

/** Singleton accessor (justified: stateless config holder, one instance is enough). */
export function getOpenRouter(): OpenRouterClient {
	if (!client) client = new OpenRouterClient();
	return client;
}
