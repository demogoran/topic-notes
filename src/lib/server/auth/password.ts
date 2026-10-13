import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
	password: string,
	salt: string,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * scrypt hash — format: `s$<saltHex>$<hashHex>`
 * `saltHex` parameter enables deterministic tests.
 */
export async function hashPassword(password: string, saltHex?: string): Promise<string> {
	const salt = saltHex ?? randomBytes(16).toString('hex');
	const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT_PARAMS);
	return `s$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 3 || parts[0] !== 's') return false;
	const [, salt, hashHex] = parts;
	const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT_PARAMS);
	const expected = Buffer.from(hashHex, 'hex');
	return key.length === expected.length && timingSafeEqual(key, expected);
}

export function generateSessionToken(): string {
	return randomBytes(32).toString('base64url');
}
