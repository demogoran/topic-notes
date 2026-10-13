/** Wraps MediaRecorder + AnalyserNode behind a tiny class-based API. */

export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	durationSec: number;
}

export type RecorderState = 'idle' | 'recording' | 'processing';

export class Recorder {
	#recorder: MediaRecorder | null = null;
	#stream: MediaStream | null = null;
	#ctx: AudioContext | null = null;
	#analyser: AnalyserNode | null = null;
	#startedAt = 0;
	#timer: ReturnType<typeof setInterval> | null = null;

	onLevel: ((level: number) => void) | null = null;
	onTick: ((elapsedSec: number) => void) | null = null;

	get state(): RecorderState {
		return this.#recorder?.state === 'recording' ? 'recording' : 'idle';
	}

	/** Requests the mic and starts recording. Throws a friendly Error on failure. */
	async start(): Promise<void> {
		if (this.#recorder) return;
		try {
			this.#stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true }
			});
		} catch {
			throw new Error('Microphone access was denied. Enable it in your browser settings.');
		}

		this.#setupMeter();

		const mimeType = pickMimeType();
		this.#recorder = new MediaRecorder(this.#stream, mimeType ? { mimeType } : undefined);
		this.#recorder.start(250);
		this.#startedAt = Date.now();

		this.#timer = setInterval(() => this.onTick?.((Date.now() - this.#startedAt) / 1000), 200);
		this.#pumpLevel();
	}

	/** Stops recording and returns the captured blob. */
	stop(): Promise<RecordingResult> {
		return new Promise((resolve, reject) => {
			const rec = this.#recorder;
			if (!rec || rec.state === 'inactive') {
				reject(new Error('Not recording'));
				return;
			}
			const chunks: Blob[] = [];
			rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
			rec.onstop = () => {
				const durationSec = (Date.now() - this.#startedAt) / 1000;
				const mimeType = rec.mimeType || 'audio/webm';
				this.#teardown();
				resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationSec });
			};
			rec.onerror = () => {
				this.#teardown();
				reject(new Error('Recording failed'));
			};
			rec.stop();
		});
	}

	cancel(): void {
		if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop();
		this.#teardown();
	}

	#setupMeter(): void {
		if (!this.#stream) return;
		const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		this.#ctx = new Ctx();
		const source = this.#ctx.createMediaStreamSource(this.#stream);
		this.#analyser = this.#ctx.createAnalyser();
		this.#analyser.fftSize = 256;
		source.connect(this.#analyser);
	}

	#pumpLevel(): void {
		if (!this.#analyser) return;
		const buf = new Uint8Array(this.#analyser.frequencyBinCount);
		const tick = () => {
			if (!this.#analyser || this.#recorder?.state !== 'recording') return;
			this.#analyser.getByteTimeDomainData(buf);
			let peak = 0;
			for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
			this.onLevel?.(peak);
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	#teardown(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#recorder = null;
		this.#analyser = null;
		this.#ctx?.close().catch(() => {});
		this.#ctx = null;
		this.#stream?.getTracks().forEach((t) => t.stop());
		this.#stream = null;
		this.onLevel?.(0);
	}
}

function pickMimeType(): string {
	for (const mt of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
		if (MediaRecorder.isTypeSupported?.(mt)) return mt;
	}
	return '';
}
