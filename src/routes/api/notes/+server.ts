import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { NoteService } from '#lib/server/notesService';
import { isNoteType } from '#lib/shared/types';

const noteService = new NoteService();

export const GET: RequestHandler = async ({ locals, url }) => {
	const { userId } = requireUser(locals);
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 100);
	const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
	return json({ notes: noteService.list(userId, limit, offset) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));

	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) {
		return json({ errors: [{ field: 'text', message: 'Note text is required' }] }, { status: 400 });
	}

	const note = noteService.create(userId, {
		text,
		transcript: typeof body.transcript === 'string' ? body.transcript : '',
		audioDb: null,
		status: body.status === 'final' ? 'final' : 'draft',
		type: isNoteType(body.type) ? body.type : 'text',
		categories: body.categories,
		todos: body.todos
	});
	return json({ note }, { status: 201 });
};
