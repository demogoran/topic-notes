import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { getOpenRouter } from '#lib/server/ai/openRouterClient';
import { MAX_AUDIO_BYTES } from '#lib/server/ai/organize';
import { parseAudioMeta } from '#lib/server/db/audioStore';

/**
 * POST /api/transcribe  (multipart/form-data)
 * fields: audio: File, durationSec?: string
 * Returns the raw transcript text.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const form = await request.formData();
	const meta = parseAudioMeta(form);
	if (!meta) throw error(400, 'No audio file received');
	if (meta.bytes > MAX_AUDIO_BYTES) throw error(413, 'Recording is too large (max ~20 MB)');

	const file = form.get('audio') as File;
	const audio = Buffer.from(await file.arrayBuffer());

	const text = await getOpenRouter().transcribe({
		audio,
		mimeType: meta.mimeType,
		languageHint: null
	});
	return json({ transcript: text });
};
