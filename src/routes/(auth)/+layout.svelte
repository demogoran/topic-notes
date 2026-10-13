<script lang="ts" module>
	/** Shared auth-form state machine — used by both /login and /register (DRY). */
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<div class="auth-shell">
	<div class="brand">
		<div class="brand-mark" aria-hidden="true">🎙️</div>
		<h1>VoiceNotes</h1>
		<p class="tagline muted">Speak. Categorize. Done.</p>
	</div>
	{@render children()}
</div>

<style>
	.auth-shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 24px 20px calc(24px + var(--safe-bottom));
		gap: 28px;
	}

	.brand {
		text-align: center;
		animation: rise 0.4s ease both;
	}

	.brand-mark {
		width: 72px;
		height: 72px;
		margin: 0 auto 14px;
		display: grid;
		place-items: center;
		font-size: 34px;
		border-radius: 24px;
		background: linear-gradient(135deg, var(--accent-dim), var(--cyan-dim));
		border: 1px solid var(--line);
	}

	h1 {
		font-size: 28px;
		font-weight: 800;
		letter-spacing: -0.02em;
	}

	.tagline {
		margin-top: 4px;
		font-size: 14px;
	}
</style>
