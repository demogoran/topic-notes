import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { NoteService } from '#lib/server/notesService';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { makeCategoryRepo } from '#lib/server/db/repositories';
import { buildOrganizeMessages, parseOrganizeResponse, type ExistingCategory } from '#lib/server/ai/organize';

const noteService = new NoteService();

/**
 * POST /api/notes/:id/categorize
 * Body: {} → re-runs AI categorization for an existing note and
 * auto-applies proposed categories (existing ones are linked as-is).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const noteId = Number(params.id);
	const note = noteService.get(userId, noteId);
	if (!note) throw error(404, 'Note not found');

	const existing: ExistingCategory[] = makeCategoryRepo()
		.list(userId)
		.map((c) => ({ id: c.id, name: c.name }));

	const result = await getOpenRouter().organize(note.transcript || note.text, existing);

	const finalText = result.text || note.text;
	const proposed = result.proposed.map((p) => {
		const match = existing.find(
			(c) => c.name.toLowerCase() === p.name.toLowerCase()
		);
		return { name: p.name, categoryId: match?.id ?? null };
	});

	const updated = noteService.update(userId, noteId, {
		text: finalText,
		status: 'final',
		categories: proposed.map((p) => p.name)
	});

	return json({ note: updated, proposed });
};
