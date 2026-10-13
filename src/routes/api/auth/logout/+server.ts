import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSessionCookie, SESSION_COOKIE } from '#lib/server/auth/authService';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	locals.auth.logout(cookies.get(SESSION_COOKIE));
	clearSessionCookie(cookies);
	return json({ ok: true });
};
