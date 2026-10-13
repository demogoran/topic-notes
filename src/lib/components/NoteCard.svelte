<script lang="ts">
	import CategoryChip from '#lib/components/CategoryChip.svelte';
	import { formatRelativeTime } from '#lib/client/format';
	import type { NoteWithCategories } from '#lib/shared/types';

	interface Props {
		note: NoteWithCategories;
		ondelete: (id: number) => void;
		ontoggletodo?: (noteId: number, itemId: number, done: boolean) => void;
	}

	let { note, ondelete, ontoggletodo }: Props = $props();

	let expanded = $state(false);
	let confirming = $state(false);

	const TYPE_META: Record<string, { icon: string; label: string }> = {
		text: { icon: '📝', label: 'Note' },
		todo: { icon: '☑️', label: 'Todolist' },
		prompt: { icon: '✨', label: 'Prompt' },
		summary: { icon: '🧾', label: 'Summary' }
	};

	const meta = $derived(TYPE_META[note.type] ?? TYPE_META.text);
	const doneCount = $derived(note.todoItems.filter((t) => t.done).length);

	function toggle() {
		expanded = !expanded;
		confirming = false;
	}

	function onCheck(e: Event, itemId: number) {
		e.stopPropagation();
		ontoggletodo?.(note.id, itemId, (e.currentTarget as HTMLInputElement).checked);
	}
</script>

<article class="note card" class:expanded>
	<button class="note-body" onclick={toggle}>
		<div class="head">
			<time class="faint stamp">{formatRelativeTime(note.createdAt)}</time>
			<span class="type-badge">{meta.icon} {meta.label}</span>
		</div>
		<p class="text" class:clamped={!expanded} class:title={note.type === 'todo'}>{note.text}</p>
	</button>

	{#if note.type === 'todo' && note.todoItems.length > 0}
		<div class="progress faint">{doneCount}/{note.todoItems.length} done</div>
		<ul class="todo-list">
			{#each note.todoItems as item (item.id)}
				<li class:done={item.done}>
					<label class="check">
						<input type="checkbox" checked={item.done} onchange={(e) => onCheck(e, item.id)} />
					</label>
					<span class="task-text">{item.text}</span>
					{#each item.tags as t (t.id)}
						<CategoryChip name={t.name} small />
					{/each}
				</li>
			{/each}
		</ul>
	{/if}

	<div class="cats">
		{#each note.categories as c (c.id)}
			<CategoryChip name={c.name} />
		{/each}
		{#if note.categories.length === 0 && note.type !== 'todo'}
			<span class="chip uncategorized">uncategorized</span>
		{/if}
	</div>

	{#if expanded}
		<div class="actions">
			<details class="raw">
				<summary class="faint">Raw transcript</summary>
				<p class="muted raw-text">{note.transcript}</p>
			</details>
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

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.type-badge {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--accent-soft);
		background: var(--accent-dim);
		border: 1px solid rgba(139, 92, 246, 0.35);
		border-radius: var(--radius-pill);
		padding: 2px 8px;
		white-space: nowrap;
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

	.text.title {
		font-weight: 700;
	}

	.text.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.progress {
		font-size: 12px;
		margin-top: 6px;
	}

	.todo-list {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.todo-list li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}

	.todo-list li.done .task-text {
		text-decoration: line-through;
		color: var(--text-faint);
	}

	.check {
		display: flex;
		flex-shrink: 0;
	}

	.check input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}

	.task-text {
		flex: 1;
		overflow-wrap: anywhere;
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
		flex-wrap: wrap;
		align-items: center;
	}

	.raw {
		flex: 1;
		min-width: 160px;
	}

	.raw summary {
		cursor: pointer;
		font-size: 13px;
	}

	.raw-text {
		font-size: 13px;
		margin-top: 6px;
		white-space: pre-wrap;
	}

	.del {
		font-size: 13px;
		padding: 8px 12px;
	}
</style>
