import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { makeChatRepo } from '#lib/server/db/repositories';
import { NoteService } from '#lib/server/notesService';
import type { ChatMessage } from '#lib/server/ai/organize';
import type { NoteType } from '#lib/shared/types';

const noteService = new NoteService();

const MAX_HISTORY = 24;

const CHAT_SYSTEM = `You are a friendly assistant inside a voice-notes mobile app, chatting with the user about one of their notes.
Ground your answers in the note content; if the user asks something the note does not cover, say so briefly and answer generally.
Be concise, match the user's language. When the note is a refined AI prompt, you may also improve or iterate on the prompt on request.`;

function buildChatMessages(
	noteType: NoteType,
	noteText: string,
	noteTranscript: string,
	history: { role: 'user' | 'assistant'; content: string }[],
	newMessage: string
): ChatMessage[] {
	const typeLine =
		noteType === 'prompt'
			? 'The note is a refined AI prompt.'
			: noteType === 'summary'
				? 'The note is a summary of a voice recording.'
				: 'The note is a plain text note.';
	const notes: ChatMessage[] = [
		{ role: 'system', content: CHAT_SYSTEM },
		{
			role: 'system',
			content: `${typeLine}\nNote text:\n"""${noteText.slice(0, 6000)}"""\nOriginal voice transcript:\n"""${noteTranscript.slice(0, 2000)}"""`
		}
	];
	for (const m of history.slice(-MAX_HISTORY)) {
		notes.push({ role: m.role, content: m.content });
	}
	notes.push({ role: 'user', content: newMessage });
	return notes;
}

/** GET /api/notes/:id/chat — persisted conversation history. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const noteId = Number(params.id);
	if (!Number.isInteger(noteId) || !noteService.get(userId, noteId)) {
		throw error(404, 'Note not found');
	}
	return json({ messages: makeChatRepo().listForNote(userId, noteId) });
};

/**
 * POST /api/notes/:id/chat — send a message, stream the assistant reply back
 * as SSE: `data: {"delta":"..."}` frames, ending with `data: [DONE]`.
 * Both the user message and the full reply are persisted.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const { userId } = requireUser(locals);
	const noteId = Number(params.id);
	const note = noteService.get(userId, noteId);
	if (!note) throw error(404, 'Note not found');

	const body = await request.json().catch(() => ({}));
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (message.length === 0) throw error(400, 'Message is required');

	const repo = makeChatRepo();
	const history = repo.listForNote(userId, noteId);
	const messages = buildChatMessages(note.type, note.text, note.transcript, history, message);

	repo.add(userId, noteId, 'user', message);

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			let full = '';
			try {
				for await (const delta of await getOpenRouter().chatStream(messages)) {
					full += delta;
					send(JSON.stringify({ delta }));
				}
			} catch {
				if (!full) send(JSON.stringify({ error: 'The AI service failed to answer' }));
			}
			if (full.trim()) {
				repo.add(userId, noteId, 'assistant', full);
			}
			send('[DONE]');
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};

/** DELETE /api/notes/:id/chat — clear the conversation. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	makeChatRepo().clear(userId, Number(params.id));
	return json({ ok: true });
};
