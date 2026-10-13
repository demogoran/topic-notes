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

export interface Note {
	id: number;
	userId: number;
	transcript: string;
	text: string;
	audioDb: string | null;
	status: NoteStatus;
	createdAt: number;
	updatedAt: number;
}

export interface NoteWithCategories extends Note {
	categories: Pick<Category, 'id' | 'name'>[];
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
		data: { transcript: string; text: string; audioDb: string | null; status: NoteStatus }
	): Note;
	list(userId: number, limit: number, offset: number): Note[];
	count(userId: number): number;
	findById(userId: number, id: number): Note | null;
	updateText(userId: number, id: number, text: string, status: NoteStatus): Note | null;
	remove(userId: number, id: number): boolean;
	removeAllCategoryLinks(noteId: number): void;
	linkCategory(noteId: number, categoryId: number): void;
	categoriesForNotes(noteIds: number[]): Map<number, Category[]>;
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
