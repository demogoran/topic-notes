import { OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_APP_TITLE } from '$app/env/private';
import { writeFile } from 'fs/promises';
import { error } from '@sveltejs/kit';
import type { ChatMessage } from '#lib/server/ai/organize';
import { audioFormatFromMime, type OrganizeResult } from '#lib/server/ai/organize';
import { buildOrganizeMessages, parseOrganizeResponse, type ExistingCategory } from '#lib/server/ai/organize';

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string | null } }>;
	error?: { message?: string };
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

	private async chat(messages: ChatMessage[]): Promise<string> {
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
