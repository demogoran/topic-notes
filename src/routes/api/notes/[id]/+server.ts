import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { NoteService } from '#lib/server/notesService';
import { isNoteType } from '#lib/shared/types';

const noteService = new NoteService();

/** GET /api/notes/:id — single note with categories */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const note = noteService.get(userId, Number(params.id));
	if (!note) throw new Response('Not found', { status: 404 });
	return json({ note });
};

/** PATCH /api/notes/:id — update text/status/type/categories/todos */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));

	const note = noteService.update(userId, Number(params.id), {
		text: typeof body.text === 'string' ? body.text : undefined,
		status: body.status === 'final' ? 'final' : body.status === 'draft' ? 'draft' : undefined,
		type: isNoteType(body.type) ? body.type : undefined,
		categories: body.categories,
		todos: body.todos
	});
	if (!note) throw new Response('Not found', { status: 404 });
	return json({ note });
};

/** DELETE /api/notes/:id */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const ok = noteService.remove(userId, Number(params.id));
	if (!ok) throw new Response('Not found', { status: 404 });
	return json({ ok: true });
};
