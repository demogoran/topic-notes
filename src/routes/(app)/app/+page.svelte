<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageProps } from './$types';
	import { api } from '#lib/client/api';
	import { Recorder, type RecordingResult } from '#lib/client/recorder';
	import { LocalStt, STT_ENGINES, type SttEngine, type SttLang } from '#lib/client/localStt';
	import { formatDuration } from '#lib/client/format';
	import RecordOrb from '#lib/components/RecordOrb.svelte';
	import CategoryChip from '#lib/components/CategoryChip.svelte';
	import NoteCard from '#lib/components/NoteCard.svelte';
	import type { Category, NoteWithCategories, ProposedCategory } from '#lib/shared/types';

	let { data }: PageProps = $props();

	type Tab = 'capture' | 'notes';
	type Phase = 'idle' | 'recording' | 'loading' | 'transcribing' | 'organizing' | 'review';

	let tab = $state<Tab>('capture');
	let phase = $state<Phase>('idle');
	let lang = $state<'en' | 'uk' | 'auto'>('uk');
	let elapsed = $state(0);
	let level = $state(0);
	let errorMessage = $state('');

	// review state
	let transcript = $state('');
	let cleanedText = $state('');
	let proposed = $state<ProposedCategory[]>([]);
	let selectedIds = $state<number[]>([]);
	let newCatName = $state('');
	let saving = $state(false);

	// notes tab state
	let notes = $state<NoteWithCategories[]>([]);
	let categories = $state<Category[]>([]);
	let notesLoading = $state(true);
	let activeFilter = $state<number | 'all'>('all');
	let search = $state('');

	let recorder: Recorder | null = null;

	// --- local (in-browser) speech recognition ---
	const stt = new LocalStt();
	const storedEngine = (typeof localStorage !== 'undefined'
		? (localStorage.getItem('stt.engine') as SttEngine | null)
		: null) ?? 'parakeet';
	const initialEngine: SttEngine = STT_ENGINES[storedEngine] ? storedEngine : 'whisper';
	let engineId = $state<SttEngine>(initialEngine);
	let modelId = $state(
		(typeof localStorage !== 'undefined' ? localStorage.getItem('stt.model') : null) ??
			STT_ENGINES[initialEngine].models[0].value
	);
	let sttProgress = $state<{ pct: number; text: string } | null>(null);
	const modelOptions = $derived(STT_ENGINES[engineId].models);
	const langSupported = $derived(STT_ENGINES[engineId].supportsLang);

	// --- live (real-time) transcription ---
	let liveText = $state('');
	let segChain: Promise<void> = Promise.resolve();
	let segBusy = $state(0);

	const filteredNotes = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return notes.filter((n) => {
			const matchCat = activeFilter === 'all' || n.categories.some((c) => c.id === activeFilter);
			const matchQ = q === '' || n.text.toLowerCase().includes(q);
			return matchCat && matchQ;
		});
	});

	async function toggleRecording() {
		errorMessage = '';
		if (phase === 'recording') {
			await stopAndProcess();
			return;
		}
		if (phase !== 'idle') return;
		if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
			errorMessage = 'Audio recording is not supported in this browser.';
			return;
		}
		try {
			recorder ??= new Recorder();
			recorder.onLevel = (v) => (level = v);
			recorder.onTick = (s) => (elapsed = s);
			recorder.onSegment = handleSegment;
			phase = 'recording';
			elapsed = 0;
			liveText = '';
			await recorder.start();
			beginModelLoad(); // warm up the model while the user speaks
		} catch (e) {
			phase = 'idle';
			errorMessage = e instanceof Error ? e.message : 'Could not start recording';
		}
	}

	/** Transcribes one live utterance segment; segments run strictly in order. */
	function handleSegment(pcm: Float32Array) {
		segBusy++;
		segChain = segChain.then(async () => {
			try {
				// load() is a no-op once ready; reuses the in-flight promise otherwise
				await stt.load(engineId, modelId, (p) => (sttProgress = p));
				const text = (await stt.transcribe(pcm, lang)).trim();
				if (text) liveText = liveText ? `${liveText} ${text}` : text;
			} catch (e) {
				console.warn('Live segment transcription failed:', e);
			} finally {
				segBusy--;
			}
		});
	}

	/** Kicks off model loading in the background (no await) with progress UI. */
	function beginModelLoad() {
		if (stt.isReady(engineId, modelId)) return;
		sttProgress = { pct: 0, text: 'Preparing speech model…' };
		stt
			.load(engineId, modelId, (p) => (sttProgress = p))
			.then(() => (sttProgress = null))
			.catch((e: unknown) => {
				sttProgress = null;
				// surfaced again on stop; keep recording meanwhile
				console.warn('Model load failed:', e);
			});
	}

	async function ensureModelLoaded() {
		if (stt.isReady(engineId, modelId)) return;
		phase = 'loading';
		try {
			await stt.load(engineId, modelId, (p) => (sttProgress = p));
		} finally {
			sttProgress = null;
		}
	}

	function onEngineChange(e: Event) {
		engineId = (e.currentTarget as HTMLSelectElement).value as SttEngine;
		modelId = STT_ENGINES[engineId].models[0].value;
		persistSttChoice();
	}

	function onModelChange(e: Event) {
		modelId = (e.currentTarget as HTMLSelectElement).value;
		persistSttChoice();
	}

	function persistSttChoice() {
		try {
			localStorage.setItem('stt.engine', engineId);
			localStorage.setItem('stt.model', modelId);
		} catch {
			/* private mode — ignore */
		}
	}

	async function stopAndProcess() {
		if (!recorder) return;
		let rec: RecordingResult | null = null;
		try {
			rec = await recorder.stop(); // emits the final live segment first
		} catch (e) {
			// too short / failed — but live text may still exist
			if (!liveText.trim()) {
				phase = 'idle';
				errorMessage = e instanceof Error ? e.message : 'Recording failed';
				return;
			}
		}
		try {
			// wait for any in-flight segment transcriptions to finish
			phase = 'transcribing';
			await segChain;

			if (liveText.trim()) {
				transcript = liveText.trim();
			} else {
				// no segments were recognized live — transcribe the whole clip
				if (!rec) throw new Error('Nothing was recorded');
				await ensureModelLoaded();
				transcript = await stt.transcribe(rec.pcm, lang);
			}
			if (!transcript.trim()) {
				throw new Error('Nothing was recognized — try speaking louder or closer to the mic.');
			}

			phase = 'organizing';
			const org = await api.post<{
				text: string;
				language: 'en' | 'uk';
				proposed: ProposedCategory[];
			}>('/api/organize', { transcript });

			cleanedText = org.text || transcript;
			proposed = org.proposed;
			categories = await refreshCategories();
			selectedIds = proposed.filter((p) => p.categoryId !== null).map((p) => p.categoryId!);
			newCatName = '';
			phase = 'review';
		} catch (e) {
			phase = 'idle';
			errorMessage = e instanceof Error ? e.message : 'Processing failed';
		}
	}

	function toggleProposal(p: ProposedCategory) {
		if (p.categoryId === null) {
			// new category: toggling via text selection is handled at save time
			return;
		}
		selectedIds = selectedIds.includes(p.categoryId)
			? selectedIds.filter((id) => id !== p.categoryId)
			: [...selectedIds, p.categoryId];
	}

	const isProposalSelected = (p: ProposedCategory) =>
		p.categoryId !== null && selectedIds.includes(p.categoryId);

	async function saveNote() {
		if (saving) return;
		saving = true;
		errorMessage = '';
		try {
			// existing selected + any non-empty "new category" text (could be comma-separated)
			const newNames = newCatName
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const names = [
				...proposed.filter(isProposalSelected).map((p) => p.name),
				...newNames
			];
			await api.post('/api/notes', {
				text: cleanedText || transcript,
				transcript,
				status: 'final',
				categories: names
			});
			resetCapture();
			tab = 'notes';
			await loadNotes();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Could not save the note';
		} finally {
			saving = false;
		}
	}

	function discard() {
		resetCapture();
	}

	function resetCapture() {
		phase = 'idle';
		transcript = '';
		cleanedText = '';
		proposed = [];
		selectedIds = [];
		newCatName = '';
		level = 0;
		elapsed = 0;
		errorMessage = '';
		liveText = '';
	}

	async function refreshCategories(): Promise<Category[]> {
		const { categories: cats } = await api.get<{ categories: Category[] }>('/api/categories');
		return cats;
	}

	async function loadNotes() {
		notesLoading = true;
		try {
			const res = await api.get<{ notes: NoteWithCategories[] }>('/api/notes');
			notes = res.notes;
		} finally {
			notesLoading = false;
		}
	}

	async function deleteNote(id: number) {
		await api.del(`/api/notes/${id}`);
		notes = notes.filter((n) => n.id !== id);
	}

	async function switchTab(t: Tab) {
		tab = t;
		if (t === 'notes') {
			categories = await refreshCategories().catch(() => categories);
			await loadNotes();
		}
	}

	async function deleteCategory(id: number) {
		await api.del(`/api/categories/${id}`);
		categories = categories.filter((c) => c.id !== id);
		if (activeFilter === id) activeFilter = 'all';
		await loadNotes();
	}
