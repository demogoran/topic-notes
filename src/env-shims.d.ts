// Type shims for SvelteKit's `$env/*` virtual modules (not declared in kit's bundled types).
declare module '$env/dynamic/private' {
	export const env: Record<string, string | undefined>;
}
declare module '$env/dynamic/public' {
	export const env: Record<string, string | undefined>;
}
declare module '$env/static/private' {
	export const [key: string]: string | undefined;
}
declare module '$env/static/public' {
	export const [key: string]: string | undefined;
}
