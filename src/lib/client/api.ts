/** Typed fetch wrapper — all client→API calls go through here (DRY). */

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly fieldErrors: Record<string, string> = {}
	) {
		super(message);
	}
}

async function parse<T>(res: Response): Promise<T> {
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const errors = Array.isArray(body.errors) ? body.errors : [];
		const fieldErrors: Record<string, string> = {};
		for (const e of errors) {
			if (e && typeof e.field === 'string' && typeof e.message === 'string') {
				fieldErrors[e.field] = e.message;
			}
		}
		const message = typeof body.message === 'string' ? body.message : errors[0]?.message ?? res.statusText;
		throw new ApiError(message, res.status, fieldErrors);
	}
	return body as T;
}

export const api = {
	get: <T>(url: string): Promise<T> => fetch(url).then(parse<T>),
	post: <T>(url: string, data: unknown): Promise<T> => send<T>('POST', url, data),
	patch: <T>(url: string, data: unknown): Promise<T> => send<T>('PATCH', url, data),
	del: <T>(url: string): Promise<T> => fetch(url, { method: 'DELETE' }).then(parse<T>),
	upload: <T>(url: string, form: FormData): Promise<T> =>
		fetch(url, { method: 'POST', body: form }).then(parse<T>),
	/** POSTs and consumes an SSE stream of `{delta}` frames; calls onDelta per token. */
	stream: async (url: string, data: unknown, onDelta: (chunk: string) => void): Promise<void> => {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data)
		});
		if (!res.ok || !res.body) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(
				typeof body.message === 'string' ? body.message : res.statusText,
				res.status
			);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split('\n\n');
			buffer = frames.pop() ?? '';
			for (const frame of frames) {
				for (const line of frame.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const payload = trimmed.slice(5).trim();
					if (!payload) continue;
					if (payload === '[DONE]') return;
					try {
						const obj = JSON.parse(payload) as { delta?: string; error?: string };
						if (obj.error) throw new ApiError(obj.error, 502);
						if (obj.delta) onDelta(obj.delta);
					} catch (e) {
						if (e instanceof ApiError) throw e;
						// ignore malformed frames
					}
				}
			}
		}
	}
};

async function send<T>(method: string, url: string, data: unknown): Promise<T> {
	return fetch(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data)
	}).then(parse<T>);
}
