import type { Handle } from '@sveltejs/kit/hooks';
import { AuthService } from '#lib/server/auth/authService';

export const authService = new AuthService();

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.auth = authService;
	event.locals.user = authService.authenticate(event.cookies); // null when anonymous
	return resolve(event);
};
