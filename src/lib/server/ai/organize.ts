/**
 * Pure (side-effect free) helpers shared by server AI flows and testable in isolation.
 */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content:
		| string
		| Array<
				| { type: 'text'; text: string }
				| { type: 'input_audio'; input_audio: { data: string; format: string } }
		  >;
}

export interface ExistingCategory {
	id: number;
	name: string;
}

export interface OrganizeResult {
	language: 'en' | 'uk';
	text: string;
	proposed: { name: string }[];
}

const SYSTEM_PROMPT = `You are a precise note-organizing engine inside a voice-notes mobile app.
You receive a raw speech-to-text transcript (English or Ukrainian, possibly with recognition errors).
Your job:
1. Return the note text: lightly cleaned for readability (fix recognition slips, add punctuation), keep the author's voice and meaning. Do NOT answer, comment, or add content.
2. Detect the note language ("en" or "uk").
3. Propose 1-3 short category labels (1-3 words each) that best organize the note. Use the note's language for labels. Prefer reusing one of the user's existing categories when it fits.
Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"language":"en|uk","text":"<cleaned note>","categories":["<label>","<label>"]}`;

/** Builds the categorization chat payload from a transcript (pure). */
export function buildOrganizeMessages(
	transcript: string,
	existing: ExistingCategory[]
): ChatMessage[] {
	const list = existing.length
		? existing.map((c) => `- ${c.name}`).join('\n')
		: '(the user has no categories yet — feel free to propose new ones)';
	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{
			role: 'user',
			content: `User's existing categories:\n${list}\n\nTranscript:\n"""${transcript}"""`
		}
	];
}

/** Extracts the first JSON object from a model response (pure, tolerant). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const asStringArray = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Normalizes a category label: trimmed, single-spaced, ≤48 chars, non-empty (pure). */
export function normalizeCategoryName(raw: string): string | null {
	const name = raw.replace(/\s+/g, ' ').trim().slice(0, 48);
	return name.length >= 1 ? name : null;
}

/** Maps a model response to an OrganizeResult (pure). Throws on unusable output. */
export function parseOrganizeResponse(raw: string, fallbackText: string): OrganizeResult {
	const obj = extractJsonObject(raw);
	if (!obj) throw new Error('Model returned no JSON object');

	const text = typeof obj.text === 'string' && obj.text.trim() ? obj.text.trim() : fallbackText;
	const lang = obj.language === 'uk' ? 'uk' : 'en';

	const proposed = asStringArray(obj.categories)
		.map(normalizeCategoryName)
		.filter((n): n is string => n !== null);

	return { language: lang, text, proposed: [...new Set(proposed)].slice(0, 5).map((name) => ({ name })) };
}

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function audioFormatFromMime(mime: string): string {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('ogg')) return 'ogg';
	if (mime.includes('wav')) return 'wav';
	if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
	if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
	return 'webm';
}
