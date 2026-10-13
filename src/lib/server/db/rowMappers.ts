import type { Category, Note, NoteType, TodoItem } from '#lib/shared/types';

export const nowMs = (): number => Date.now();

export function rowToCategory(row: Record<string, unknown>): Category {
	return {
		id: row.id as number,
		name: row.name as string,
		noteCount: (row.note_count as number) ?? 0,
		taskCount: (row.task_count as number) ?? 0,
		createdAt: row.created_at as number
	};
}

export function rowToNote(row: Record<string, unknown>): Note {
	return {
		id: row.id as number,
		userId: row.user_id as number,
		type: (row.type as NoteType) ?? 'text',
		transcript: (row.transcript as string) ?? '',
		text: row.text as string,
		audioDb: (row.audio_db as string) ?? null,
		status: row.status as 'draft' | 'final',
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number
	};
}

export function rowToTodoItem(row: Record<string, unknown>): TodoItem {
	return {
		id: row.id as number,
		noteId: row.note_id as number,
		text: row.text as string,
		done: (row.done as number) === 1,
		position: row.position as number,
		tags: []
	};
}
