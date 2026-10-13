import { AUDIO_DIR } from '$app/env/private';

export interface AudioMeta {
	filename: string;
	mimeType: string;
	bytes: number;
	durationSec: number | null;
}

/**
 * Strategy: store audio blobs as plain files on disk under DATA_AUDIO_DIR.
 * (Portable, zero external deps; swap the class body for S3/GCS later —
 * the interface is the seam.)
 */
export class AudioStore {
	private readonly dir: string;

	constructor() {
		this.dir = AUDIO_DIR;
	}

	async save(userId: number, noteId: number, data: Buffer, ext: string): Promise<string> {
		const { mkdir, writeFile } = await import('node:fs/promises');
		const path = this.join(this.dir, String(userId));
		await mkdir(path, { recursive: true });
		const filename = `${noteId}_${Date.now()}.${ext}`;
		await writeFile(this.join(path, filename), data);
		return filename;
	}

	async remove(dbFilename: string): Promise<void> {
		const { rm } = await import('node:fs/promises');
		await rm(this.join(this.dir, dbFilename), { force: true });
	}

	private join(...parts: string[]): string {
		return parts.join('/');
	}
}

export function extFromMime(mime: string): string {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('ogg')) return 'ogg';
	if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
	if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
	if (mime.includes('wav')) return 'wav';
	return 'bin';
}

export function parseAudioMeta(fd: FormData): AudioMeta | null {
	const f = fd.get('audio');
	if (!(f instanceof File) || f.size === 0) return null;
	const dur = fd.get('durationSec');
	return {
		filename: f.name || 'recording',
		mimeType: f.type || 'audio/webm',
		bytes: f.size,
		durationSec: typeof dur === 'string' && !isNaN(Number(dur)) ? Number(dur) : null
	};
}
