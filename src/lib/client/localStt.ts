/**
 * In-browser speech recognition — replaces the external transcription service.
 *
 * Engines:
 *  - "whisper":  Transformers.js (bundled via npm). WebGPU if available, WASM
 *               otherwise. Supports forcing the language (en/uk).
 *  - "parakeet": nvidia parakeet-tdt-0.6b-v3 via onnxruntime-web, running in
 *               static/parakeet-worker.js. 21 European languages incl.
 *               Ukrainian, auto-detected, with punctuation. Much faster than
 *               Whisper. No language forcing (auto only).
 */

export type SttEngine = 'whisper' | 'parakeet';
export type SttLang = 'auto' | 'en' | 'uk';

export interface SttModelOption {
	/** whisper: repo id · parakeet: "repo|encoder-file" */
	value: string;
	label: string;
}

export interface SttEngineInfo {
	label: string;
	supportsLang: boolean;
	models: SttModelOption[];
}

export const STT_ENGINES: Record<SttEngine, SttEngineInfo> = {
	whisper: {
		label: 'Whisper',
		supportsLang: true,
		models: [
			{ value: 'onnx-community/whisper-tiny', label: 'tiny · 43 MB' },
			{ value: 'onnx-community/whisper-base', label: 'base · 78 MB' },
			{ value: 'onnx-community/whisper-small', label: 'small · 250 MB' }
		]
	},
	parakeet: {
		label: 'Parakeet v3',
		supportsLang: false,
		models: [
			{ value: 'mrfakename/parakeet-ultra-ONNX|encoder-model.q4.onnx', label: 'q4 · ~470 MB · ★ UA' },
			{ value: 'mrfakename/parakeet-ultra-ONNX|encoder-model.q8.onnx', label: 'q8 · ~740 MB' }
		]
	}
};

export interface SttProgress {
	pct: number;
	text: string;
}

/** Structural type matching transformers.js ASR pipelines. */
interface WhisperAsrPipeline {
	(audio: Float32Array, options?: Record<string, unknown>): Promise<{ text?: string }>;
}

interface WhisperProgressCallbackData {
	status?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

type ParakeetWorkerMsg =
	| { type: 'progress'; loaded: number; total: number }
	| { type: 'status'; text: string }
	| { type: 'loaded'; device: string }
	| { type: 'result'; id: number; text: string }
	| { type: 'error'; id?: number; message: string };

const SR = 16000;

export class LocalStt {
	#engine: SttEngine | null = null;
	#model = '';
	#whisper: WhisperAsrPipeline | null = null;
	#worker: Worker | null = null;
	#pending: Promise<void> | null = null;
	#jobs = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
	#jobId = 0;

	get device(): string {
		return this.#engine === 'parakeet' ? 'webgpu/wasm (parakeet)' : 'transformers.js';
	}

