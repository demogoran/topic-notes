import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { NOTE_TYPE_INFO } from '#lib/server/ai/noteTypes';

/**
 * POST /api/notes/detect-type
 * Explicit AI step 1: pick the best note type for a transcript.
 * Body: { transcript: string }
 * Returns { type, reason, types } — `types` is the full list offered to the user
 * (the client highlights `type` as the AI proposal).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
	if (transcript.length === 0) throw error(400, 'Transcript is required');

	const { type, reason } = await getOpenRouter().detectType(transcript);
	return json({ type, reason, types: NOTE_TYPE_INFO });
};
