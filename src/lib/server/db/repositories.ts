import type {
	Category,
	CategoryRepo,
	ChatMsg,
	ChatRepo,
	Note,
	NoteRepo,
	NoteType,
	NoteWithCategories,
	TodoItem,
	TodoItemInput,
	TodoItemRepo,
	User,
	UserRepo
} from '#lib/shared/types';
import { nowMs, rowToCategory, rowToNote, rowToTodoItem } from '#lib/server/db/rowMappers';
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
		`SELECT c.*,
			(SELECT COUNT(*) FROM note_categories nc WHERE nc.category_id = c.id) AS note_count,
			(SELECT COUNT(*) FROM todo_item_categories tic
			 JOIN todo_items ti ON ti.id = tic.todo_item_id
			 JOIN notes n ON n.id = ti.note_id
			 WHERE tic.category_id = c.id AND n.user_id = c.user_id) AS task_count
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

// ---------- todo items ----------

/**
 * Todo checklist items for `type: 'todo'` notes. Each item carries its own tags
 * (stored in the shared categories table via todo_item_categories), which is what
 * makes global tag aggregation across todolists a single SQL query.
 */
export function makeTodoItemRepo(): TodoItemRepo {
	const db = getDb();
	const insertItem = db.prepare(
		'INSERT INTO todo_items (note_id, text, done, position, created_at) VALUES (?, ?, ?, ?, ?)'
	);
	const delForNote = db.prepare('DELETE FROM todo_items WHERE note_id = ?');
	const byIdForNote = db.prepare('SELECT * FROM todo_items WHERE id = ? AND note_id = ?');
	const toggleDone = db.prepare('UPDATE todo_items SET done = ? WHERE id = ? AND note_id = ?');
	const delItem = db.prepare('DELETE FROM todo_items WHERE id = ?');

	const tagsForItemsSql =
		`SELECT tic.todo_item_id, c.id, c.name FROM todo_item_categories tic
		 JOIN categories c ON c.id = tic.category_id
		 WHERE tic.todo_item_id IN `;

	function inList(n: number): string {
		return n > 0 ? new Array(n).fill('?').join(',') : 'NULL';
	}

	/** Idempotently resolves tag names to the user's categories and links them to one item. */
	function linkItemTags(userId: number, itemId: number, tags: string[]): void {
		const findByName = db.prepare(
			'SELECT id FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE'
		);
		const insertCat = db.prepare(
			'INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?)'
		);
		const link = db.prepare(
			'INSERT OR IGNORE INTO todo_item_categories (todo_item_id, category_id) VALUES (?, ?)'
		);
		for (const raw of tags) {
			const name = String(raw).trim().slice(0, 48);
			if (!name) continue;
			let cat = findByName.get(userId, name) as { id: number } | undefined;
			if (!cat) {
				cat = { id: insertCat.run(userId, name, nowMs()).lastInsertRowid as number };
			}
			link.run(itemId, cat.id);
		}
	}

	return {
		/** Replaces the full checklist of a note (delete-all + re-insert, transactional). */
		replaceForNote(userId: number, noteId: number, items: TodoItemInput[]): void {
			const tx = db.transaction(() => {
				delForNote.run(noteId);
				items.forEach((item, i) => {
					const info = insertItem.run(noteId, item.text, item.done ? 1 : 0, i, nowMs());
					linkItemTags(userId, info.lastInsertRowid as number, item.tags);
				});
			});
			tx();
		},
		listForNotes(noteIds: number[]): Map<number, TodoItem[]> {
			const map = new Map<number, TodoItem[]>();
			if (noteIds.length === 0) return map;
			const rows = db
				.prepare(
					`SELECT * FROM todo_items WHERE note_id IN (${inList(noteIds.length)}) ORDER BY note_id, position, id`
				)
				.all(...noteIds) as Array<Record<string, unknown>>;
			const items = rows.map(rowToTodoItem);
			for (const it of items) {
				const list = map.get(it.noteId) ?? [];
				list.push(it);
				map.set(it.noteId, list);
			}
			if (items.length === 0) return map;
			const ids = items.map((it) => it.id);
			const tagRows = db
				.prepare(`${tagsForItemsSql} (${inList(ids.length)}) ORDER BY c.name`)
				.all(...ids) as Array<Record<string, unknown>>;
			const tagMap = new Map<number, { id: number; name: string }[]>();
			for (const r of tagRows) {
				const tid = r.todo_item_id as number;
				const list = tagMap.get(tid) ?? [];
				list.push({ id: r.id as number, name: r.name as string });
				tagMap.set(tid, list);
			}
			for (const it of items) it.tags = tagMap.get(it.id) ?? [];
			return map;
		},
		toggle(userId: number, noteId: number, itemId: number, done: boolean): TodoItem | null {
			const note = db
				.prepare('SELECT user_id FROM notes WHERE id = ?')
				.get(noteId) as { user_id: number } | undefined;
			if (!note || note.user_id !== userId) return null;
			const info = toggleDone.run(done ? 1 : 0, itemId, noteId);
			if (info.changes === 0) return null;
			const row = byIdForNote.get(itemId, noteId) as Record<string, unknown> | undefined;
			if (!row) return null;
			const item = rowToTodoItem(row);
			const tagRows = db
				.prepare(`${tagsForItemsSql} (?) ORDER BY c.name`)
				.all(item.id) as Array<Record<string, unknown>>;
			item.tags = tagRows.map((r) => ({ id: r.id as number, name: r.name as string }));
			return item;
		},
		removeItem(userId: number, noteId: number, itemId: number): boolean {
			const note = db
				.prepare('SELECT user_id FROM notes n WHERE n.id = ?')
				.get(noteId) as { user_id: number } | undefined;
			if (!note || note.user_id !== userId) return false;
			return delItem.run(itemId).changes > 0;
		}
	};
}

// ---------- chat (per-note conversations) ----------

export function makeChatRepo(): ChatRepo {
	const db = getDb();
	const insert = db.prepare(
		'INSERT INTO chat_messages (note_id, role, content, created_at) VALUES (?, ?, ?, ?)'
	);
	const clear = db.prepare('DELETE FROM chat_messages WHERE note_id = ?');

	/** Ownership is enforced via a join on notes.user_id. */
	const forNote = db.prepare(
		`SELECT m.id, m.role, m.content, m.created_at FROM chat_messages m
		 JOIN notes n ON n.id = m.note_id
		 WHERE m.note_id = ? AND n.user_id = ? ORDER BY m.id ASC`
	);

	return {
		listForNote(userId: number, noteId: number): ChatMsg[] {
			return (
				forNote.all(noteId, userId) as Array<Record<string, unknown>>
			).map((r) => ({
				id: r.id as number,
				role: r.role as 'user' | 'assistant',
				content: r.content as string,
				createdAt: r.created_at as number
			}));
		},
		add(userId: number, noteId: number, role: 'user' | 'assistant', content: string): void {
			const note = db.prepare('SELECT id FROM notes WHERE id = ? AND user_id = ?').get(noteId, userId);
			if (!note) return;
			insert.run(noteId, role, content.slice(0, 8000), nowMs());
		},
		clear(userId: number, noteId: number): void {
			const note = db.prepare('SELECT id FROM notes WHERE id = ? AND user_id = ?').get(noteId, userId);
			if (!note) return;
			clear.run(noteId);
		}
	};
}

// ---------- notes ----------

export function makeNoteRepo(): NoteRepo {
	const db = getDb();
	const insert = db.prepare(
		'INSERT INTO notes (user_id, transcript, text, audio_db, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
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
		create(userId: number, data: { transcript: string; text: string; audioDb: string | null; status: 'draft' | 'final'; type: NoteType }): Note {
			const now = nowMs();
			const info = insert.run(userId, data.transcript, data.text, data.audioDb, data.status, data.type, now, now);
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
		updateType(userId: number, id: number, type: NoteType): Note | null {
			const info = db
				.prepare('UPDATE notes SET type = ?, updated_at = ? WHERE id = ? AND user_id = ?')
				.run(type, nowMs(), id, userId);
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
				list.push({ id: r.id as number, name: r.name as string, noteCount: 0, taskCount: 0, createdAt: 0 });
				map.set(nid, list);
			}
			return map;
		}
	};
}

export function toWithCategories(notes: Note[], cats: Map<number, Category[]>): NoteWithCategories[] {
	return notes.map((n) => ({ ...n, categories: cats.get(n.id) ?? [], todoItems: [] }));
}
