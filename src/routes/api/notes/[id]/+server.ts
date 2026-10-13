import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { NoteService } from '#lib/server/notesService';

const noteService = new NoteService();

/** GET /api/notes/:id — single note with categories */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const note = noteService.get(userId, Number(params.id));
	if (!note) throw new Response('Not found', { status: 404 });
	return json({ note });
};

/** PATCH /api/notes/:id — update text/status/categories */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));

	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) {
		return json({ errors: [{ field: 'text', message: 'Note text is required' }] }, { status: 400 });
	}

	const note = noteService.updateText(userId, Number(params.id), {
		text,
		status: body.status === 'final' ? 'final' : 'draft',
		categories: body.categories
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
