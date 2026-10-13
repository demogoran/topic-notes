import { makeCategoryRepo, makeNoteRepo, makeTodoItemRepo } from '#lib/server/db/repositories';
import { validateCategoryName } from '#lib/server/validators';
import type { Note, NoteStatus, NoteType, NoteWithCategories, TodoItem } from '#lib/shared/types';

/**
 * Note domain service — the single place where notes and their
 * category links / todo checklists are created/updated (DRY, shared by endpoints).
 */
export class NoteService {
	private notes = makeNoteRepo();
	private categories = makeCategoryRepo();
	private todos = makeTodoItemRepo();

	list(userId: number, limit: number, offset: number): NoteWithCategories[] {
		const notes = this.notes.list(userId, limit, offset);
		return this.hydrate(userId, notes);
	}

	get(userId: number, id: number): NoteWithCategories | null {
		const note = this.notes.findById(userId, id);
		if (!note) return null;
		return this.hydrate(userId, [note])[0] ?? null;
	}

	create(
		userId: number,
		data: {
			transcript: string;
			text: string;
			audioDb: string | null;
			status: NoteStatus;
			type: NoteType;
			categories?: unknown;
			todos?: unknown;
		}
	): NoteWithCategories {
		const note = this.notes.create(userId, {
			transcript: data.transcript,
			text: data.text.slice(0, 8000),
			audioDb: data.audioDb,
			status: data.status,
			type: data.type
		});
		this.setCategories(userId, note.id, data.categories);
		this.todos.replaceForNote(userId, note.id, this.parseTodoInput(data.todos));
		return this.get(userId, note.id)!;
	}

	update(
		userId: number,
		id: number,
		data: {
			text?: string;
			status?: NoteStatus;
			type?: NoteType;
			categories?: unknown;
			todos?: unknown;
		}
	): NoteWithCategories | null {
		const current = this.notes.findById(userId, id);
		if (!current) return null;
		const text = typeof data.text === 'string' ? data.text.slice(0, 8000) : current.text;
		const status: NoteStatus = data.status ?? current.status;
		let updated = current;
		if (text !== current.text || status !== current.status) {
			updated = this.notes.updateText(userId, id, text, status) ?? current;
		}
		if (data.type && data.type !== current.type) {
			updated = this.notes.updateType(userId, id, data.type) ?? updated;
		}
		this.setCategories(userId, id, data.categories);
		if (data.todos !== undefined) {
			this.todos.replaceForNote(userId, id, this.parseTodoInput(data.todos));
		}
		return this.get(userId, id);
	}

	/** Toggles a single checklist item's done state without touching the rest. */
	toggleTodo(userId: number, noteId: number, itemId: number, done: boolean): TodoItem | null {
		const note = this.notes.findById(userId, noteId);
		if (!note) return null;
		return this.todos.toggle(userId, noteId, itemId, done);
	}

	removeTodo(userId: number, noteId: number, itemId: number): boolean {
		return this.todos.removeItem(userId, noteId, itemId);
	}

	remove(userId: number, id: number): boolean {
		return this.notes.remove(userId, id);
	}

	/** Attaches categories and todo items (with their per-task tags) to raw notes. */
	private hydrate(userId: number, notes: Note[]): NoteWithCategories[] {
		if (notes.length === 0) return [];
		const catMap = this.notes.categoriesForNotes(notes.map((n) => n.id));
		const todoMap = this.todos.listForNotes(notes.map((n) => n.id));
		return notes.map((n) => ({
			...n,
			categories: (catMap.get(n.id) ?? []).map(pick),
			todoItems: todoMap.get(n.id) ?? []
		}));
	}

	/** Idempotently links (and auto-creates) the given category names. Invalid names are skipped. */
	private setCategories(userId: number, noteId: number, names: unknown): void {
		if (!Array.isArray(names)) return;
		this.notes.removeAllCategoryLinks(noteId);
		for (const raw of names) {
			if (validateCategoryName(raw).length > 0) continue;
			const cat = this.categories.create(userId, String(raw).trim());
			this.notes.linkCategory(noteId, cat.id);
		}
	}

	/** Validates/normalizes raw todo payloads from the client. */
	private parseTodoInput(raw: unknown): { text: string; done: boolean; tags: string[] }[] {
		if (!Array.isArray(raw)) return [];
		return raw
			.map((it) => {
				const o = it as Record<string, unknown>;
				const text = typeof o?.text === 'string' ? o.text.trim().slice(0, 500) : '';
				const tags = Array.isArray(o?.tags)
					? (o.tags as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean).slice(0, 8)
					: [];
				return { text, done: o?.done === true, tags };
			})
			.filter((t) => t.text.length > 0)
			.slice(0, 100);
	}
}

const pick = (c: { id: number; name: string }): { id: number; name: string } => ({ id: c.id, name: c.name });

export type { Note };
