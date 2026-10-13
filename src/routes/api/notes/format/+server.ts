import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { makeCategoryRepo } from '#lib/server/db/repositories';
import type { NoteType } from '#lib/shared/types';
import { isNoteType } from '#lib/shared/types';

/**
 * POST /api/notes/format
 * Explicit AI step 2: shape the transcript into the user-selected note type
 * with a type-specific prompt.
 * Body: { transcript: string, type: NoteType }
 * Returns { type, language, text, categories, todos } (todos only for `todo`).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
	if (transcript.length === 0) throw error(400, 'Transcript is required');
	if (!isNoteType(body.type)) throw error(400, 'A valid note type is required');
	const type = body.type as NoteType;

	const result = await getOpenRouter().formatNote(transcript, type);

	// resolve AI-proposed category names against the user's existing ones
	const existing = makeCategoryRepo().list(userId);
	const categories = result.categories.map((p) => ({
		name: p.name,
		categoryId: existing.find((c) => c.name.toLowerCase() === p.name.toLowerCase())?.id ?? null
	}));

	return json({
		type,
		language: result.language,
		text: result.text,
		categories,
		todos: result.todos
	});
};
