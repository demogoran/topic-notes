<script lang="ts">
  import { goto } from "$app/navigation";
  import type { PageProps } from "./$types";
  import { api } from "#lib/client/api";
  import { Recorder, type RecordingResult } from "#lib/client/recorder";
  import {
    LocalStt,
    STT_ENGINES,
    type SttEngine,
    type SttLang,
  } from "#lib/client/localStt";
  import { SonioxStt } from "#lib/client/sonioxStt";
  import { formatDuration } from "#lib/client/format";
  import RecordOrb from "#lib/components/RecordOrb.svelte";
  import CategoryChip from "#lib/components/CategoryChip.svelte";
  import NoteCard from "#lib/components/NoteCard.svelte";
  import type {
    Category,
    NoteType,
    NoteTypeInfo,
    NoteWithCategories,
    ProposedCategory,
    ProposedTodo,
  } from "#lib/shared/types";
  import { NOTE_TYPES } from "#lib/shared/types";

  let { data }: PageProps = $props();

  type Tab = "capture" | "notes";
  type Phase =
    | "idle"
    | "recording"
    | "loading"
    | "transcribing"
    | "transcriptEdit"
    | "detecting"
    | "typeSelect"
    | "formatting"
    | "review";

  let tab = $state<Tab>("capture");
  let phase = $state<Phase>("idle");
  let lang = $state<"en" | "uk" | "auto">("uk");
  let elapsed = $state(0);
  let level = $state(0);
  let errorMessage = $state("");

  // --- capture workflow state (transcribe → detect type → user picks → format) ---
  let transcript = $state("");
  let aiType = $state<NoteType>("text");
  let aiReason = $state("");
  let typeInfos = $state<NoteTypeInfo[]>([]);
  let selectedType = $state<NoteType>("text");

  // format result (type-specific)
  let fmtText = $state("");
  let fmtLanguage = $state<"en" | "uk">("en");
  let proposed = $state<ProposedCategory[]>([]);
  let proposedTodos = $state<ProposedTodo[]>([]);
  /** Editable checklist draft during review (todo type). */
  let draftTodos = $state<{ text: string; done: boolean; tags: string[] }[]>(
    [],
  );
  /** Selected category names (case-insensitive). Includes new ones — the API creates them. */
  let selectedNames = $state<string[]>([]);
  let newCatName = $state("");
  let saving = $state(false);

  // notes tab state
  let notes = $state<NoteWithCategories[]>([]);
  let categories = $state<Category[]>([]);
  let notesLoading = $state(true);
  let activeFilter = $state<number | "all">("all");
  let search = $state("");

  let recorder: Recorder | null = null;

  /**
   * Flow generation counter: bumped on reset/close so late-resolving AI
   * responses from an abandoned flow are ignored.
   */
  let gen = 0;

  // --- microphone capture mode ---
  type MicMode = "raw" | "enhanced";
  const storedMic =
    typeof localStorage !== "undefined"
      ? (localStorage.getItem("mic.mode") as MicMode | null)
      : null;
  let micMode = $state<MicMode>(storedMic === "raw" ? "raw" : "enhanced");

  function onMicModeChange(e: Event) {
    micMode = (e.currentTarget as HTMLSelectElement).value as MicMode;
    try {
      localStorage.setItem("mic.mode", micMode);
    } catch {
      /* private mode — ignore */
    }
  }

  // --- speech recognition engine selection ---
  const stt = new LocalStt();
  // Key bumped to v2 so the new default applies once instead of being
  // overridden by engines persisted by earlier versions.
  const storedEngine =
    (typeof localStorage !== "undefined"
      ? (localStorage.getItem("stt.engine.v2") as SttEngineId | null)
      : null) ?? "soniox";
  const initialEngine: SttEngineId =
    storedEngine === "soniox" || STT_ENGINES[storedEngine as SttEngine]
      ? storedEngine
      : "soniox";
  let engineId = $state<SttEngineId>(initialEngine);
  let modelId = $state(
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("stt.model")
      : null) ??
      (initialEngine === "soniox"
        ? STT_ENGINES.whisper.models[0].value
        : STT_ENGINES[initialEngine as SttEngine].models[0].value),
  );
  let sttProgress = $state<{ pct: number; text: string } | null>(null);
  const modelOptions = $derived(
    STT_ENGINES[engineId as SttEngine]?.models ?? [],
  );
  const langSupported = $derived(
    STT_ENGINES[engineId as SttEngine]?.supportsLang ?? true,
  );

  // --- live (real-time) transcription ---
  let liveText = $state("");
  let segChain: Promise<void> = Promise.resolve();
  let segBusy = $state(0);
  let sonioxState = $state("idle");

  /** Engine id: local engines (whisper/parakeet) or the cloud engine (soniox). */
  type SttEngineId = SttEngine | "soniox";
  const soniox = new SonioxStt();
  const usingSoniox = $derived(engineId === "soniox");

  // --- notes tab filtering (tags aggregate across todolists) ---
  const activeTag = $derived(
    activeFilter === "all"
      ? null
      : (categories.find((c) => c.id === activeFilter) ?? null),
  );

  const filteredNotes = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return notes.filter((n) => {
      const tagMatch =
        activeFilter === "all" ||
        n.categories.some((c) => c.id === activeFilter) ||
        n.todoItems.some((t) => t.tags.some((tg) => tg.id === activeFilter));
      const textMatch =
        q === "" ||
        n.text.toLowerCase().includes(q) ||
        n.transcript.toLowerCase().includes(q) ||
        n.categories.some((c) => c.name.toLowerCase().includes(q)) ||
        n.todoItems.some(
          (t) =>
            t.text.toLowerCase().includes(q) ||
            t.tags.some((tg) => tg.name.toLowerCase().includes(q)),
        );
      return tagMatch && textMatch;
    });
  });

  /** All tasks (across every todolist) matching the active tag — the aggregation view. */
  const aggregatedTasks = $derived.by(() => {
    if (!activeTag) return [];
    const q = search.trim().toLowerCase();
    const out: {
      note: NoteWithCategories;
      itemId: number;
      text: string;
      done: boolean;
      tags: { id: number; name: string }[];
    }[] = [];
    for (const n of notes) {
      for (const t of n.todoItems) {
        const tagHit = t.tags.some((tg) => tg.id === activeFilter);
        const qHit =
          q === "" ||
          t.text.toLowerCase().includes(q) ||
          t.tags.some((tg) => tg.name.toLowerCase().includes(q));
        if (tagHit && qHit) {
          out.push({
            note: n,
            itemId: t.id,
            text: t.text,
            done: t.done,
            tags: t.tags,
          });
        }
      }
    }
    return out;
  });

  async function toggleRecording() {
    errorMessage = "";
    if (phase === "recording") {
      await stopAndProcess();
      return;
    }
    if (phase !== "idle") return;

    if (usingSoniox) {
      // cloud engine: capture + WebSocket stream, tokens arrive live
      phase = "recording";
      elapsed = 0;
      liveText = "";
      sonioxState = "starting";
      try {
        await soniox.start({
          lang,
          enhanced: micMode === "enhanced",
          onLevel: (v) => (level = v),
          onTick: (s) => (elapsed = s),
          onText: (fin, tail) => (liveText = `${fin}${tail}`),
          onState: (s) => (sonioxState = s),
          onError: (err) => {
            level = 0;
            phase = "idle";
            sonioxState = "error";
            errorMessage = err.message || "Speech service error";
          },
        });
      } catch (e) {
        phase = "idle";
        errorMessage =
          e instanceof Error ? e.message : "Could not start the speech service";
      }
      return;
    }

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined"
    ) {
      errorMessage = "Audio recording is not supported in this browser.";
      return;
    }
    try {
      recorder ??= new Recorder();
      recorder.onLevel = (v) => (level = v);
      recorder.onTick = (s) => (elapsed = s);
      recorder.onSegment = handleSegment;
      phase = "recording";
      elapsed = 0;
      liveText = "";
      await recorder.start({ enhanced: micMode === "enhanced" });
      beginModelLoad(); // warm up the model while the user speaks
    } catch (e) {
      phase = "idle";
      errorMessage =
        e instanceof Error ? e.message : "Could not start recording";
    }
  }

  /** Transcribes one live utterance segment; segments run strictly in order. */
  function handleSegment(pcm: Float32Array) {
    segBusy++;
    segChain = segChain.then(async () => {
      try {
        // load() is a no-op once ready; reuses the in-flight promise otherwise
        await stt.load(
          engineId as SttEngine,
          modelId,
          (p) => (sttProgress = p),
        );
        const text = (await stt.transcribe(pcm, lang)).trim();
        if (text) liveText = liveText ? `${liveText} ${text}` : text;
      } catch (e) {
        console.warn("Live segment transcription failed:", e);
      } finally {
        segBusy--;
      }
    });
  }

  /** Kicks off model loading in the background (no await) with progress UI. */
  function beginModelLoad() {
    if (usingSoniox || stt.isReady(engineId as SttEngine, modelId)) return;
    sttProgress = { pct: 0, text: "Preparing speech model…" };
    stt
      .load(engineId as SttEngine, modelId, (p) => (sttProgress = p))
      .then(() => (sttProgress = null))
      .catch((e: unknown) => {
        sttProgress = null;
        // surfaced again on stop; keep recording meanwhile
        console.warn("Model load failed:", e);
      });
  }

  async function ensureModelLoaded() {
    if (usingSoniox || stt.isReady(engineId as SttEngine, modelId)) return;
    phase = "loading";
    try {
      await stt.load(engineId as SttEngine, modelId, (p) => (sttProgress = p));
    } finally {
      sttProgress = null;
    }
  }

  function onEngineChange(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value as SttEngineId;
    engineId = value;
    if (!usingSoniox) modelId = STT_ENGINES[value as SttEngine].models[0].value;
    persistSttChoice();
  }

  function onModelChange(e: Event) {
    modelId = (e.currentTarget as HTMLSelectElement).value;
    persistSttChoice();
  }

  function persistSttChoice() {
    try {
      localStorage.setItem("stt.engine.v2", engineId);
      localStorage.setItem("stt.model", modelId);
    } catch {
      /* private mode — ignore */
    }
  }

  async function stopAndProcess() {
    if (usingSoniox) {
      if (!soniox.active) return;
      phase = "transcribing";
      try {
        transcript = await soniox.stop();
      } catch (e) {
        phase = "idle";
        errorMessage =
          e instanceof Error ? e.message : "The speech service failed";
        return;
      }
      sonioxState = "idle";
    } else {
      if (!recorder) return;
      let rec: RecordingResult | null = null;
      try {
        rec = await recorder.stop(); // emits the final live segment first
      } catch (e) {
        // too short / failed — but live text may still exist
        if (!liveText.trim()) {
          phase = "idle";
          errorMessage = e instanceof Error ? e.message : "Recording failed";
          return;
        }
      }
      try {
        // wait for any in-flight segment transcriptions to finish
        phase = "transcribing";
        await segChain;

        if (liveText.trim()) {
          transcript = liveText.trim();
        } else {
          // no segments were recognized live — transcribe the whole clip
          if (!rec) throw new Error("Nothing was recorded");
          await ensureModelLoaded();
          transcript = await stt.transcribe(rec.pcm, lang);
        }
      } catch (e) {
        phase = "idle";
        errorMessage = e instanceof Error ? e.message : "Processing failed";
        return;
      }
    }

    if (!transcript.trim()) {
      phase = "idle";
      errorMessage =
        "Nothing was recognized — try speaking louder or closer to the mic.";
      return;
    }

    // Let the user fix recognition mistakes BEFORE any AI call runs
    phase = "transcriptEdit";
  }

  /** User confirmed the (possibly edited) transcript → explicit AI step 1. */
  async function startDetect() {
    errorMessage = "";
    const myGen = gen;
    try {
      phase = "detecting";
      const det = await api.post<{
        type: NoteType;
        reason: string;
        types: NoteTypeInfo[];
      }>("/api/notes/detect-type", { transcript });
      if (myGen !== gen) return; // user cancelled while the AI was thinking
      aiType = det.type;
      aiReason = det.reason;
      typeInfos = det.types;
      selectedType = det.type;
      phase = "typeSelect";
    } catch (e) {
      phase = "transcriptEdit";
      errorMessage = e instanceof Error ? e.message : "Processing failed";
    }
  }

  /** Explicit AI step 2: type-specific formatting for the user-selected type. */
  async function runFormat() {
    errorMessage = "";
    const myGen = gen;
    try {
      phase = "formatting";
      const fmt = await api.post<{
        type: NoteType;
        language: "en" | "uk";
        text: string;
        categories: ProposedCategory[];
        todos: ProposedTodo[];
      }>("/api/notes/format", { transcript, type: selectedType });

      if (myGen !== gen) return; // user cancelled while the AI was formatting
      fmtText = fmt.text || transcript;
      fmtLanguage = fmt.language;
      proposed = fmt.categories;
      proposedTodos = fmt.todos;
      categories = await refreshCategories();
      draftTodos = fmt.todos.map((t) => ({
        text: t.text,
        done: t.done,
        tags: [...t.tags],
      }));
      // preselect everything the AI proposed (new labels included — they are
      // created on save); the user can tap any chip off/on before saving
      selectedNames = fmt.categories.map((p) => p.name);
      newCatName = "";
      phase = "review";
    } catch (e) {
      phase = "typeSelect";
      errorMessage = e instanceof Error ? e.message : "Processing failed";
    }
  }

  /** Allows re-picking a type from the review screen (re-runs step 2). */
  async function changeType(t: NoteType) {
    if (t === selectedType || phase !== "review") return;
    selectedType = t;
    await runFormat();
  }

  const eqName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const isNameSelected = (name: string) =>
    selectedNames.some((n) => eqName(n, name));

  function toggleName(name: string) {
    selectedNames = isNameSelected(name)
      ? selectedNames.filter((n) => !eqName(n, name))
      : [...selectedNames, name];
  }

  function toggleProposal(p: ProposedCategory) {
    toggleName(p.name);
  }

  const isProposalSelected = (p: ProposedCategory) => isNameSelected(p.name);

  /** Names typed into the input after pressing Enter become selectable chips. */
  function commitNewCat(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const parts = newCatName
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts)
      if (!isNameSelected(p)) selectedNames = [...selectedNames, p];
    newCatName = "";
  }

  /** Manually added names that are neither proposals nor existing categories. */
  const extraNames = $derived(
    selectedNames.filter(
      (n) =>
        !proposed.some((p) => eqName(p.name, n)) &&
        !categories.some((c) => eqName(c.name, n)),
    ),
  );

  // --- per-task tag editing (todo review) ---

  /** Every tag name known right now: existing categories + tags used in the draft. */
  const knownTagNames = $derived.by(() => {
    const set = new Map<string, string>(); // lowercase → display
    for (const c of categories) set.set(c.name.toLowerCase(), c.name);
    for (const p of proposed) set.set(p.name.toLowerCase(), p.name);
    for (const t of draftTodos)
      for (const tg of t.tags) set.set(tg.toLowerCase(), tg);
    return [...set.values()];
  });

  function toggleTaskTag(taskIdx: number, tag: string) {
    const t = draftTodos[taskIdx];
    const lower = tag.toLowerCase();
    t.tags = t.tags.some((x) => x.toLowerCase() === lower)
      ? t.tags.filter((x) => x.toLowerCase() !== lower)
      : [...t.tags, tag];
  }

  function commitTaskTag(taskIdx: number, e: Event) {
    e.preventDefault();
    const input = e.currentTarget as HTMLInputElement;
    for (const part of input.value.split(",")) {
      const tag = part.trim();
      if (
        tag &&
        !draftTodos[taskIdx].tags.some(
          (x) => x.toLowerCase() === tag.toLowerCase(),
        )
      ) {
        draftTodos[taskIdx] = {
          ...draftTodos[taskIdx],
          tags: [...draftTodos[taskIdx].tags, tag],
        };
      }
    }
    input.value = "";
  }

  function addTask() {
    draftTodos = [...draftTodos, { text: "", done: false, tags: [] }];
  }

  function removeTask(idx: number) {
    draftTodos = draftTodos.filter((_, i) => i !== idx);
  }

  // --- save / discard ---

  async function saveNote() {
    if (saving) return;
    saving = true;
    errorMessage = "";
    try {
      // existing selected + any non-empty "new category" text (could be comma-separated)
      // typed-but-not-committed input is picked up at save as well
      const pendingNames = newCatName
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // case-insensitive dedupe
      const names: string[] = [];
      for (const n of [...selectedNames, ...pendingNames]) {
        if (n && !names.some((x) => eqName(x, n))) names.push(n);
      }
      const todos =
        selectedType === "todo"
          ? draftTodos
              .filter((t) => t.text.trim())
              .map((t) => ({ text: t.text.trim(), done: t.done, tags: t.tags }))
          : undefined;
      const text = (
        selectedType === "todo" ? fmtText || "Todo list" : fmtText || transcript
      ).trim();
      await api.post("/api/notes", {
        text,
        transcript,
        status: "final",
        type: selectedType,
        categories: names,
        todos,
      });
      resetCapture();
      adjustInstruction = "";
      tab = "notes";
      await loadNotes();
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Could not save the note";
    } finally {
      saving = false;
    }
  }

  function discard() {
    resetCapture();
  }

  /** Closes the whole capture flow from any step (✕ / Cancel buttons). */
  function closeCapture() {
    resetCapture();
  }

  function resetCapture() {
    gen++; // invalidate in-flight AI calls of this flow
    if (soniox.active) soniox.cancel();
    sonioxState = "idle";
    phase = "idle";
    transcript = "";
    aiType = "text";
    aiReason = "";
    typeInfos = [];
    selectedType = "text";
    fmtText = "";
    proposed = [];
    proposedTodos = [];
    draftTodos = [];
    selectedNames = [];
    newCatName = "";
    level = 0;
    elapsed = 0;
    errorMessage = "";
    liveText = "";
  }

  // --- AI text adjustment (voice-helper alternative to manual editing) ---
  let adjustInstruction = $state("");
  let adjusting = $state(false);

  async function adjustWithAi() {
    if (adjusting || !fmtText.trim()) return;
    adjusting = true;
    errorMessage = "";
    try {
      const res = await api.post<{ text: string }>("/api/notes/adjust", {
        text: fmtText,
        instruction: adjustInstruction || undefined,
      });
      fmtText = res.text;
      adjustInstruction = "";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "AI adjustment failed";
    } finally {
      adjusting = false;
    }
  }

  /** Applies an updated note from the NoteCard editor to the local list. */
  function onNoteUpdated(updated: NoteWithCategories) {
    notes = notes.map((n) => (n.id === updated.id ? updated : n));
  }

  async function refreshCategories(): Promise<Category[]> {
    const { categories: cats } = await api.get<{ categories: Category[] }>(
      "/api/categories",
    );
    return cats;
  }

  async function loadNotes() {
    notesLoading = true;
    try {
      const res = await api.get<{ notes: NoteWithCategories[] }>("/api/notes");
      notes = res.notes;
    } finally {
      notesLoading = false;
    }
  }

  async function toggleTodoItem(noteId: number, itemId: number, done: boolean) {
    try {
      await api.patch(`/api/notes/${noteId}/todos/${itemId}`, { done });
    } finally {
      // refetch only that note's fresh state to stay in sync
      const { note } = await api.get<{ note: NoteWithCategories }>(
        `/api/notes/${noteId}`,
      );
      notes = notes.map((n) => (n.id === noteId ? note : n));
    }
  }

  async function deleteNote(id: number) {
    await api.del(`/api/notes/${id}`);
    notes = notes.filter((n) => n.id !== id);
  }

  async function switchTab(t: Tab) {
    tab = t;
    if (t === "notes") {
      categories = await refreshCategories().catch(() => categories);
      await loadNotes();
    }
  }

  async function deleteCategory(id: number) {
    await api.del(`/api/categories/${id}`);
    categories = categories.filter((c) => c.id !== id);
    if (activeFilter === id) activeFilter = "all";
    await loadNotes();
  }
