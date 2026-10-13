/**
 * Captures mono 16 kHz PCM from the microphone via AudioWorklet.
 *
 * Two consumers of the same stream:
 *  - the full recording (returned by stop()) — fallback / whole-clip use;
 *  - live utterance segments (onSegment), cut by a simple energy VAD:
 *    flushed after ~0.7 s of silence or 12 s of continuous speech, with
 *    pre-roll kept between segments and cuts placed at the quietest window.
 */

export interface RecordingResult {
	/** Mono 16 kHz audio, amplitude −1…1 */
	pcm: Float32Array;
	sampleRate: number;
	durationSec: number;
}

export type RecorderState = 'idle' | 'recording';

const TARGET_SR = 16000;

// --- live segmentation (VAD) tuning ---
const SILENCE_MS = 700;
const MIN_SEG_SAMPLES = TARGET_SR * 0.5;
const MAX_SEG_SAMPLES = TARGET_SR * 12;
const PRE_ROLL_SAMPLES = TARGET_SR * 0.35; // context kept between segments
const SILENCE_KEEP = TARGET_SR * 2; // max speech-less audio to retain

const WORKLET_SRC = `
class PCMCollector extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('pcm-collector', PCMCollector);
`;

export class Recorder {
	#stream: MediaStream | null = null;
	#ctx: AudioContext | null = null;
	#node: AudioWorkletNode | null = null;

	// full recording
	#frames: Float32Array[] = [];
	#samples = 0;
	#startedAt = 0;
	#timer: ReturnType<typeof setInterval> | null = null;

	// live segmentation state
	#segFrames: Float32Array[] = [];
	#segSamples = 0;
	#segHasVoice = false;
	#noiseFloor = 0.003;
	#lastVoiceAt = 0;

	onLevel: ((level: number) => void) | null = null;
	onTick: ((elapsedSec: number) => void) | null = null;
	/** Fired with each detected utterance segment while recording. */
	onSegment: ((pcm: Float32Array) => void) | null = null;

	get state(): RecorderState {
		return this.#stream ? 'recording' : 'idle';
	}

