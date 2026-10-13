import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { SONIOX_API_KEY } from '$app/env/private';

/**
 * POST /api/soniox-temp-key
 * Issues a short-lived Soniox API key for the browser's WebSocket session,
 * so the real SONIOX_API_KEY never ships to the client.
 */
export const POST: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	if (!SONIOX_API_KEY) throw error(503, 'Soniox is not configured: set SONIOX_API_KEY in .env');

	let res: Response;
	try {
		res = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SONIOX_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300 })
		});
	} catch {
		throw error(502, 'Could not reach the Soniox service');
	}

	const body = (await res.json().catch(() => ({}))) as {
		api_key?: string;
		expires_at?: string;
		message?: string;
	};
	if (!res.ok || !body.api_key) {
		throw error(502, body.message ?? `Soniox key request failed (${res.status})`);
	}
	return json({ api_key: body.api_key, expires_at: body.expires_at ?? null });
};
