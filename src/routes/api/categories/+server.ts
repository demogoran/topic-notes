import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { makeCategoryRepo } from '#lib/server/db/repositories';
import { validateCategoryName } from '#lib/server/validators';

export const GET: RequestHandler = async ({ locals }) => {
	const { userId } = requireUser(locals);
	return json({ categories: makeCategoryRepo().list(userId) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const errors = validateCategoryName(body.name);
	if (errors.length > 0) return json({ errors }, { status: 400 });

	const category = makeCategoryRepo().create(userId, String(body.name).trim());
	return json({ category }, { status: 201 });
};