	/** Requests the mic and starts collecting PCM. Throws a friendly Error on failure. */
	async start(): Promise<void> {
		if (this.#stream) return;
		try {
			this.#stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
		} catch {
			throw new Error('Microphone access was denied. Enable it in your browser settings.');
		}

		const workletURL = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
		try {
			this.#ctx = new AudioContext({ sampleRate: TARGET_SR });
			await this.#ctx.audioWorklet.addModule(workletURL);
			const source = this.#ctx.createMediaStreamSource(this.#stream);
			this.#node = new AudioWorkletNode(this.#ctx, 'pcm-collector');
			this.#node.port.onmessage = (e: MessageEvent<Float32Array>) => this.#onFrame(e.data);
			source.connect(this.#node); // the worklet emits no output; that is fine

			this.#startedAt = performance.now();
			this.#lastVoiceAt = this.#startedAt;
			this.#segHasVoice = false;
			this.#timer = setInterval(
				() => this.onTick?.((performance.now() - this.#startedAt) / 1000),
				200
			);
		} catch {
			this.#teardown();
			throw new Error('Could not initialise audio capture in this browser.');
		} finally {
			URL.revokeObjectURL(workletURL);
		}
	}

	/**
	 * Stops recording and resolves with the captured PCM. The final utterance
	 * segment (if any) is emitted through onSegment before resolving.
	 */
	async stop(): Promise<RecordingResult> {
		if (!this.#stream || !this.#ctx) throw new Error('Not recording');

		// let the last worklet messages (in flight) arrive before we detach
		await new Promise((r) => setTimeout(r, 80));

		this.#flushSegment(true);

		const durationSec = (performance.now() - this.#startedAt) / 1000;
		const rawRate = this.#ctx.sampleRate;
		const raw = new Float32Array(this.#samples);
		let off = 0;
		for (const f of this.#frames) {
			raw.set(f, off);
			off += f.length;
		}
		this.#teardown();

		const pcm = rawRate === TARGET_SR ? raw : resample(raw, rawRate, TARGET_SR);
		if (pcm.length < TARGET_SR * 0.3) throw new Error('Recording was too short');
		return { pcm, sampleRate: TARGET_SR, durationSec };
	}

	cancel(): void {
		this.#teardown();
	}

	// ---------------------------------------------------------------- capture
	#onFrame(frame: Float32Array): void {
		let sum = 0;
		for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
		const rms = Math.sqrt(sum / frame.length);
		this.onLevel?.(Math.min(1, rms * 4));

		// full recording
		this.#frames.push(frame);
		this.#samples += frame.length;

		// live segmentation
		this.#segmentFrame(frame, rms);
	}

	#segmentFrame(frame: Float32Array, level: number): void {
		const isVoice = level > Math.max(0.008, this.#noiseFloor * 3);
		if (isVoice) {
			this.#lastVoiceAt = performance.now();
			this.#segHasVoice = true;
		} else if (level < 0.02) {
			// adapt to room noise, but only from genuinely quiet frames
			this.#noiseFloor = Math.min(0.02, this.#noiseFloor * 0.97 + level * 0.03);
		}

		this.#segFrames.push(frame);
		this.#segSamples += frame.length;

		if (!this.#segHasVoice) {
			// buffer holds no speech: keep only a short tail (pre-roll context)
			this.#trimSegmentBuffer(SILENCE_KEEP);
		} else if (
			(this.#segSamples >= MIN_SEG_SAMPLES &&
				performance.now() - this.#lastVoiceAt > SILENCE_MS) ||
			this.#segSamples >= MAX_SEG_SAMPLES
		) {
			this.#flushSegment(false);
		}
	}

	#flushSegment(force: boolean): void {
		if (!this.#segHasVoice) return; // never emit silence-only segments
		if (this.#segSamples < (force ? 400 : MIN_SEG_SAMPLES)) return;

		const all = this.#concatSegment();
		let seg: Float32Array;

		if (force) {
			seg = all;
			this.#segHasVoice = false;
		} else if (all.length > MAX_SEG_SAMPLES) {
			// Long continuous speech: cut at the quietest 100 ms window near
			// the end instead of chopping mid-word; the remainder continues.
			const win = TARGET_SR / 10;
			const searchStart = Math.max(0, all.length - 1.5 * TARGET_SR);
			let bestE = Infinity;
			let bestI = all.length - win;
			for (let i = searchStart; i + win <= all.length; i += win / 2) {
				let e = 0;
				for (let j = i; j < i + win; j++) e += all[j] * all[j];
				if (e < bestE) {
					bestE = e;
					bestI = i + win / 2;
				}
			}
			const cut = Math.floor(bestI);
			const remainder = all.slice(cut);
			seg = all.slice(0, cut);
			this.#segFrames = [remainder];
			this.#segSamples = remainder.length;
			this.#segHasVoice = true; // remainder likely still has speech
		} else {
			// Normal end-of-utterance: keep a pre-roll so the next segment
			// starts with context before the first detected voice frame.
			const cut = Math.max(0, all.length - PRE_ROLL_SAMPLES);
			seg = all.slice(0, cut);
			const pre = all.slice(cut);
			this.#segFrames = [pre];
			this.#segSamples = pre.length;
			this.#segHasVoice = false;
		}

		if (seg.length >= 400) this.onSegment?.(seg);
	}

	#concatSegment(): Float32Array {
		const out = new Float32Array(this.#segSamples);
		let off = 0;
		for (const f of this.#segFrames) {
			out.set(f, off);
			off += f.length;
		}
		this.#segFrames = [];
		this.#segSamples = 0;
		return out;
	}

	#trimSegmentBuffer(maxSamples: number): void {
		while (
			this.#segFrames.length > 1 &&
			this.#segSamples - this.#segFrames[0].length >= maxSamples
		) {
			this.#segSamples -= this.#segFrames[0].length;
			this.#segFrames.shift();
		}
	}

	#teardown(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		if (this.#node) this.#node.port.onmessage = null;
		this.#node = null;
		this.#ctx?.close().catch(() => {});
		this.#ctx = null;
		this.#stream?.getTracks().forEach((t) => t.stop());
		this.#stream = null;
		this.#frames = [];
		this.#samples = 0;
		this.#segFrames = [];
		this.#segSamples = 0;
		this.#segHasVoice = false;
		this.onLevel?.(0);
	}
}

/** Naive box-average resampler — sufficient for speech recognition. */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	const ratio = fromRate / toRate;
	const outLen = Math.floor(input.length / ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j];
		out[i] = sum / (end - start);
	}
	return out;
}
