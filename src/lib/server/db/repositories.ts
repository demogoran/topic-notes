import type {
	Category,
	CategoryRepo,
	Note,
	NoteRepo,
	NoteWithCategories,
	User,
	UserRepo
} from '#lib/shared/types';
import { nowMs, rowToCategory, rowToNote } from '#lib/server/db/rowMappers';
import { getDb } from '#lib/server/db/database';

// ---------- users ----------

export function makeUserRepo(): UserRepo {
	const db = getDb();
	const insert = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)');
	const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
	const byId = db.prepare('SELECT * FROM users WHERE id = ?');

	return {
		create(email: string, passwordHash: string): User {
			insert.run(email, passwordHash, nowMs());
			return this.findByEmail(email)!;
		},
		findById(id: number): User | null {
			const row = byId.get(id) as Record<string, unknown> | undefined;
			return row ? rowToUser(row) : null;
		},
		findByEmail(email: string): User | null {
			const row = byEmail.get(email) as Record<string, unknown> | undefined;
			return row ? rowToUser(row) : null;
		}
	};
}

export function rowToUser(row: Record<string, unknown>): User {
	return {
		id: row.id as number,
		email: row.email as string,
		passwordHash: row.password_hash as string,
		createdAt: row.created_at as number
	};
}

// ---------- sessions ----------

export function makeSessionRepo() {
	const db = getDb();
	const insert = db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
	const byId = db.prepare('SELECT s.*, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?');
	const del = db.prepare('DELETE FROM sessions WHERE id = ?');
	const delExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
	const delForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');

	return {
		create(userId: number, token: string, ttlMs: number) {
			const now = nowMs();
			insert.run(token, userId, now + ttlMs, now);
			delExpired.run(now); // lazy cleanup
		},
		find(token: string) {
			const row = byId.get(token) as Record<string, unknown> | undefined;
			if (!row) return null;
			if ((row.expires_at as number) < nowMs()) {
				del.run(token);
				return null;
			}
			return { userId: row.user_id as number, email: row.email as string };
		},
		delete(token: string) {
			del.run(token);
		},
		deleteForUser(userId: number) {
			delForUser.run(userId);
		}
	};
}

// ---------- categories ----------

export function makeCategoryRepo(): CategoryRepo {
	const db = getDb();
	const insert = db.prepare('INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?)');
	const forUser = db.prepare(
		`SELECT c.*, (SELECT COUNT(*) FROM note_categories nc WHERE nc.category_id = c.id) AS note_count
		 FROM categories c WHERE c.user_id = ? ORDER BY c.created_at ASC`
	);
	const byIdForUser = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?');
	const findByName = db.prepare('SELECT * FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE');
	const rename = db.prepare('UPDATE categories SET name = ? WHERE id = ? AND user_id = ?');
	const remove = db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?');
	const delAllLinks = db.prepare('DELETE FROM note_categories WHERE category_id = ?');

	return {
		list(userId: number): Category[] {
			return (forUser.all(userId) as Record<string, unknown>[]).map(rowToCategory);
		},
		create(userId: number, name: string): Category {
			const existing = this.findByName(userId, name);
			if (existing) return existing; // idempotent (NOCASE unique)
			const info = insert.run(userId, name, nowMs());
			return rowToCategory(byIdForUser.get(info.lastInsertRowid, userId) as Record<string, unknown>);
		},
		findByName(userId: number, name: string): Category | null {
			const row = findByName.get(userId, name) as Record<string, unknown> | undefined;
			return row ? rowToCategory(row) : null;
		},
		rename(userId: number, id: number, name: string): Category | null {
			const info = rename.run(name, id, userId);
			if (info.changes === 0) return null;
			const row = byIdForUser.get(id, userId) as Record<string, unknown> | undefined;
			return row ? rowToCategory(row) : null;
		},
		remove(userId: number, id: number): boolean {
			delAllLinks.run(id);
			return remove.run(id, userId).changes > 0;
		}
	};
}

// ---------- notes ----------

export function makeNoteRepo(): NoteRepo {
	const db = getDb();
	const insert = db.prepare(
		'INSERT INTO notes (user_id, transcript, text, audio_db, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	const forUser = db.prepare(
		'SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
	);
	const countForUser = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE user_id = ?');
	const byIdForUser = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?');
	const updateText = db.prepare('UPDATE notes SET text = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?');
	const remove = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?');
	const delLinksForNote = db.prepare('DELETE FROM note_categories WHERE note_id = ?');
	const linkCat = db.prepare('INSERT OR IGNORE INTO note_categories (note_id, category_id) VALUES (?, ?)');

	return {
		create(userId: number, data: { transcript: string; text: string; audioDb: string | null; status: 'draft' | 'final' }): Note {
			const now = nowMs();
			const info = insert.run(userId, data.transcript, data.text, data.audioDb, data.status, now, now);
			return rowToNote(byIdForUser.get(info.lastInsertRowid, userId) as Record<string, unknown>);
		},
		list(userId: number, limit: number, offset: number): Note[] {
			return (forUser.all(userId, limit, offset) as Record<string, unknown>[]).map(rowToNote);
		},
		count(userId: number): number {
			return (countForUser.get(userId) as { c: number }).c;
		},
		findById(userId: number, id: number): Note | null {
			const row = byIdForUser.get(id, userId) as Record<string, unknown> | undefined;
			return row ? rowToNote(row) : null;
		},
		updateText(userId: number, id: number, text: string, status: 'draft' | 'final'): Note | null {
			const info = updateText.run(text, status, nowMs(), id, userId);
			if (info.changes === 0) return null;
			return rowToNote(byIdForUser.get(id, userId) as Record<string, unknown>);
		},
		remove(userId: number, id: number): boolean {
			return remove.run(id, userId).changes > 0;
		},
		removeAllCategoryLinks(noteId: number): void {
			delLinksForNote.run(noteId);
		},
		linkCategory(noteId: number, categoryId: number): void {
			linkCat.run(noteId, categoryId);
		},
		categoriesForNotes(noteIds: number[]): Map<number, Category[]> {
			const map = new Map<number, Category[]>();
			if (noteIds.length === 0) return map;
			const placeholders = noteIds.map(() => '?').join(',');
			const sql = `SELECT nc.note_id, c.id, c.name FROM note_categories nc
				JOIN categories c ON c.id = nc.category_id
				WHERE nc.note_id IN (${placeholders}) ORDER BY c.name`;
			const rows = db.prepare(sql).all(...noteIds) as Array<Record<string, unknown>>;
			for (const r of rows) {
				const nid = r.note_id as number;
				const list = map.get(nid) ?? [];
				list.push({ id: r.id as number, name: r.name as string, noteCount: 0, createdAt: 0 });
				map.set(nid, list);
			}
			return map;
		}
	};
}

export function toWithCategories(notes: Note[], cats: Map<number, Category[]>): NoteWithCategories[] {
	return notes.map((n) => ({ ...n, categories: cats.get(n.id) ?? [] }));
}
