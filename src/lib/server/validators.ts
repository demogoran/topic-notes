/** Pure, dependency-free validation helpers (returns plain errors — no framework imports). */

export type ValidationError = { field: string; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(
	email: unknown,
	password: unknown
): ValidationError[] {
	const errors: ValidationError[] = [];
	if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
		errors.push({ field: 'email', message: 'Enter a valid email address' });
	}
	errors.push(...validatePassword(password));
	return errors;
}

export function validatePassword(password: unknown): ValidationError[] {
	if (typeof password !== 'string' || password.length < 8) {
		return [{ field: 'password', message: 'Password must be at least 8 characters' }];
	}
	if (password.length > 200) {
		return [{ field: 'password', message: 'Password is too long' }];
	}
	return [];
}

export function validateLogin(email: unknown, password: unknown): ValidationError[] {
	const errors: ValidationError[] = [];
	if (typeof email !== 'string' || email.trim().length === 0) {
		errors.push({ field: 'email', message: 'Email is required' });
	}
	if (typeof password !== 'string' || password.length === 0) {
		errors.push({ field: 'password', message: 'Password is required' });
	}
	return errors;
}

export const MAX_NOTE_CHARS = 8000;

export function validateCategoryName(name: unknown): ValidationError[] {
	if (typeof name !== 'string') return [{ field: 'name', message: 'Name is required' }];
	const trimmed = name.trim();
	if (trimmed.length < 1) return [{ field: 'name', message: 'Name is required' }];
	if (trimmed.length > 48) return [{ field: 'name', message: 'Name is too long (max 48)' }];
	return [];
}