</script>

<svelte:head>
	<title>{tab === 'capture' ? 'Capture' : 'Notes'} · VoiceNotes</title>
</svelte:head>

{#if tab === 'capture'}
	<section class="capture">
		<!-- language selector -->
		<div class="seg" role="tablist" aria-label="Language">
			{#each ['auto', 'en', 'uk'] as l (l)}
				<button
					class="seg-item"
					class:active={lang === l}
					class:dimmed={!langSupported}
					title={!langSupported ? 'Applies to Whisper — Parakeet auto-detects the language' : ''}
					onclick={() => (lang = l as SttLang)}
				>
					{l === 'auto' ? '🌐 Auto' : l === 'en' ? 'EN' : 'UA'}
				</button>
			{/each}
		</div>

		<!-- speech engine + model -->
		<div class="stt-config">
			<select aria-label="Speech engine" onchange={onEngineChange} disabled={phase !== 'idle'}>
				<option value="whisper" selected={engineId === 'whisper'}>Whisper</option>
				<option value="parakeet" selected={engineId === 'parakeet'}>Parakeet v3 · auto</option>
			</select>
			<select aria-label="Speech model" onchange={onModelChange} disabled={phase !== 'idle'}>
				{#each modelOptions as m (m.value)}
					<option value={m.value} selected={modelId === m.value}>{m.label}</option>
				{/each}
			</select>
		</div>

		<!-- orb + timer -->
		<div class="stage">
			<RecordOrb
				recording={phase === 'recording'}
				processing={phase === 'loading' || phase === 'transcribing' || phase === 'organizing'}
				level={phase === 'recording' ? level : 0}
				onclick={toggleRecording}
			/>
			<p class="hint" class:rec={phase === 'recording'}>
				{#if phase === 'recording'}
					<span class="timer">{formatDuration(elapsed)}</span> — tap to stop
				{:else if phase === 'loading'}
					{sttProgress?.text ?? 'Loading speech model…'}
				{:else if phase === 'transcribing'}
					Transcribing…
				{:else if phase === 'organizing'}
					Organizing…
				{:else}
					Tap to record a note
				{/if}
			</p>
			{#if sttProgress && (phase === 'recording' || phase === 'loading')}
				<div class="dl-bar"><div class="dl-fill" style:width={`${sttProgress.pct}%`}></div></div>
			{/if}

			<!-- live transcript while recording / finishing -->
			{#if liveText && (phase === 'recording' || phase === 'transcribing')}
				<div class="live-box">
					<p class="live-label faint">{segBusy > 0 ? 'transcribing…' : 'live'}</p>
					<p class="live-text">{liveText}</p>
				</div>
			{/if}
			{#if errorMessage && phase === 'idle'}<p class="error-text">{errorMessage}</p>{/if}
		</div>

		<!-- review card -->
		{#if phase === 'review'}
			<div class="review card">
				<label class="label" for="note-text">Note text</label>
				<textarea id="note-text" rows="5" bind:value={cleanedText}></textarea>

				<details class="raw">
					<summary class="faint">Raw transcript</summary>
					<p class="muted raw-text">{transcript}</p>
				</details>

				<p class="label sect">Categories</p>
				<div class="chips">
					{#each proposed as p (p.name)}
						<CategoryChip
							name={p.name}
							selected={isProposalSelected(p)}
							dimmed={p.categoryId !== null && !isProposalSelected(p)}
							onclick={() => toggleProposal(p)}
						/>
					{/each}
					{#if proposed.length === 0}
						<span class="muted small">No suggestions — add one below.</span>
					{/if}
				</div>

				{#if categories.length > 0}
					<p class="label sect">Your categories</p>
					<div class="chips">
						{#each categories as c (c.id)}
							<CategoryChip
								name={c.name}
								selected={selectedIds.includes(c.id)}
								onclick={() =>
									(selectedIds = selectedIds.includes(c.id)
										? selectedIds.filter((id) => id !== c.id)
										: [...selectedIds, c.id])}
							/>
						{/each}
					</div>
				{/if}

				<div class="field newcat">
					<label class="label" for="new-cat">New category (comma-separated for several)</label>
					<input id="new-cat" placeholder="e.g. Grocery list" bind:value={newCatName} />
				</div>

				{#if errorMessage}<p class="error-text">{errorMessage}</p>{/if}

				<div class="row">
					<button class="btn btn-primary grow" onclick={saveNote} disabled={saving}>
						{#if saving}<span class="spinner"></span>{/if}
						Save note
					</button>
					<button class="btn btn-ghost" onclick={discard} disabled={saving}>Discard</button>
				</div>
			</div>
		{/if}
	</section>
{:else}
	<section class="notes">
		<div class="field">
			<input
				type="search"
				placeholder="Search notes…"
				bind:value={search}
				aria-label="Search notes"
			/>
		</div>

		<div class="chips filter-chips">
			<button
				class="chip all-chip"
				class:active={activeFilter === 'all'}
				onclick={() => (activeFilter = 'all')}
			>
				All
			</button>
			{#each categories as c (c.id)}
				<CategoryChip
					name={c.name}
					selected={activeFilter === c.id}
					onclick={() => (activeFilter = activeFilter === c.id ? 'all' : c.id)}
				/>
			{/each}
			<span class="manage-hint faint">long-press to manage</span>
		</div>

		<div class="note-list">
			{#if notesLoading}
				<p class="muted">Loading…</p>
			{:else if filteredNotes.length === 0}
				<div class="empty card">
					<p>{search || activeFilter !== 'all' ? 'Nothing matches the filter.' : 'No notes yet.'}</p>
					{#if !search && activeFilter === 'all'}
						<button class="btn btn-primary" onclick={() => switchTab('capture')}>Record your first note</button>
					{/if}
				</div>
			{:else}
				{#each filteredNotes as note (note.id)}
					<NoteCard {note} ondelete={deleteNote} />
				{/each}
			{/if}
		</div>
	</section>
{/if}

<nav class="tabbar" aria-label="Main">
	<button class="tab" class:active={tab === 'capture'} onclick={() => switchTab('capture')}>
		<span class="tab-ico">⏺</span> Capture
	</button>
	<button class="tab" class:active={tab === 'notes'} onclick={() => switchTab('notes')}>
		<span class="tab-ico">🗂</span> Notes
	</button>
</nav>

<style>
	.capture {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 20px;
		padding-top: 12px;
	}

	.seg {
		display: inline-flex;
		background: var(--bg-card);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		padding: 4px;
		gap: 2px;
	}

	.seg-item {
		padding: 7px 16px;
		border-radius: var(--radius-pill);
		font-size: 13px;
		font-weight: 600;
		color: var(--text-muted);
		transition: background 0.15s, color 0.15s;
	}

	.seg-item.active {
		background: var(--accent-dim);
		color: var(--accent-soft);
	}

	.seg-item:disabled {
		opacity: 0.35;
	}

	.seg-item.dimmed {
		opacity: 0.4;
	}

	.stt-config {
		display: flex;
		gap: 8px;
	}

	.stt-config select {
		background: var(--bg-card);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: 13px;
		padding: 7px 12px;
		max-width: 200px;
	}

	.dl-bar {
		width: 180px;
		height: 4px;
		border-radius: 2px;
		background: var(--bg-card);
		overflow: hidden;
	}

	.dl-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.15s;
	}

	.live-box {
		max-width: 560px;
		background: var(--bg-card);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 10px 14px;
	}

	.live-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.live-text {
		font-size: 15px;
		white-space: pre-wrap;
		max-height: 180px;
		overflow-y: auto;
	}

	.stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 28px 0 8px;
	}

	.hint {
		font-size: 14px;
		color: var(--text-muted);
		min-height: 21px;
	}

	.hint.rec {
		color: var(--danger);
	}

	.timer {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}

	.review {
		width: 100%;
		animation: rise 0.35s ease both;
	}

	.review textarea {
		resize: vertical;
		min-height: 110px;
	}

	.sect {
		margin-top: 16px;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 4px;
	}

	.small {
		font-size: 13px;
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

	.newcat {
		margin-top: 16px;
	}

	.row {
		display: flex;
		gap: 10px;
		margin-top: 8px;
	}

	.grow {
		flex: 1;
	}

	/* notes tab */
	.notes {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.filter-chips {
		gap: 8px;
		align-items: center;
	}

	.all-chip {
		background: var(--accent-dim);
		border-color: rgba(139, 92, 246, 0.4);
		color: var(--accent-soft);
	}

	.all-chip.active {
		background: var(--accent);
		color: #fff;
	}

	.manage-hint {
		font-size: 12px;
		display: none;
	}

	.note-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.empty {
		text-align: center;
		padding: 32px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: center;
	}

	/* bottom tab bar */
	.tabbar {
		position: fixed;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(12px + var(--safe-bottom));
		display: flex;
		gap: 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		padding: 6px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
		z-index: 10;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 22px;
		border-radius: var(--radius-pill);
		font-size: 14px;
		font-weight: 600;
		color: var(--text-muted);
		transition: background 0.15s, color 0.15s;
	}

	.tab.active {
		background: linear-gradient(135deg, var(--accent), #6d28d9);
		color: #fff;
		box-shadow: 0 4px 14px var(--accent-glow);
	}

	.tab-ico {
		font-size: 13px;
	}

	/* leave room for the floating bar */
	:global(main) {
		padding-bottom: 96px;
	}

	@media (min-width: 700px) {
		.manage-hint {
			display: inline;
		}
	}
</style>
