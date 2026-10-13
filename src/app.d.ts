import type { PublicUser } from '#lib/shared/types';
import type { AuthService } from '#lib/server/auth/authService';

declare global {
	namespace App {
		interface Locals {
			auth: AuthService;
			user: PublicUser | null;
		}
	}
}

export {};
