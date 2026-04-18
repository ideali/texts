/**
 * Mel spectrogram computation for FastConformer phoneme CTC model.
 *
 * Uses @huggingface/transformers for FFT/spectrogram internals.
 * Applies pre-emphasis, dithering, log-mel, and per-bin normalization.
 */
import {
  spectrogram,
  window_function,
  mel_filter_bank,
} from '@huggingface/transformers';

// Audio / spectrogram constants matching the FastConformer config
const SAMPLE_RATE = 16000;
const N_FFT = 512;
const HOP_LENGTH = 160;
const WIN_LENGTH = 400;
const MEL_BINS = 80;
const PRE_EMPHASIS = 0.97;

// Noise floors
const DITHER_MAGNITUDE = 1e-5;
const LOG_FLOOR = 1e-5;

// Lazily initialized filter bank and window
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedMelFilters: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedWindow: any = null;

function getMelFilters() {
  if (!cachedMelFilters) {
    cachedMelFilters = mel_filter_bank(
      N_FFT / 2 + 1, // 257 frequency bins
      MEL_BINS,       // 80 mel bins
      0,              // freq_min
      8000,           // freq_max
      SAMPLE_RATE,
      'slaney',       // norm
      'htk',          // mel_scale
    );
  }
  return cachedMelFilters;
}

function getWindow() {
  if (!cachedWindow) {
    cachedWindow = window_function(WIN_LENGTH, 'hann', { periodic: true });
  }
  return cachedWindow;
}

export interface MelResult {
  /** Flattened mel features: [mel_bins, timeFrames] in row-major order. */
  features: Float32Array;
  /** Number of time frames. */
  timeFrames: number;
}

/**
 * Compute normalized log-mel spectrogram from raw PCM audio.
 *
 * Pipeline:
 * 1. Add small dithering noise to prevent log(0)
 * 2. Compute power spectrogram with pre-emphasis
 * 3. Apply mel filter bank
 * 4. Log transform
 * 5. Per-mel-bin mean/std normalization (zero-mean, unit-variance)
 */
export async function computeMelSpectrogram(samples: Float32Array): Promise<MelResult> {
  // Step 1: dithering
  const dithered = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    dithered[i] = samples[i] + DITHER_MAGNITUDE * (Math.random() * 2 - 1);
  }

  const melFilters = getMelFilters();
  const win = getWindow();

  // Step 2-3: spectrogram with mel filters
  const spec = await spectrogram(dithered, win, WIN_LENGTH, HOP_LENGTH, {
    fft_length: N_FFT,
    power: 2,
    center: false,
    pad_mode: 'reflect',
    onesided: true,
    preemphasis: PRE_EMPHASIS,
    mel_filters: melFilters,
    mel_floor: 1e-10,
    log_mel: null as unknown as undefined, // we do log manually for the floor value
    transpose: false,    // output: [mel_bins, timeFrames]
  });

  const rawData = spec.data as Float32Array;
  const timeFrames = spec.dims[1] as number;

  // Step 4: log transform
  const logMel = new Float32Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    logMel[i] = Math.log(rawData[i] + LOG_FLOOR);
  }

  // Step 5: per-mel-bin normalization (zero-mean, unit-variance)
  for (let mel = 0; mel < MEL_BINS; mel++) {
    // Compute mean
    let sum = 0;
    for (let t = 0; t < timeFrames; t++) {
      sum += logMel[mel * timeFrames + t];
    }
    const mean = sum / timeFrames;

    // Compute standard deviation
    let variance = 0;
    for (let t = 0; t < timeFrames; t++) {
      const diff = logMel[mel * timeFrames + t] - mean;
      variance += diff * diff;
    }
    const std = Math.sqrt(variance / timeFrames) || 1e-10;

    // Normalize
    for (let t = 0; t < timeFrames; t++) {
      logMel[mel * timeFrames + t] = (logMel[mel * timeFrames + t] - mean) / std;
    }
  }

  return { features: logMel, timeFrames };
}
