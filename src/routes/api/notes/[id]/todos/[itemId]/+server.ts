import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { NoteService } from '#lib/server/notesService';

const noteService = new NoteService();

/**
 * PATCH /api/notes/:id/todos/:itemId — toggle a checklist item's done state.
 * Returns the updated item (with its tags).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const item = noteService.toggleTodo(userId, Number(params.id), Number(params.itemId), body.done === true);
	if (!item) throw error(404, 'Task not found');
	return json({ item });
};

/** DELETE /api/notes/:id/todos/:itemId — remove one task from a checklist. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const ok = noteService.removeTodo(userId, Number(params.id), Number(params.itemId));
	if (!ok) throw error(404, 'Task not found');
	return json({ ok: true });
};
