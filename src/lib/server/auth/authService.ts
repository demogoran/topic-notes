import { error, type Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { generateSessionToken, hashPassword, verifyPassword } from '#lib/server/auth/password';
import { makeSessionRepo, makeUserRepo, rowToUser } from '#lib/server/db/repositories';
import type { PublicUser } from '#lib/shared/types';

export const SESSION_COOKIE = 'vn_session';

export function sessionTtlMs(): number {
	return Number(env.SESSION_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000;
}

/**
 * Application service for email+password accounts and cookie sessions.
 * Owns all session-cookie writes — endpoints stay thin (DRY).
 */
export class AuthService {
	private users = makeUserRepo();
	private sessions = makeSessionRepo();

	/** Register a new account (idempotency is protected by the unique email index). */
	async register(email: string, password: string): Promise<PublicUser> {
		const normalized = email.trim().toLowerCase();
		if (this.users.findByEmail(normalized)) {
			throw error(409, 'An account with this email already exists');
		}
		const hash = await hashPassword(password);
		const user = this.users.create(normalized, hash);
		return this.issueSession(user.id, user.email);
	}

	async login(email: string, password: string): Promise<PublicUser> {
		const normalized = email.trim().toLowerCase();
		const user = this.users.findByEmail(normalized);
		// uniform error + dummy compare → no user-enumeration oracle
		const ok = user ? await verifyPassword(password, user.passwordHash) : false;
		if (!user || !ok) throw error(401, 'Invalid email or password');
		return this.issueSession(user.id, user.email);
	}

	logout(token: string | undefined): void {
		if (token) this.sessions.delete(token);
	}

	/** Resolve the current user from the session cookie. Returns null when anonymous. */
	authenticate(cookies: Cookies): PublicUser | null {
		const token = cookies.get(SESSION_COOKIE);
		if (!token) return null;
		const session = this.sessions.find(token);
		if (!session) return null;
		const user = this.users.findById(session.userId);
		return user ? { id: user.id, email: user.email } : null;
	}

	private issueSession(userId: number, email: string): PublicUser {
		const token = generateSessionToken();
		this.sessions.create(userId, token, sessionTtlMs());
		// token piggybacks on the returned object so callers can set the cookie once
		return { id: userId, email, token };
	}
}

export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: Math.floor(sessionTtlMs() / 1000)
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
}
