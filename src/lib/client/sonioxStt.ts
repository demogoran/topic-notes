/**
 * Soniox real-time cloud STT — streams mic audio to Soniox over a WebSocket
 * and renders tokens live (final + partial). Much better accuracy on mobile
 * browsers than the in-browser models, since nothing runs locally.
 *
 * Audio capture still goes through our own Recorder (16 kHz mono PCM, user's
 * raw/enhanced preference, level meter, timer) via a small AudioSource adapter,
 * so the UI stays identical to the local engines.
 */
import type {
	AudioSource,
	AudioSourceHandlers,
	Recording,
	RecordingState,
	SonioxClient as ISonioxClient
} from '@soniox/client';
import { Recorder } from '#lib/client/recorder';
import { api } from '#lib/client/api';

/** Soniox real-time STT model. */
export const SONIOX_MODEL = 'stt-rt-v5';

type SttLang = 'auto' | 'en' | 'uk';

export interface SonioxStartOptions {
	lang: SttLang;
	/** Browser mic DSP (echoCancellation/noiseSuppression/AGC) — usually off for ASR. */
	enhanced: boolean;
	onLevel?: (level: number) => void;
	onTick?: (elapsedSec: number) => void;
	/** Fired whenever tokens arrive; `tail` is the non-final (partial) text. */
	onText?: (finalText: string, tail: string) => void;
	onError?: (err: Error) => void;
	onState?: (state: RecordingState) => void;
}

/** Float32 [-1…1] → little-endian s16 PCM bytes. */
function float32ToInt16Le(pcm: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(pcm.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < pcm.length; i++) {
		const s = Math.max(-1, Math.min(1, pcm[i]));
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buffer;
}

/**
 * AudioSource adapter over our Recorder: delivers 16 kHz mono s16le chunks to
 * the Soniox Recording while keeping the level meter / tick callbacks working.
 */
class RecorderSource implements AudioSource {
	constructor(
		private readonly recorder: Recorder,
		private readonly enhanced: boolean
	) {}

	async start(handlers: AudioSourceHandlers): Promise<void> {
		this.recorder.onFrame = (pcm) => handlers.onData(float32ToInt16Le(pcm));
		try {
			await this.recorder.start({ enhanced: this.enhanced });
		} catch (e) {
			this.recorder.onFrame = null;
			throw e; // Recording maps this into its own error flow
		}
	}

	stop(): void {
		this.recorder.onFrame = null;
		this.recorder.cancel();
	}
}

export class SonioxStt {
	#recorder: Recorder | null = null;
	#recording: Recording | null = null;
	#client: ISonioxClient | null = null;
	#finalText = '';
	#tail = '';

	get active(): boolean {
		return this.#recording !== null;
	}

	/** Current transcript (final + partial) — also readable outside onText. */
	get text(): string {
		return `${this.#finalText}${this.#tail}`;
	}

	/**
	 * Starts mic capture + a Soniox WebSocket session. Returns once the
	 * mic is live; the WebSocket connects in the background and tokens
	 * arrive via onText.
	 */
	async start(opts: SonioxStartOptions): Promise<void> {
		this.#teardown(); // ensure no stale session

		const recorder = new Recorder();
		recorder.onLevel = (v) => opts.onLevel?.(v);
		recorder.onTick = (s) => opts.onTick?.(s);
		this.#recorder = recorder;
		this.#finalText = '';
		this.#tail = '';

		// Lazy-load the (large) SDK chunk only when the engine is actually used
		const { SonioxClient } = await import('@soniox/client');
		const client = new SonioxClient({
			config: async () => {
				const { api_key } = await api.post<{ api_key: string; expires_at: string | null }>(
					'/api/soniox-temp-key',
					{}
				);
				return { api_key };
			}
		});
		this.#client = client;

		// Language hints: bias recognition; mixed UK/EN allowed for Ukrainian users.
		const hints = opts.lang === 'en' ? ['en'] : ['uk', 'en'];

		const recording = client.realtime.record({
			model: SONIOX_MODEL,
			audio_format: 'pcm_s16le',
			sample_rate: 16000,
			num_channels: 1,
			language_hints: hints,
			auto_reconnect: true,
			max_reconnect_attempts: 3,
			source: new RecorderSource(recorder, opts.enhanced)
		});
		this.#recording = recording;

		recording.on('result', (result) => {
			// Finalized tokens are delivered exactly once; partials are rebuilt from
			// the current non-final tokens each event (official SDK pattern).
			let tail = '';
			for (const token of result.tokens) {
				if (token.is_final) this.#finalText += token.text;
				else tail += token.text;
			}
			this.#tail = tail;
			opts.onText?.(this.#finalText, this.#tail);
		});

		recording.on('state_change', ({ new_state }) => {
			opts.onState?.(new_state);
			// Rare server-side failure before/instead of 'error'
			if (new_state === 'error') this.#fail(opts, new Error('The speech service connection failed.'));
		});

		recording.on('error', (err: Error) => {
			this.#fail(opts, err instanceof Error ? err : new Error(String(err)));
		});
	}

	/**
	 * Stops the session gracefully (waits for the server to finalize all
	 * remaining audio) and resolves with the full transcript.
	 */
	async stop(): Promise<string> {
		const recording = this.#recording;
		if (recording) {
			this.#recording = null;
			try {
				await recording.stop();
			} finally {
				this.#teardown();
			}
		}
		const text = this.text.trim();
		this.#finalText = '';
		this.#tail = '';
		return text;
	}

	/** Cancels immediately without waiting for final results. */
	cancel(): void {
		this.#teardown();
	}

	#fail(opts: SonioxStartOptions, err: Error): void {
		this.#teardown();
		opts.onError?.(err);
	}

	#teardown(): void {
		if (
			this.#recording &&
			['recording', 'connecting', 'starting', 'reconnecting', 'paused'].includes(
				this.#recording.state
			)
		) {
			this.#recording.cancel();
		}
		this.#recording = null;
		this.#client = null;
		if (this.#recorder) {
			this.#recorder.onFrame = null;
			this.#recorder.cancel();
			this.#recorder = null;
		}
	}
}
