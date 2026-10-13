import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { makeCategoryRepo } from '#lib/server/db/repositories';
import type { ExistingCategory } from '#lib/server/ai/organize';

/**
 * POST /api/organize
 * Body: { transcript: string }
 * Returns cleaned text + language + proposed categories.
 * When `noteId` is provided the result is applied to that note.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
	if (transcript.length === 0) throw error(400, 'Transcript is required');

	const existing: ExistingCategory[] = makeCategoryRepo()
		.list(userId)
		.map((c) => ({ id: c.id, name: c.name }));

	const result = await getOpenRouter().organize(transcript, existing);
	const proposed = result.proposed.map((p) => {
		const match = existing.find((c) => c.name.toLowerCase() === p.name.toLowerCase());
		return { name: p.name, categoryId: match?.id ?? null };
	});

	const noteId = Number(body.noteId);
	if (Number.isInteger(noteId) && noteId > 0) {
		const { NoteService } = await import('#lib/server/notesService');
		const updated = await new NoteService().updateText(userId, noteId, {
			text: result.text,
			status: 'final',
			categories: result.proposed.map((p) => p.name)
		});
		return json({ note: updated, proposed });
	}

	return json({ text: result.text, language: result.language, proposed });
};
