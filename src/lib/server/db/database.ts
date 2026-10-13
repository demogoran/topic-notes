import Database from 'better-sqlite3';
import { DATABASE_PATH } from '$app/env/private';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Singleton better-sqlite3 connection.
 * Justified singleton: one process-wide handle, WAL mode, prepared statements cached.
 */
let instance: Database.Database | null = null;

export function getDb(): Database.Database {
	if (instance) return instance;

	const file = resolve(DATABASE_PATH);
	mkdirSync(dirname(file), { recursive: true });

	const db = new Database(file);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');

	migrate(db);
	instance = db;
	return db;
}

function migrate(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

		CREATE TABLE IF NOT EXISTS categories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL COLLATE NOCASE,
			created_at INTEGER NOT NULL,
			UNIQUE(user_id, name)
		);

		CREATE TABLE IF NOT EXISTS notes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			transcript TEXT NOT NULL DEFAULT '',
			text TEXT NOT NULL DEFAULT '',
			audio_db TEXT,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS note_categories (
			note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
			PRIMARY KEY (note_id, category_id)
		);
		CREATE INDEX IF NOT EXISTS idx_note_categories_cat ON note_categories(category_id);

		CREATE TABLE IF NOT EXISTS todo_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			done INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_todo_items_note ON todo_items(note_id, position);

		CREATE TABLE IF NOT EXISTS todo_item_categories (
			todo_item_id INTEGER NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
			category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
			PRIMARY KEY (todo_item_id, category_id)
		);
		CREATE INDEX IF NOT EXISTS idx_todo_item_categories_cat ON todo_item_categories(category_id);

		CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_chat_messages_note ON chat_messages(note_id, id);
	`);

	// Incremental migration: notes.type for DBs created before note types existed.
	const cols = db.prepare(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === 'type')) {
		db.exec(`ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`);
	}
}
