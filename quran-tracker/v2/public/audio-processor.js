class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 4800; // send audio chunk every 300ms at 16kHz

    // VAD state -- runs at native sample rate for instant detection
    this._silenceThreshold = 0.005;
    this._silenceFrames = 0;      // consecutive silent frames (128 samples each)
    this._speechFrames = 0;       // consecutive speech frames
    this._isSpeaking = false;
    // At 48kHz: 128 samples/frame = 2.67ms/frame
    // 75 frames ~ 200ms (minimum pause between ayahs)
    // 150 frames ~ 400ms (reliable inter-ayah pause)
    this._pauseFrameThreshold = 75;  // ~200ms at 48kHz
    this._speechOnsetFrames = 4;     // ~11ms to confirm speech start
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // ── VAD: compute RMS on every frame (128 samples, ~2.67ms at 48kHz) ──
    let sumSq = 0;
    for (let i = 0; i < channelData.length; i++) {
      sumSq += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sumSq / channelData.length);

    if (rms < this._silenceThreshold) {
      this._silenceFrames++;
      this._speechFrames = 0;

      if (this._isSpeaking && this._silenceFrames >= this._pauseFrameThreshold) {
        // Speech -> Silence transition (pause detected)
        this._isSpeaking = false;
        const pauseDurationMs = Math.round(this._silenceFrames * channelData.length / sampleRate * 1000);
        this.port.postMessage({
          type: 'vad',
          event: 'pause',
          durationMs: pauseDurationMs,
        });
      }
    } else {
      this._speechFrames++;
      if (!this._isSpeaking && this._speechFrames >= this._speechOnsetFrames) {
        // Silence -> Speech transition
        this._isSpeaking = true;
        this._silenceFrames = 0;
        this.port.postMessage({
          type: 'vad',
          event: 'speech',
        });
      }
      this._silenceFrames = 0;
    }

    // ── Resample and buffer audio for ASR (unchanged logic) ──
    const inputSampleRate = sampleRate;
    const outputSampleRate = 16000;
    const ratio = inputSampleRate / outputSampleRate;

    for (let i = 0; i < channelData.length; i += ratio) {
      this._buffer.push(channelData[Math.floor(i)]);
    }

    if (this._buffer.length >= this._bufferSize) {
      const chunk = new Float32Array(this._buffer);
      this.port.postMessage({ type: 'audio', buffer: chunk.buffer }, [chunk.buffer]);
      this._buffer = [];
    }

    return true;
  }
}

registerProcessor("audio-stream-processor", AudioStreamProcessor);
