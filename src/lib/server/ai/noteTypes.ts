/**
 * Explicit two-step capture workflow (pure helpers, testable in isolation):
 *   1. `detect-type` — an explicit LLM call that picks the best note type.
 *   2. `format`      — a separate explicit LLM call, with a type-specific prompt,
 *                      that shapes the transcript into that type's format.
 */
import type { NoteType } from '#lib/shared/types';
import { isNoteType } from '#lib/shared/types';
import type { NoteTypeInfo } from '#lib/shared/types';
import type { ChatMessage } from './organize';
import { extractJsonObject } from './organize';

export type { NoteTypeInfo };

// ---------- step 1: detect type (explicit call) ----------

/** All types offered to the user during capture (AI pick is highlighted in the UI). */
export const NOTE_TYPE_INFO: NoteTypeInfo[] = [
	{ type: 'text', label: 'Plain note', description: 'Cleaned-up voice note, as written.' },
	{ type: 'todo', label: 'Todolist', description: 'Checklist with tasks, each with its own tags.' },
	{ type: 'prompt', label: 'Refined prompt', description: 'Turn the note into a full detailed AI prompt.' },
	{ type: 'summary', label: 'Summary', description: 'Condensed summary of the voice note.' }
];

// ---------- step 1: detect type (explicit call) ----------

const DETECT_TYPE_SYSTEM = `You are a note-type classifier inside a voice-notes mobile app.
You receive a raw speech-to-text transcript (English or Ukrainian).
Pick the single best type for it:
- "todo": the speaker lists tasks, errands, things to buy/do, or a checklist.
- "prompt": the speaker wants to create an AI prompt (asks to write/produce a prompt, or describes a request clearly intended as instructions to an AI).
- "summary": the speaker rambles, tells a long story, records a meeting/lecture, or the content is clearly long and benefits from condensing.
- "text": everything else (a normal short note).
Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"type":"text|todo|prompt|summary","reason":"<one short sentence why, in the transcript's language>"}`;

/** Builds the chat payload for the explicit type-detection call (pure). */
export function buildDetectTypeMessages(transcript: string): ChatMessage[] {
	return [
		{ role: 'system', content: DETECT_TYPE_SYSTEM },
		{ role: 'user', content: `Transcript:\n"""${transcript}"""` }
	];
}

/** Maps the detect-type response (pure). Throws on unusable output. */
export function parseDetectTypeResponse(raw: string): { type: NoteType; reason: string } {
	const obj = extractJsonObject(raw);
	if (!obj) throw new Error('Model returned no JSON object');
	if (!isNoteType(obj.type)) throw new Error('Model returned an unknown note type');
	const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim().slice(0, 200) : '';
	return { type: obj.type, reason };
}

// ---------- step 2: type-specific formatting (explicit call) ----------

const FORMAT_COMMON = `You receive a raw speech-to-text transcript (English or Ukrainian, possibly with recognition errors).
Detect the note language ("en" or "uk") and use it for all output.
Propose 1-3 short category labels (1-3 words each, in the note's language) that organize the note.
Respond with ONLY a JSON object, no markdown fences.`;

const FORMAT_TEXT_SYSTEM = `${FORMAT_COMMON}
Shape: {"language":"en|uk","text":"<cleaned note>","categories":["<label>"]}
The text is lightly cleaned for readability (fix recognition slips, add punctuation); keep the author's voice. Do NOT answer or add content.`;

const FORMAT_TODO_SYSTEM = `${FORMAT_COMMON}
Shape: {"language":"en|uk","title":"<short list title>","items":[{"text":"<task>","done":false,"tags":["<tag>","<tag>"]}],"categories":["<label>"]}
Extract every task as a checklist item. Each item gets 0-3 short tags (1-2 words each, in the note's language) describing its area (e.g. Health, Home, Work, Shopping). Tags may repeat across items. "done" is false unless the transcript says the task is already finished.`;

const FORMAT_PROMPT_SYSTEM = `${FORMAT_COMMON}
Shape: {"language":"en|uk","prompt":"<the refined prompt>","categories":["<label>"]}
You are a prompt-refiner: turn the speaker's raw note into ONE full, detailed, ready-to-use prompt for an AI assistant. Expand implied context, add missing specifics as reasonable assumptions, structure it with clear sections (role, task, constraints, output format) where useful, all in the note's language. Output only the prompt itself in "prompt".`;

const FORMAT_SUMMARY_SYSTEM = `${FORMAT_COMMON}
Shape: {"language":"en|uk","summary":"<the summary>","categories":["<label>"]}
Condense the transcript into a clear summary: 3-8 bullet-like short paragraphs or lines (plain text, one idea per line, prefix each line with "- "), capturing key points, decisions and action items. Keep the note's language.`;

const FORMAT_SYSTEMS: Record<NoteType, string> = {
	text: FORMAT_TEXT_SYSTEM,
	todo: FORMAT_TODO_SYSTEM,
	prompt: FORMAT_PROMPT_SYSTEM,
	summary: FORMAT_SUMMARY_SYSTEM
};

/** Builds the chat payload for the explicit type-specific formatting call (pure). */
export function buildFormatMessages(transcript: string, type: NoteType): ChatMessage[] {
	return [
		{ role: 'system', content: FORMAT_SYSTEMS[type] },
		{ role: 'user', content: `Transcript:\n"""${transcript}"""` }
	];
}

const asStringArray = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Parses the type-specific response into a uniform FormatResult (pure). Throws on unusable output. */
export function parseFormatResponse(
	raw: string,
	type: NoteType,
	fallbackTranscript: string
): { language: 'en' | 'uk'; text: string; categories: string[]; todos: { text: string; done: boolean; tags: string[] }[] } {
	const obj = extractJsonObject(raw);
	if (!obj) throw new Error('Model returned no JSON object');

	const language = obj.language === 'uk' ? 'uk' : 'en';
	const categories = [...new Set(asStringArray(obj.categories).map((c) => c.trim()).filter(Boolean))].slice(0, 5);

	if (type === 'todo') {
		const items = Array.isArray(obj.items) ? obj.items : [];
		const todos = items
			.map((it) => {
				const o = it as Record<string, unknown>;
				const text = typeof o.text === 'string' ? o.text.trim().slice(0, 500) : '';
				return {
					text,
					done: o.done === true,
					tags: asStringArray(o.tags).map((t) => t.trim()).filter(Boolean).slice(0, 5)
				};
			})
			.filter((t) => t.text.length > 0)
			.slice(0, 100);
		const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 200) : fallbackTranscript.slice(0, 200);
		return { language, text: title, categories, todos };
	}

	const key = type === 'prompt' ? 'prompt' : type === 'summary' ? 'summary' : 'text';
	const text = typeof obj[key] === 'string' && (obj[key] as string).trim() ? (obj[key] as string).trim() : fallbackTranscript;
	return { language, text: text.slice(0, 8000), categories, todos: [] };
}
