/**
 * Reusable one-shot dictation for input fields (chat box, etc.).
 *
 * Unlike the capture tab flow, dictation NEVER auto-submits: stop() resolves
 * with the recognized text and the caller inserts it into an editable field.
 *
 * The engine follows the user's capture-tab preference (localStorage:
 * stt.engine.v2 / stt.model) — the cloud engine (Soniox) when selected,
 * otherwise the in-browser model with VAD segmentation.
 */
import { Recorder, normalizeForAsr, type RecordingResult } from './recorder';
import { LocalStt, type SttEngine, type SttLang } from './localStt';

export type DictationEngineId = SttEngine | 'soniox';

export interface DictationOptions {
	/** Live text updates: `final` grows as segments are recognized, `tail` is the partial. */
	onText?: (final: string, tail: string) => void;
	onLevel?: (level: number) => void;
	onError?: (err: Error) => void;
}

/** Reads the user's capture-tab STT preference (shared with +page.svelte keys). */
export function resolveDictationEngine(): { engine: DictationEngineId; model: string } {
	let engine: DictationEngineId = 'soniox';
	let model = '';
	try {
		const stored = localStorage.getItem('stt.engine.v2') as DictationEngineId | null;
		if (stored === 'soniox' || stored === 'whisper' || stored === 'parakeet') engine = stored;
		if (engine !== 'soniox') {
			model = localStorage.getItem('stt.model') ?? '';
		}
	} catch {
		/* private mode — fall back to the cloud engine */
	}
	return { engine, model };
}

export class Dictation {
	#engine: DictationEngineId = 'soniox';
	#model = '';
	#lang: SttLang = 'auto';

	#stt: LocalStt | null = null;
	#recorder: Recorder | null = null;

	#final = '';
	#tail = '';
	#segChain: Promise<void> = Promise.resolve();

	get active(): boolean {
		if (this.#recorder) return true;
		return this.#engine === 'soniox' && this.#sonioxActive;
	}

	get text(): string {
		return `${this.#final}${this.#tail}`;
	}

	#sonioxActive = false;
	#sonioxStop: (() => Promise<string>) | null = null;
	#sonioxCancel: (() => void) | null = null;
	#opts: DictationOptions | null = null;

	async start(opts: DictationOptions, lang: SttLang = 'auto'): Promise<void> {
		this.cancel(); // ensure no stale session
		this.#opts = opts;
		this.#lang = lang;
		this.#final = '';
		this.#tail = '';

		const { engine, model } = resolveDictationEngine();
		this.#engine = engine;
		this.#model = model;

		if (engine === 'soniox') {
			await this.#startSoniox(opts);
		} else {
			await this.#startLocal(opts, engine, model);
		}
	}

	/** Stops and resolves with the recognized text (never throws for empty text — returns ''). */
	async stop(): Promise<string> {
		let text = '';
		if (this.#sonioxActive && this.#sonioxStop) {
			try {
				text = await this.#sonioxStop();
			} catch (e) {
				this.#opts?.onError?.(e instanceof Error ? e : new Error(String(e)));
			}
		} else if (this.#recorder) {
			let rec: RecordingResult | null = null;
			try {
				rec = await this.#recorder.stop(); // emits the final segment first
			} catch {
				// too short — live text may still exist
			}
			try {
				await this.#segChain; // wait for in-flight segment transcriptions
				text = this.#final.trim();
				if (!text && rec) {
					// nothing recognized live — transcribe the whole clip
					const stt = this.#stt!;
					text = (await stt.transcribe(rec.pcm, this.#lang)).trim();
				}
			} catch (e) {
				this.#opts?.onError?.(e instanceof Error ? e : new Error(String(e)));
			}
		}
		this.#teardown();
		return text;
	}

	cancel(): void {
		if (this.#sonioxCancel) this.#sonioxCancel();
		this.#teardown();
	}

	// ------------------------------------------------------------------ soniox
	async #startSoniox(opts: DictationOptions): Promise<void> {
		const { SonioxStt } = await import('./sonioxStt');
		const soniox = new SonioxStt();
		this.#sonioxActive = true;
		this.#sonioxCancel = () => soniox.cancel();
		this.#sonioxStop = () => soniox.stop();
		try {
			await soniox.start({
				lang: this.#lang,
				enhanced: this.#micEnhanced(),
				onLevel: (v) => opts.onLevel?.(v),
				onText: (fin, tail) => {
					this.#final = fin;
					this.#tail = tail;
					opts.onText?.(fin, tail);
				},
				onState: (s) => {
					if (s === 'error') {
						opts.onError?.(new Error('The speech service connection failed.'));
						this.#teardown();
					}
				},
				onError: (err) => {
					opts.onError?.(err);
					this.#teardown();
				}
			});
		} catch (e) {
			this.#sonioxActive = false;
			this.#sonioxStop = null;
			this.#sonioxCancel = null;
			throw e;
		}
	}

	// ------------------------------------------------------------------ local
	async #startLocal(opts: DictationOptions, engine: SttEngine, model: string): Promise<void> {
		this.#stt = new LocalStt();
		const recorder = new Recorder();
		this.#recorder = recorder;
		recorder.onLevel = (v) => opts.onLevel?.(v);
		recorder.onSegment = (pcm) => {
			// segments run strictly in order; each adds to the final text
			this.#segChain = this.#segChain.then(async () => {
				try {
					await this.#stt!.load(engine, model);
					const text = (await this.#stt!.transcribe(pcm, this.#lang)).trim();
					if (text) {
						this.#final = this.#final ? `${this.#final} ${text}` : text;
						this.#tail = '';
						opts.onText?.(this.#final, '');
					}
				} catch (e) {
					console.warn('Dictation segment failed:', e);
				}
			});
		};
		try {
			await recorder.start({ enhanced: this.#micEnhanced() });
			// warm the model up in the background while the user speaks
			this.#stt.load(engine, model).catch(() => {});
		} catch (e) {
			this.#recorder = null;
			throw e instanceof Error ? e : new Error('Could not start dictation');
		}
	}

	/** Keeps dictation consistent with the capture tab's mic mode preference. */
	#micEnhanced(): boolean {
		try {
			return localStorage.getItem('mic.mode') === 'enhanced';
		} catch {
			return false;
		}
	}

	#teardown(): void {
		if (this.#recorder) {
			this.#recorder.onLevel = null;
			this.#recorder.onSegment = null;
			this.#recorder.cancel();
			this.#recorder = null;
		}
		this.#sonioxActive = false;
		this.#sonioxStop = null;
		this.#sonioxCancel = null;
		this.#stt = null;
		this.#final = '';
		this.#tail = '';
		this.#opts = null;
		this.#segChain = Promise.resolve();
	}
}

export { normalizeForAsr };
