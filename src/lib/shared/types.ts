export interface User {
	id: number;
	email: string;
	passwordHash: string;
	createdAt: number;
}

export interface Category {
	id: number;
	name: string;
	noteCount: number;
	createdAt: number;
}

export type NoteStatus = 'draft' | 'final';

/** All note types the capture flow can produce. */
export type NoteType = 'text' | 'todo' | 'prompt' | 'summary';

export const NOTE_TYPES: NoteType[] = ['text', 'todo', 'prompt', 'summary'];

export function isNoteType(v: unknown): v is NoteType {
	return typeof v === 'string' && (NOTE_TYPES as string[]).includes(v);
}

export interface Note {
	id: number;
	userId: number;
	type: NoteType;
	transcript: string;
	text: string;
	audioDb: string | null;
	status: NoteStatus;
	createdAt: number;
	updatedAt: number;
}

export interface TodoItem {
	id: number;
	noteId: number;
	text: string;
	done: boolean;
	position: number;
	tags: Pick<Category, 'id' | 'name'>[];
}

export interface NoteWithCategories extends Note {
	categories: Pick<Category, 'id' | 'name'>[];
	/** Only for `type: 'todo'` — checklist items ordered by position. */
	todoItems: TodoItem[];
}

export interface Category {
	id: number;
	name: string;
	noteCount: number;
	/** Number of todo tasks across ALL the user's todolists tagged with this tag. */
	taskCount: number;
	createdAt: number;
}

export interface TodoTagSummary {
	id: number;
	name: string;
	taskCount: number;
}

/** Human-facing metadata for one note type, used in the type-selection UI. */
export interface NoteTypeInfo {
	type: NoteType;
	label: string;
	description: string;
}

export interface UserRepo {
	create(email: string, passwordHash: string): User;
	findById(id: number): User | null;
	findByEmail(email: string): User | null;
}

export interface SessionRepo {
	create(userId: number, token: string, ttlMs: number): void;
	find(token: string): { userId: number; email: string } | null;
	delete(token: string): void;
}

export interface CategoryRepo {
	list(userId: number): Category[];
	create(userId: number, name: string): Category;
	findByName(userId: number, name: string): Category | null;
	rename(userId: number, id: number, name: string): Category | null;
	remove(userId: number, id: number): boolean;
}

export interface NoteRepo {
	create(
		userId: number,
		data: { transcript: string; text: string; audioDb: string | null; status: NoteStatus; type: NoteType }
	): Note;
	list(userId: number, limit: number, offset: number): Note[];
	count(userId: number): number;
	findById(userId: number, id: number): Note | null;
	updateText(userId: number, id: number, text: string, status: NoteStatus): Note | null;
	updateType(userId: number, id: number, type: NoteType): Note | null;
	remove(userId: number, id: number): boolean;
	removeAllCategoryLinks(noteId: number): void;
	linkCategory(noteId: number, categoryId: number): void;
	categoriesForNotes(noteIds: number[]): Map<number, Category[]>;
}

export interface TodoItemRepo {
	replaceForNote(userId: number, noteId: number, items: TodoItemInput[]): void;
	listForNotes(noteIds: number[]): Map<number, TodoItem[]>;
	toggle(userId: number, noteId: number, itemId: number, done: boolean): TodoItem | null;
	removeItem(userId: number, noteId: number, itemId: number): boolean;
}

/** Tag ids/names are resolved (and auto-created) server-side. */
export interface TodoItemInput {
	text: string;
	done: boolean;
	tags: string[];
}

export interface PublicUser {
	id: number;
	email: string;
	/** Opaque session token, set by AuthService.issueSession, consumed by cookie helpers. */
	token?: string;
}

export interface ProposedCategory {
	name: string;
	categoryId: number | null; // matches an existing category if non-null
}

export interface ProposedTodo {
	text: string;
	done: boolean;
	tags: string[];
}

/** Result of the explicit "pick the best note type" AI step. */
export interface DetectedType {
	type: NoteType;
	reason: string;
}

/** Type-specific AI formatting result (the second explicit AI step). */
export interface FormatResult {
	type: NoteType;
	language: 'en' | 'uk';
	/** text/prompt/summary body, or todo list title. */
	text: string;
	categories: { name: string; categoryId: number | null }[];
	/** Only for `type: 'todo'`. */
	todos: ProposedTodo[];
}
