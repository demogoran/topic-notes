<script lang="ts">
	import { api } from '#lib/client/api';
	import { Dictation } from '#lib/client/dictation';
	import CategoryChip from '#lib/components/CategoryChip.svelte';
	import { formatRelativeTime } from '#lib/client/format';
	import type { ChatMsg, NoteWithCategories } from '#lib/shared/types';

	interface Props {
		note: NoteWithCategories;
		ondelete: (id: number) => void;
		onupdated?: (note: NoteWithCategories) => void;
		ontoggletodo?: (noteId: number, itemId: number, done: boolean) => void;
	}

	let { note, ondelete, onupdated, ontoggletodo }: Props = $props();

	let expanded = $state(false);
	let confirming = $state(false);

	// inline text edit
	let editing = $state(false);
	let editText = $state('');
	let savingEdit = $state(false);

	// chat (text / summary / prompt)
	const chatSupported = $derived(note.type !== 'todo');
	let chatOpen = $state(false);
	let messages = $state<ChatMsg[]>([]);
	let chatInput = $state('');
	let chatBusy = $state(false);
	let streaming = $state('');
	let chatError = $state('');
	let chatInputEl = $state<HTMLInputElement | null>(null);

	// --- voice dictation for the chat box (never auto-sends: text lands in the
	// input for the user to review/edit before sending manually) ---
	const dictation = new Dictation();
	let micOn = $state(false);
	let micText = $state(''); // live recognized text while listening
	let micError = $state('');

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
		editing = false;
		stopMic();
		if (!expanded) chatOpen = false;
	}

	function onCheck(e: Event, itemId: number) {
		e.stopPropagation();
		ontoggletodo?.(note.id, itemId, (e.currentTarget as HTMLInputElement).checked);
	}

	function startEdit(e: MouseEvent) {
		e.stopPropagation();
		editText = note.text;
		editing = true;
	}

	async function saveEdit() {
		if (savingEdit || !editText.trim()) return;
		savingEdit = true;
		try {
			const { note: updated } = await api.patch<{ note: NoteWithCategories }>(
				`/api/notes/${note.id}`,
				{ text: editText }
			);
			onupdated?.(updated);
			editing = false;
		} finally {
			savingEdit = false;
		}
	}

	// --- chat ---

	/** Conversation starters, per note type. Clicking fills the input (editable, not sent). */
	const SUGGESTIONS: Record<string, string[]> = {
		text: ['Fix grammar and style', 'Summarize in 3 bullets', 'Turn this into a todo list', 'Translate to Ukrainian'],
		prompt: ['Make the prompt stricter', 'Add an output format section', 'Shorten the prompt', 'Translate to Ukrainian'],
		summary: ['Extract the action items', 'Shorten to 2 sentences', 'What did we decide?', 'Make it more detailed'],
		todo: []
	};

	const suggestions = $derived(SUGGESTIONS[note.type] ?? SUGGESTIONS.text);

	async function openChat() {
		chatOpen = !chatOpen;
		if (!chatOpen) {
			stopMic();
			return;
		}
		if (messages.length === 0) {
			try {
				const res = await api.get<{ messages: ChatMsg[] }>(`/api/notes/${note.id}/chat`);
				messages = res.messages;
			} catch {
				chatError = 'Could not load the conversation';
			}
		}
		scrollChat();
		queueMicrotask(() => chatInputEl?.focus());
	}

	async function sendChat() {
		const text = chatInput.trim();
		if (!text || chatBusy) return;
		chatInput = '';
		chatBusy = true;
		chatError = '';
		streaming = '';
		// optimistic user message
		messages = [...messages, { id: -Date.now(), role: 'user', content: text, createdAt: Date.now() }];
		scrollChat();
		try {
			await api.stream(`/api/notes/${note.id}/chat`, { message: text }, (chunk) => {
				streaming += chunk;
				scrollChat();
			});
			if (streaming.trim()) {
				messages = [...messages, { id: -2, role: 'assistant', content: streaming, createdAt: Date.now() }];
			}
		} catch (e) {
			chatError = e instanceof Error ? e.message : 'Chat failed';
		} finally {
			streaming = '';
			chatBusy = false;
			scrollChat();
		}
	}

	// --- voice control ---

	function toggleMic() {
		if (micOn) {
			finishMic();
			return;
		}
		if (chatBusy) return;
		micError = '';
		micText = '';
		micOn = true;
		dictation
			.start({
				onText: (_fin, _tail) => (micText = dictation.text),
				onError: (err) => {
					micError = err.message || 'Dictation failed';
					stopMic();
				}
			})
			.catch((e: unknown) => {
				micError = e instanceof Error ? e.message : 'Dictation failed';
				stopMic();
			});
	}

	/** Stops listening and inserts the recognized text into the input (editable). */
	async function finishMic() {
		micOn = false;
		const text = await dictation.stop();
		const merged = chatInput.trim();
		const combined = merged ? `${merged} ${text}`.trim() : text;
		if (combined) {
			chatInput = combined;
			queueMicrotask(() => {
				chatInputEl?.focus();
				chatInputEl?.setSelectionRange(chatInput.length, chatInput.length);
			});
		}
		micText = '';
	}

	function stopMic() {
		if (micOn) {
			micOn = false;
			dictation.cancel();
			micText = '';
		}
	}

	function clearChat() {
		messages = [];
		streaming = '';
		chatError = '';
		api.del(`/api/notes/${note.id}/chat`).catch(() => {});
	}

	function scrollChat() {
		queueMicrotask(() => {
			const el = document.getElementById(`chat-scroll-${note.id}`);
			if (el) el.scrollTop = el.scrollHeight;
		});
	}

	// stop the mic if the component is ever torn down mid-dictation
	$effect(() => () => stopMic());
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
		{#if editing}
			<div class="edit-box">
				<textarea rows="6" bind:value={editText}></textarea>
				<div class="row">
					<button class="btn btn-primary" onclick={saveEdit} disabled={savingEdit}>
						{#if savingEdit}<span class="spinner"></span>{/if}
						Save
					</button>
					<button class="btn btn-ghost" onclick={() => (editing = false)} disabled={savingEdit}>Cancel</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button class="btn btn-ghost small-btn" onclick={startEdit}>✏️ Edit text</button>
				{#if chatSupported}
					<button class="btn btn-ghost small-btn" class:chat-active={chatOpen} onclick={openChat}>
						💬 {chatOpen ? 'Hide chat' : 'Chat'}
					</button>
				{/if}
				{#if confirming}
					<button class="btn btn-danger" onclick={() => ondelete(note.id)}>Confirm delete</button>
					<button class="btn btn-ghost" onclick={() => (confirming = false)}>Keep</button>
				{:else}
					<button class="btn btn-ghost del" onclick={() => (confirming = true)}>🗑 Delete</button>
				{/if}
			</div>

			<details class="raw">
				<summary class="faint">Raw transcript</summary>
				<p class="muted raw-text">{note.transcript}</p>
			</details>

			{#if chatOpen}
				<div class="chat">
					<div class="chat-head">
						<span class="faint chat-title">💬 Chat about this note</span>
						<button class="faint link-btn" onclick={clearChat} disabled={chatBusy || messages.length === 0}>clear</button>
					</div>
					<div class="chat-scroll" id={`chat-scroll-${note.id}`}>
						{#if messages.length === 0 && !streaming && !chatBusy}
							<p class="faint chat-hint">Ask anything about this note, or use the mic 🎙 — text lands in the input so you can edit before sending.</p>
							<div class="suggest">
								{#each suggestions as s (s)}
									<button class="chip suggest-chip" onclick={() => { chatInput = s; chatInputEl?.focus(); }}>{s}</button>
								{/each}
							</div>
						{/if}
						{#each messages as m (m.id)}
							<div class="msg" class:me={m.role === 'user'}>
								<div class="bubble">{m.content}</div>
							</div>
						{/each}
						{#if streaming}
							<div class="msg">
								<div class="bubble">{streaming}</div>
							</div>
						{/if}
						{#if chatBusy && !streaming}
							<div class="msg">
								<div class="bubble typing"><span></span><span></span><span></span></div>
							</div>
						{/if}
						{#if chatError}<p class="error-text">{chatError}</p>{/if}
					</div>
					{#if micOn}
						<div class="listening">
							<span class="dot pulse"></span>
							<span class="listening-text">{micText || 'listening…'}</span>
							<button class="link-btn faint" onclick={finishMic}>done</button>
							<button class="link-btn faint" onclick={stopMic}>cancel</button>
						</div>
					{/if}
					{#if micError}<p class="error-text mic-error">{micError}</p>{/if}
					<form
						class="chat-form"
						onsubmit={(e) => {
							e.preventDefault();
							sendChat();
						}}
					>
						<button
							class="mic"
							class:on={micOn}
							type="button"
							title={micOn ? 'Stop — text will be placed in the input' : 'Dictate (text is NOT sent automatically)'}
							onclick={toggleMic}
							aria-label="Voice input"
						>
							{micOn ? '⏹' : '🎙'}
						</button>
						<input
							placeholder={micOn ? 'Listening… tap ⏹ when done' : chatBusy ? 'Thinking…' : 'Ask about this note…'}
							bind:this={chatInputEl}
							bind:value={chatInput}
							onkeydown={(e) => {
								if (e.key === 'Enter' && micOn) e.preventDefault(); // let the user finish dictating
							}}
							disabled={chatBusy}
						/>
						<button class="btn btn-primary send" type="submit" disabled={chatBusy || !chatInput.trim()} aria-label="Send">
							{chatBusy ? '…' : '➤'}
						</button>
					</form>
				</div>
			{/if}
		{/if}
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

	.small-btn {
		font-size: 13px;
		padding: 8px 12px;
	}

	.chat-active {
		border-color: rgba(139, 92, 246, 0.5);
		color: var(--accent-soft);
	}

	.edit-box {
		margin-top: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.edit-box textarea {
		resize: vertical;
	}

	.raw {
		margin-top: 10px;
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

	/* --- chat --- */

	.chat {
		margin-top: 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--bg);
		display: flex;
		flex-direction: column;
	}

	.chat-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px 4px;
	}

	.chat-title {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.link-btn {
		font-size: 12px;
		text-decoration: underline;
	}

	.chat-scroll {
		max-height: 320px;
		overflow-y: auto;
		padding: 8px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.chat-hint {
		font-size: 13px;
	}

	.msg {
		display: flex;
	}

	.msg.me {
		justify-content: flex-end;
	}

	.bubble {
		max-width: 85%;
		padding: 8px 12px;
		border-radius: 14px;
		background: var(--bg-card);
		border: 1px solid var(--line);
		font-size: 14px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.msg.me .bubble {
		background: var(--accent-dim);
		border-color: rgba(139, 92, 246, 0.4);
	}

	.suggest {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 6px;
	}

	.suggest-chip {
		background: var(--bg-card);
		border: 1px solid var(--line);
		color: var(--text-muted);
		font-size: 12px;
	}

	.suggest-chip:hover {
		color: var(--accent-soft);
		border-color: rgba(139, 92, 246, 0.4);
	}

	/* animated typing indicator */
	.typing {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 10px 14px;
	}

	.typing span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-faint);
		animation: blink 1.2s infinite ease-in-out;
	}

	.typing span:nth-child(2) {
		animation-delay: 0.2s;
	}

	.typing span:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.25;
			transform: translateY(0);
		}
		40% {
			opacity: 1;
			transform: translateY(-2px);
		}
	}

	/* live dictation bar */
	.listening {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 12px 0;
		font-size: 13px;
	}

	.listening-text {
		flex: 1;
		min-width: 0;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--danger);
		flex-shrink: 0;
	}

	.dot.pulse {
		animation: dotpulse 1s infinite;
	}

	@keyframes dotpulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.5);
		}
		50% {
			box-shadow: 0 0 0 6px rgba(244, 63, 94, 0);
		}
	}

	.mic-error {
		padding: 4px 12px 0;
	}

	.chat-form {
		display: flex;
		gap: 8px;
		padding: 8px 10px 10px;
	}

	.mic {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		font-size: 15px;
		background: var(--bg-card);
		border: 1px solid var(--line);
		transition: background 0.15s, border-color 0.15s;
	}

	.mic:hover {
		border-color: rgba(139, 92, 246, 0.45);
	}

	.mic.on {
		background: var(--danger-dim);
		border-color: rgba(244, 63, 94, 0.6);
		animation: dotpulse 1s infinite;
	}

	.chat-form input {
		flex: 1;
		min-width: 0;
		padding: 9px 12px;
		font-size: 14px;
		border-radius: var(--radius-pill);
	}

	.send {
		padding: 0 14px;
		border-radius: var(--radius-pill);
		flex-shrink: 0;
	}
</style>
