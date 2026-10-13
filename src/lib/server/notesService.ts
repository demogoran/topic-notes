import { makeCategoryRepo, makeNoteRepo } from '#lib/server/db/repositories';
import { validateCategoryName } from '#lib/server/validators';
import type { Note, NoteWithCategories } from '#lib/shared/types';

/**
 * Note domain service — the single place where notes and their
 * category links are created/updated (DRY, shared by endpoints).
 */
export class NoteService {
	private notes = makeNoteRepo();
	private categories = makeCategoryRepo();

	list(userId: number, limit: number, offset: number): NoteWithCategories[] {
		const notes = this.notes.list(userId, limit, offset);
		const map = this.notes.categoriesForNotes(notes.map((n) => n.id));
		return notes.map((n) => ({ ...n, categories: (map.get(n.id) ?? []).map(pick) }));
	}

	create(
		userId: number,
		data: { transcript: string; text: string; audioDb: string | null; status: 'draft' | 'final'; categories?: unknown }
	): NoteWithCategories {
		const note = this.notes.create(userId, {
			transcript: data.transcript,
			text: data.text.slice(0, 8000),
			audioDb: data.audioDb,
			status: data.status
		});
		this.setCategories(userId, note.id, data.categories);
		return this.get(userId, note.id)!;
	}

	updateText(
		userId: number,
		id: number,
		data: { text: string; status: 'draft' | 'final'; categories?: unknown }
	): NoteWithCategories | null {
		const updated = this.notes.updateText(userId, id, data.text.slice(0, 8000), data.status);
		if (!updated) return null;
		this.setCategories(userId, id, data.categories);
		return this.get(userId, id);
	}

	get(userId: number, id: number): NoteWithCategories | null {
		const note = this.notes.findById(userId, id);
		if (!note) return null;
		const map = this.notes.categoriesForNotes([note.id]);
		return { ...note, categories: (map.get(note.id) ?? []).map(pick) };
	}

	remove(userId: number, id: number): boolean {
		return this.notes.remove(userId, id);
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
}

const pick = (c: { id: number; name: string }): { id: number; name: string } => ({ id: c.id, name: c.name });

export type { Note };