	isReady(engine: SttEngine, model: string): boolean {
		return (
			this.#engine === engine &&
			this.#model === model &&
			(engine === 'whisper' ? this.#whisper !== null : this.#worker !== null)
		);
	}

	/**
	 * Loads the selected engine + model. Concurrent calls with the same target
	 * share one in-flight promise; a different target tears the old one down.
	 */
	load(engine: SttEngine, model: string, onProgress?: (p: SttProgress) => void): Promise<void> {
		if (this.isReady(engine, model)) return Promise.resolve();
		if (this.#pending && this.#engine === engine && this.#model === model) return this.#pending;

		this.#reset();
		this.#engine = engine;
		this.#model = model;

		this.#pending = (
			engine === 'whisper'
				? this.#loadWhisper(model, onProgress)
				: this.#loadParakeet(model, onProgress)
		).finally(() => {
			this.#pending = null;
		});
		return this.#pending;
	}

	/** Transcribes 16 kHz mono PCM. */
	async transcribe(pcm: Float32Array, lang: SttLang = 'auto'): Promise<string> {
		if (this.#engine === 'whisper' && this.#whisper) {
			const options: Record<string, unknown> = { task: 'transcribe' };
			if (lang !== 'auto') options.language = lang;
			if (pcm.length > 25 * SR) options.chunk_length_s = 30;
			const out = await this.#whisper(pcm, options);
			return (out.text ?? '').trim();
		}
		if (this.#engine === 'parakeet' && this.#worker) {
			return new Promise<string>((resolve, reject) => {
				const id = ++this.#jobId;
				this.#jobs.set(id, { resolve, reject });
				this.#worker!.postMessage({ type: 'transcribe', id, pcm }, [pcm.buffer]);
			});
		}
		throw new Error('Speech model is not loaded yet');
	}

	// ---------------------------------------------------------------- whisper
	async #loadWhisper(model: string, onProgress?: (p: SttProgress) => void): Promise<void> {
		const { pipeline } = await import('@huggingface/transformers');

		const progress_callback = (p: WhisperProgressCallbackData) => {
			if (p?.status === 'progress' && p.total) {
				onProgress?.({
					pct: Math.round(((p.loaded ?? 0) / p.total) * 100),
					text: `Downloading ${p.file ?? 'model'}… ${Math.round(p.progress ?? 0)}%`
				});
			}
		};

		let pipe: WhisperAsrPipeline | null = null;
		if ('gpu' in navigator) {
			try {
				pipe = (await pipeline('automatic-speech-recognition', model, {
					device: 'webgpu',
					dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
					progress_callback
				})) as unknown as WhisperAsrPipeline;
			} catch (e) {
				console.warn('Whisper WebGPU failed, falling back to WASM', e);
			}
		}
		if (!pipe) {
			pipe = (await pipeline('automatic-speech-recognition', model, {
				device: 'wasm',
				dtype: 'q8',
				progress_callback
			})) as unknown as WhisperAsrPipeline;
		}

		if (this.#engine !== 'whisper' || this.#model !== model) return; // stale load
		this.#whisper = pipe;
	}

	// ---------------------------------------------------------------- parakeet
	async #loadParakeet(model: string, onProgress?: (p: SttProgress) => void): Promise<void> {
		const [repo, encFile] = model.split('|');
		if (!repo || !encFile) throw new Error('Invalid parakeet model id');

		const worker = new Worker('/parakeet-worker.js', { type: 'module' });
		this.#worker = worker;

		await new Promise<void>((resolve, reject) => {
			worker.onmessage = (ev: MessageEvent<ParakeetWorkerMsg>) => {
				const m = ev.data;
				switch (m.type) {
					case 'progress':
						onProgress?.({
							pct: m.total ? Math.round((m.loaded / m.total) * 100) : 0,
							text: `Downloading model… ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB`
						});
						break;
					case 'status':
						onProgress?.({ pct: 0, text: m.text });
						break;
					case 'loaded':
						resolve();
						break;
					case 'result': {
						const job = this.#jobs.get(m.id);
						if (job) {
							this.#jobs.delete(m.id);
							job.resolve(m.text);
						}
						break;
					}
					case 'error': {
						const errId = m.id;
						const job = errId !== undefined ? this.#jobs.get(errId) : undefined;
						if (job && errId !== undefined) {
							this.#jobs.delete(errId);
							job.reject(new Error(m.message));
						} else {
							reject(new Error(m.message));
						}
						break;
					}
				}
			};
			worker.onerror = (e) => reject(new Error(e.message || 'Worker failed to load'));
			worker.postMessage({
				type: 'load',
				cfg: {
					repo,
					files: {
						pre: 'preprocessor.onnx',
						enc: encFile,
						dec: 'decoder_joint-model.int8.onnx',
						vocab: 'vocab.txt'
					}
				}
			});
		});

		if (this.#worker !== worker) {
			worker.terminate(); // a newer load superseded us
		}
	}

	// ---------------------------------------------------------------- cleanup
	#reset(): void {
		if (this.#worker) {
			this.#worker.terminate();
			this.#worker = null;
		}
		for (const job of this.#jobs.values()) {
			job.reject(new Error('STT engine was reloaded'));
		}
		this.#jobs.clear();
		this.#whisper = null;
	}
}
