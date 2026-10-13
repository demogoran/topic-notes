<script lang="ts">
	interface Props {
		recording: boolean;
		level: number; // 0..1 mic amplitude
		processing: boolean;
		ondisabled?: boolean;
		onclick: () => void;
	}

	let { recording, level, processing, onclick }: Props = $props();

	const scale = $derived(recording ? 1 + level * 0.35 : 1);
</script>

<button
	class="orb"
	class:recording
	class:processing
	style:transform={`scale(${scale})`}
	onclick={onclick}
	disabled={processing}
	aria-label={recording ? 'Stop recording' : 'Start recording'}
>
	{#if processing}
		<span class="spinner"></span>
	{:else if recording}
		<span class="stop-icon"></span>
	{:else}
		<span class="mic-icon" aria-hidden="true">
			<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="9" y="2" width="6" height="12" rx="3" />
				<path d="M5 10a7 7 0 0 0 14 0" />
				<line x1="12" y1="19" x2="12" y2="22" />
			</svg>
		</span>
	{/if}
</button>

<style>
	.orb {
		width: 92px;
		height: 92px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(135deg, var(--accent) 0%, #6d28d9 60%, #4c1d95 100%);
		box-shadow: 0 6px 30px var(--accent-glow);
		transition: transform 0.08s ease-out, box-shadow 0.3s;
		position: relative;
		flex-shrink: 0;
	}

	.orb.recording {
		background: linear-gradient(135deg, var(--danger), #be123c);
		box-shadow: 0 6px 30px rgba(244, 63, 94, 0.45);
		animation: pulse-ring 1.6s ease-out infinite;
	}

	.orb:disabled {
		opacity: 0.8;
		pointer-events: none;
	}

	.mic-icon,
	.spinner {
		transition: opacity 0.2s;
	}

	.stop-icon {
		width: 26px;
		height: 26px;
		border-radius: 6px;
		background: #fff;
	}

	/* soft halo behind the orb */
	.orb::after {
		content: '';
		position: absolute;
		inset: -14px;
		border-radius: 50%;
		background: radial-gradient(circle, var(--accent-dim), transparent 70%);
		z-index: -1;
	}
</style>
