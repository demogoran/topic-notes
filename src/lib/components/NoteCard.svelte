<script lang="ts">
	import CategoryChip from '#lib/components/CategoryChip.svelte';
	import { formatRelativeTime } from '#lib/client/format';
	import type { NoteWithCategories } from '#lib/shared/types';

	interface Props {
		note: NoteWithCategories;
		ondelete: (id: number) => void;
	}

	let { note, ondelete }: Props = $props();

	let expanded = $state(false);
	let confirming = $state(false);

	function toggle() {
		expanded = !expanded;
		confirming = false;
	}
</script>

<article class="note card" class:expanded>
	<button class="note-body" onclick={toggle}>
		<time class="faint stamp">{formatRelativeTime(note.createdAt)}</time>
		<p class="text" class:clamped={!expanded}>{note.text}</p>
	</button>

	<div class="cats">
		{#each note.categories as c (c.id)}
			<CategoryChip name={c.name} />
		{/each}
		{#if note.categories.length === 0}
			<span class="chip uncategorized">uncategorized</span>
		{/if}
	</div>

	{#if expanded}
		<div class="actions">
			{#if confirming}
				<button class="btn btn-danger" onclick={() => ondelete(note.id)}>Confirm delete</button>
				<button class="btn btn-ghost" onclick={() => (confirming = false)}>Keep</button>
			{:else}
				<button class="btn btn-ghost del" onclick={() => (confirming = true)}>🗑 Delete</button>
			{/if}
		</div>
	{/if}
</article>

<style>
	.note {
		padding: 14px 16px;
		transition: background 0.15s;
	}

	.note.expanded {
		background: var(--bg-card-hover);
	}

	.note-body {
		display: block;
		width: 100%;
		text-align: left;
	}

	.stamp {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}

	.text {
		margin-top: 4px;
		font-size: 15px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.text.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.cats {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
	}

	.uncategorized {
		background: var(--bg);
		border-color: var(--line);
		color: var(--text-faint);
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	.del {
		font-size: 13px;
		padding: 8px 12px;
	}
</style>
