import { error } from '@sveltejs/kit';

/** Guard for authenticated endpoints — throws 401 when anonymous. */
export function requireUser(locals: App.Locals): { userId: number } {
	if (!locals.user) throw error(401, 'Sign in required');
	return { userId: locals.user.id };
}
