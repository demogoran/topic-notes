import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { buildAdjustMessages } from '#lib/server/ai/noteTypes';

/**
 * POST /api/notes/adjust
 * AI helper: adjusts an existing draft text (voice helper alternative to manual
 * editing). Body: { text: string, instruction?: string }
 * Returns { text } — the adjusted text.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) throw error(400, 'Text is required');
	const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 500) : undefined;

	const raw = await getOpenRouter().chat(buildAdjustMessages(text.slice(0, 8000), instruction));
	const adjusted = raw.trim().replace(/^"""|"""$/g, '').trim();
	if (!adjusted) throw error(502, 'AI returned an empty response');
	return json({ text: adjusted.slice(0, 8000) });
};