</script>

<svelte:head>
  <title>{tab === "capture" ? "Capture" : "Notes"} · VoiceNotes</title>
</svelte:head>

{#if tab === "capture"}
  <section class="capture">
    <!-- language selector -->
    <div class="seg" role="tablist" aria-label="Language">
      {#each ["en", "uk"] as l (l)}
        <button
          class="seg-item"
          class:active={lang === l}
          class:dimmed={!langSupported}
          title={!langSupported
            ? "Applies to Whisper — Parakeet auto-detects the language"
            : ""}
          onclick={() => (lang = l as SttLang)}
        >
          {l === "auto" ? "🌐 Auto" : l === "en" ? "EN" : "UA"}
        </button>
      {/each}
    </div>

    <!-- speech engine + model + mic -->
    <div class="stt-config">
      <select
        aria-label="Microphone mode"
        onchange={onMicModeChange}
        disabled={phase !== "idle"}
        title="Raw is usually better for recognition; enable Enhanced if the mic is noisy"
      >
        <option value="raw" selected={micMode === "raw"}>Mic: raw</option>
        <option value="enhanced" selected={micMode === "enhanced"}
          >Mic: enhanced</option
        >
      </select>
      <select
        aria-label="Speech engine"
        onchange={onEngineChange}
        disabled={phase !== "idle"}
      >
        <option value="whisper" selected={engineId === "whisper"}
          >Whisper</option
        >
        <option value="parakeet" selected={engineId === "parakeet"}
          >Parakeet v3 · auto</option
        >
        <option value="soniox" selected={engineId === "soniox"}
          >Soniox · cloud · live</option
        >
      </select>
      {#if !usingSoniox}
        <select
          aria-label="Speech model"
          onchange={onModelChange}
          disabled={phase !== "idle"}
        >
          {#each modelOptions as m (m.value)}
            <option value={m.value} selected={modelId === m.value}
              >{m.label}</option
            >
          {/each}
        </select>
      {/if}
    </div>

    <!-- orb + timer -->
    <div class="stage">
      <RecordOrb
        recording={phase === "recording"}
        processing={phase === "loading" ||
          phase === "transcribing" ||
          phase === "detecting" ||
          phase === "formatting"}
        level={phase === "recording" ? level : 0}
        onclick={toggleRecording}
      />
      <p class="hint" class:rec={phase === "recording"}>
        {#if phase === "recording"}
          <span class="timer">{formatDuration(elapsed)}</span> — tap to stop
        {:else if phase === "loading"}
          {sttProgress?.text ?? "Loading speech model…"}
        {:else if phase === "transcribing"}
          Transcribing…
        {:else if phase === "transcriptEdit"}
          Check the text below ↓
        {:else if phase === "detecting"}
          Choosing the note type…
        {:else if phase === "formatting"}
          Formatting as {selectedType}…
        {:else}
          Tap to record a note
        {/if}
      </p>
      {#if phase === "detecting" || phase === "formatting"}
        <button class="cancel-link faint" onclick={closeCapture}>Cancel</button>
      {/if}
      {#if sttProgress && (phase === "recording" || phase === "loading")}
        <div class="dl-bar">
          <div class="dl-fill" style:width={`${sttProgress.pct}%`}></div>
        </div>
      {/if}

      <!-- live transcript while recording / finishing -->
      {#if liveText && (phase === "recording" || phase === "transcribing")}
        <div class="live-box">
          <p class="live-label faint">
            {#if usingSoniox && phase === "recording" && (sonioxState === "starting" || sonioxState === "connecting")}
              connecting…
            {:else if segBusy > 0}
              transcribing…
            {:else}
              live
            {/if}
          </p>
          <p class="live-text">{liveText}</p>
        </div>
      {/if}
      {#if errorMessage && phase === "idle"}<p class="error-text">
          {errorMessage}
        </p>{/if}
    </div>

    <!-- step 0: fix the transcript right after recording, before any AI call -->
    {#if phase === "transcriptEdit"}
      <div class="review card">
        <button class="close-btn" title="Close" onclick={closeCapture}>✕</button>
        <p class="label">Check the transcript</p>
        <p class="ai-reason faint">
          Recognition isn't perfect — fix any mistakes before the AI runs.
        </p>
        <textarea
          rows="6"
          bind:value={transcript}
          aria-label="Transcript to fix"
        ></textarea>
        {#if errorMessage}<p class="error-text">{errorMessage}</p>{/if}
        <div class="row">
          <button
            class="btn btn-primary grow"
            onclick={startDetect}
            disabled={!transcript.trim()}
          >
            Continue
          </button>
          <button class="btn btn-ghost" onclick={closeCapture}>Discard</button>
        </div>
      </div>
    {/if}

    <!-- step 1 result: type selection (AI proposal highlighted) -->
    {#if phase === "typeSelect"}
      <div class="review card">
        <button class="close-btn" title="Close" onclick={closeCapture}>✕</button>
        <p class="label">What kind of note is this?</p>
        <p class="ai-reason faint">
          🤖 AI suggests <strong>{aiType}</strong>{#if aiReason}
            — {aiReason}{/if}
        </p>
        <div class="type-grid">
          {#each NOTE_TYPES as t (t)}
            {@const info = typeInfos.find((i) => i.type === t)}
            <button
              class="type-card"
              class:aiPick={t === aiType}
              class:picked={t === selectedType && t !== aiType}
              onclick={() => {
                selectedType = t;
                runFormat();
              }}
            >
              <span class="type-label">
                {#if t === aiType}<span class="ai-badge">AI pick</span>{/if}
                {info?.label ?? t}
              </span>
              <span class="type-desc faint">{info?.description ?? ""}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- step 2 result: type-specific review -->
    {#if phase === "review"}
      <div class="review card">
        <button class="close-btn" title="Close" onclick={closeCapture}>✕</button>
        <p class="label">
          {selectedType === "todo"
            ? "Todolist"
            : selectedType === "prompt"
              ? "Refined prompt"
              : selectedType === "summary"
                ? "Summary"
                : "Note text"}
          <button class="link-btn faint" onclick={() => (phase = "typeSelect")}
            >change type</button
          >
        </p>

        <!-- text / prompt / summary share the same editor -->
        {#if selectedType !== "todo"}
          <textarea
            id="note-text"
            rows={selectedType === "text" ? 5 : 8}
            bind:value={fmtText}
          ></textarea>
        {:else}
          <label class="label sub" for="todo-title">List title</label>
          <input
            id="todo-title"
            bind:value={fmtText}
            placeholder="List title"
          />
        {/if}

        <!-- transcript stays editable; the AI can re-run on the edited text -->
        <details class="raw">
          <summary class="faint">Raw transcript (editable)</summary>
          <textarea
            class="transcript-edit"
            rows="4"
            bind:value={transcript}
            aria-label="Raw transcript"
          ></textarea>
          <button
            class="btn btn-ghost rerun"
            disabled={phase !== "review" || !transcript.trim()}
            onclick={runFormat}
          >
            ↻ Re-run AI on edited transcript
          </button>
        </details>

        {#if selectedType === "todo"}
          <p class="label sect">Tasks</p>
          <ul class="draft-todos">
            {#each draftTodos as t, i (i)}
              <li class="draft-task">
                <label class="check">
                  <input type="checkbox" bind:checked={t.done} />
                </label>
                <input
                  class="task-input"
                  placeholder="Task"
                  bind:value={t.text}
                />
                <button
                  class="rm-task faint"
                  title="Remove task"
                  onclick={() => removeTask(i)}>✕</button
                >
                <div class="task-tags">
                  {#each t.tags as tg (tg)}
                    <CategoryChip
                      name={tg}
                      small
                      selected
                      onclick={() => toggleTaskTag(i, tg)}
                    />
                  {/each}
                  {#each knownTagNames as k (k)}
                    {#if !t.tags.some((x) => x.toLowerCase() === k.toLowerCase())}
                      <CategoryChip
                        name={k}
                        small
                        dimmed
                        onclick={() => toggleTaskTag(i, k)}
                      />
                    {/if}
                  {/each}
                  <input
                    class="tag-input"
                    placeholder="+ tag"
                    onkeydown={(e) => e.key === "Enter" && commitTaskTag(i, e)}
                  />
                </div>
              </li>
            {/each}
          </ul>
          <button class="btn btn-ghost add-task" onclick={addTask}
            >+ Add task</button
          >
        {:else}
          <!-- AI adjust toolbar for text / prompt / summary drafts -->
          <div class="ai-adjust">
            <input
              placeholder="Optional: tell the AI how to adjust (e.g. “make it shorter”, “fix grammar”)…"
              bind:value={adjustInstruction}
            />
            <button class="btn btn-ghost" onclick={adjustWithAi} disabled={adjusting}>
              {#if adjusting}<span class="spinner"></span>{/if}
              ✨ Adjust with AI
            </button>
          </div>
        {/if}

        <p class="label sect">Categories</p>
        <div class="chips">
          {#each proposed as p (p.name)}
            <CategoryChip
              name={p.name}
              selected={isProposalSelected(p)}
              dimmed={!isNameSelected(p.name)}
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
                selected={isNameSelected(c.name)}
                onclick={() => toggleName(c.name)}
              />
            {/each}
          </div>
        {/if}

        {#if extraNames.length > 0}
          <div class="chips">
            {#each extraNames as n (n)}
              <button class="chip extra-chip" onclick={() => toggleName(n)}
                >{n} ✕</button
              >
            {/each}
          </div>
        {/if}

        <div class="field newcat">
          <label class="label" for="new-cat"
            >New category (comma-separated, Enter to add)</label
          >
          <input
            id="new-cat"
            placeholder="e.g. Grocery list"
            bind:value={newCatName}
            onkeydown={commitNewCat}
          />
        </div>

        {#if errorMessage}<p class="error-text">{errorMessage}</p>{/if}

        <div class="row">
          <button
            class="btn btn-primary grow"
            onclick={saveNote}
            disabled={saving}
          >
            {#if saving}<span class="spinner"></span>{/if}
            Save note
          </button>
          <button class="btn btn-ghost" onclick={discard} disabled={saving}
            >Discard</button
          >
        </div>
      </div>
    {/if}
  </section>
{:else}
  <section class="notes">
    <div class="field">
      <input
        type="search"
        placeholder="Search notes, tasks and tags…"
        bind:value={search}
        aria-label="Search notes, tasks and tags"
      />
    </div>

    <div class="chips filter-chips">
      <button
        class="chip all-chip"
        class:active={activeFilter === "all"}
        onclick={() => (activeFilter = "all")}
      >
        All
      </button>
      {#each categories as c (c.id)}
        <CategoryChip
          name={c.name + (c.taskCount > 0 ? ` · ${c.taskCount}⚑` : "")}
          selected={activeFilter === c.id}
          onclick={() => (activeFilter = activeFilter === c.id ? "all" : c.id)}
        />
      {/each}
      <span class="manage-hint faint">long-press to manage</span>
    </div>

    <!-- aggregated tasks across all todolists for the selected tag -->
    {#if activeTag && aggregatedTasks.length > 0}
      <div class="card tag-aggregation">
        <p class="label">
          ⚑ “{activeTag.name}” tasks — all lists ({aggregatedTasks.length})
        </p>
        <ul class="agg-list">
          {#each aggregatedTasks as at (`${at.note.id}:${at.itemId}`)}
            <li class:done={at.done}>
              <input
                type="checkbox"
                checked={at.done}
                onchange={(e) =>
                  toggleTodoItem(
                    at.note.id,
                    at.itemId,
                    (e.currentTarget as HTMLInputElement).checked,
                  )}
              />
              <span class="agg-task">{at.text}</span>
              <span class="agg-src faint"
                >from “{at.note.text.slice(0, 40) || "todolist"}”</span
              >
              {#each at.tags.filter((t) => t.id !== activeTag?.id) as t (t.id)}
                <CategoryChip name={t.name} small />
              {/each}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="note-list">
      {#if notesLoading}
        <p class="muted">Loading…</p>
      {:else if filteredNotes.length === 0}
        <div class="empty card">
          <p>
            {search || activeFilter !== "all"
              ? "Nothing matches the filter."
              : "No notes yet."}
          </p>
          {#if !search && activeFilter === "all"}
            <button class="btn btn-primary" onclick={() => switchTab("capture")}
              >Record your first note</button
            >
          {/if}
        </div>
      {:else}
        {#each filteredNotes as note (note.id)}
          <NoteCard
            {note}
            ondelete={deleteNote}
            onupdated={onNoteUpdated}
            ontoggletodo={toggleTodoItem}
          />
        {/each}
      {/if}
    </div>
  </section>
{/if}

<nav class="tabbar" aria-label="Main">
  <button
    class="tab"
    class:active={tab === "capture"}
    onclick={() => switchTab("capture")}
  >
    <span class="tab-ico">⏺</span> Capture
  </button>
  <button
    class="tab"
    class:active={tab === "notes"}
    onclick={() => switchTab("notes")}
  >
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
    transition:
      background 0.15s,
      color 0.15s;
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

  .cancel-link {
    font-size: 13px;
    text-decoration: underline;
    padding: 4px 10px;
  }

  .close-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 14px;
    color: var(--text-muted);
    background: var(--bg);
    border: 1px solid var(--line);
    transition: background 0.15s, color 0.15s;
  }

  .close-btn:hover {
    background: var(--bg-card-hover);
    color: var(--text);
  }

  .review {
    position: relative; /* anchors the close button */
    width: 100%;
    animation: rise 0.35s ease both;
  }

  .review textarea {
    resize: vertical;
    min-height: 110px;
  }

  .ai-reason {
    font-size: 13px;
    margin: 6px 0 12px;
  }

  .type-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .type-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
    transition:
      border-color 0.15s,
      background 0.15s;
  }

  .type-card.aiPick {
    border-color: rgba(139, 92, 246, 0.65);
    background: var(--accent-dim);
    box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.35);
  }

  .type-card.picked {
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  .type-label {
    font-weight: 700;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-badge {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #fff;
    background: var(--accent);
    border-radius: var(--radius-pill);
    padding: 2px 7px;
  }

  .type-desc {
    font-size: 12px;
  }

  .link-btn {
    font-size: 12px;
    text-decoration: underline;
    margin-left: auto;
  }

  .label.sub {
    font-size: 12px;
    margin-top: 10px;
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

  /* editable transcript inside the raw details */
  .transcript-edit {
    margin-top: 8px;
    font-size: 13px;
    padding: 9px 12px;
    min-height: 0;
    resize: vertical;
  }

  .rerun {
    margin-top: 8px;
    font-size: 13px;
    padding: 8px 12px;
  }

  /* AI adjust toolbar (text / prompt / summary drafts) */
  .ai-adjust {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .ai-adjust input {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    padding: 9px 12px;
  }

  .ai-adjust .btn {
    font-size: 13px;
    padding: 9px 12px;
    flex-shrink: 0;
  }

  /* todo draft editor */
  .draft-todos {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .draft-task {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    background: var(--bg);
  }

  .draft-task .check input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .task-input {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 14px;
    width: 100%;
  }

  .rm-task {
    font-size: 13px;
    padding: 2px 6px;
  }

  .task-tags {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .tag-input {
    background: transparent;
    border: 1px dashed var(--line);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: 11px;
    padding: 2px 8px;
    width: 70px;
  }

  .add-task {
    margin-top: 8px;
    font-size: 13px;
  }

  .newcat {
    margin-top: 16px;
  }

  .extra-chip {
    border-style: dashed;
  }

  .extra-chip::before {
    content: "+ ";
    font-weight: 700;
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

  .tag-aggregation {
    padding: 12px 14px;
    border-color: rgba(139, 92, 246, 0.35);
  }

  .agg-list {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .agg-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    flex-wrap: wrap;
  }

  .agg-list li input {
    width: 17px;
    height: 17px;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  .agg-list li.done .agg-task {
    text-decoration: line-through;
    color: var(--text-faint);
  }

  .agg-task {
    overflow-wrap: anywhere;
  }

  .agg-src {
    font-size: 11px;
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
    z-index: 30; /* always above the scrolling content container */
    height: 54px; /* matches the content container's margin-bottom */
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
    transition:
      background 0.15s,
      color 0.15s;
  }

  .tab.active {
    background: linear-gradient(135deg, var(--accent), #6d28d9);
    color: #fff;
    box-shadow: 0 4px 14px var(--accent-glow);
  }

  .tab-ico {
    font-size: 13px;
  }

  @media (min-width: 700px) {
    .manage-hint {
      display: inline;
    }
  }
</style>
