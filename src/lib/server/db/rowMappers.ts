import type { Category, Note } from '#lib/shared/types';

export const nowMs = (): number => Date.now();

export function rowToCategory(row: Record<string, unknown>): Category {
	return {
		id: row.id as number,
		name: row.name as string,
		noteCount: (row.note_count as number) ?? 0,
		createdAt: row.created_at as number
	};
}

export function rowToNote(row: Record<string, unknown>): Note {
	return {
		id: row.id as number,
		userId: row.user_id as number,
		transcript: (row.transcript as string) ?? '',
		text: row.text as string,
		audioDb: (row.audio_db as string) ?? null,
		status: row.status as 'draft' | 'final',
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number
	};
}
