import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '#lib/server/guards';
import { makeCategoryRepo } from '#lib/server/db/repositories';
import { validateCategoryName } from '#lib/server/validators';

/** PATCH /api/categories/:id — rename */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const { userId } = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const errors = validateCategoryName(body.name);
	if (errors.length > 0) return json({ errors }, { status: 400 });

	const category = makeCategoryRepo().rename(userId, Number(params.id), String(body.name).trim());
	if (!category) throw error(404, 'Category not found');
	return json({ category });
};

/** DELETE /api/categories/:id — category links are removed with it (FK CASCADE) */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { userId } = requireUser(locals);
	const ok = makeCategoryRepo().remove(userId, Number(params.id));
	if (!ok) throw error(404, 'Category not found');
	return json({ ok: true });
};
