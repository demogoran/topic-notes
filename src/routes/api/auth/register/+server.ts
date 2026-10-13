import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setSessionCookie } from '#lib/server/auth/authService';
import { validateRegistration } from '#lib/server/validators';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	const body = await request.json().catch(() => ({}));
	const errors = validateRegistration(body.email, body.password);
	if (errors.length > 0) return json({ errors }, { status: 400 });

	const user = await locals.auth.register(body.email, body.password);
	setSessionCookie(cookies, user.token!);
	return json({ user: { id: user.id, email: user.email } });
};
