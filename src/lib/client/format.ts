/** Pure formatting helpers for the client UI. */

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
	const diff = Math.max(0, now - ts);
	const min = 60_000;
	if (diff < min) return 'just now';
	if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
	if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`;
	if (diff < 7 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))}d ago`;
	return new Date(ts).toLocaleDateString();
}

export function formatDuration(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}
