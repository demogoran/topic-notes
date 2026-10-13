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
	`);
}
