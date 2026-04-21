/**
 * Worker entry point for Quran recitation inference.
 *
 * Handles three message types:
 *   "init"  - Load vocab, model, Quran data, build trie, create tracker
 *   "reset" - Create fresh RecitationTracker (keeps model/db)
 *   "audio" - Feed audio samples to tracker, post results back
 */

import { initSession, runInference } from './session';
import { RecitationTracker } from '../lib/tracker';
import { QuranDB } from '../lib/quran-db';
import { CTCDecoder } from '../lib/ctc-decode';
import { beamSearchWithTrie } from '../lib/ctc-rescore';
import { computeMelSpectrogram } from '../lib/mel';
import { buildPhonemeTrie } from '../lib/phoneme-trie';
import type { TranscribeResult, AcousticData, PhonemeTrieCompact } from '../lib/types';

// ── State ──

let baseUrl = '/quran/';
let modelPath = baseUrl + 'fastconformer_phoneme_q8.onnx';

let tracker: RecitationTracker | null = null;
let decoder: CTCDecoder | null = null;
let db: QuranDB | null = null;
let trie: PhonemeTrieCompact | null = null;
let vocabRaw: Record<string, string> | null = null;

// ── Helpers ──

function postMsg(data: unknown): void {
  self.postMessage(data);
}

/**
 * Transcribe audio: mel spectrogram -> ONNX inference -> CTC decode + beam search.
 */
async function transcribe(audio: Float32Array): Promise<TranscribeResult> {
  const { features, timeFrames } = await computeMelSpectrogram(audio);
  const melBins = 80;
  const { logprobs, timeSteps, vocabSize } = await runInference(features, melBins, timeFrames);

  const decoded = decoder!.decode(logprobs, timeSteps, vocabSize);

  let beamMatches: Array<{ verseIndex: number; spanLength: number; score: number }> | undefined;

  if (trie) {
    const beamResults = beamSearchWithTrie(
      logprobs,
      timeSteps,
      vocabSize,
      decoder!.getBlankId(),
      trie,
      8,
    );
    const seen = new Set<string>();
    beamMatches = [];
    for (const beam of beamResults) {
      for (const match of beam.matchedVerses) {
        const key = `${match.verseIndex}:${match.spanLength}`;
        if (!seen.has(key)) {
          seen.add(key);
          beamMatches.push({
            verseIndex: match.verseIndex,
            spanLength: match.spanLength,
            score: beam.score,
          });
        }
      }
    }
  }

  return {
    ...decoded,
    acoustic: {
      logprobs,
      timeSteps,
      vocabSize,
      blankId: decoder!.getBlankId(),
    } as AcousticData,
    beamMatches,
  };
}

// ── Initialization ──

async function initialize(): Promise<void> {
  try {
    // 1. Load vocabulary
    postMsg({ type: 'loading_status', message: 'Loading vocabulary...' });
    const vocabResp = await fetch(baseUrl + 'phoneme_vocab.json');
    if (!vocabResp.ok) throw new Error(`phoneme_vocab.json fetch failed: ${vocabResp.status}`);
    const vocab = await vocabResp.json();
    vocabRaw = vocab;
    decoder = new CTCDecoder(vocab);

    // 2. Download model
    postMsg({ type: 'loading_status', message: 'Downloading model...' });
    const modelBuffer = await downloadModel(modelPath, (loaded, total) => {
      postMsg({ type: 'loading', percent: total ? Math.round((loaded / total) * 100) : 0 });
    });

    // 3. Create ONNX session
    postMsg({ type: 'loading_status', message: 'Creating inference session...' });
    await initSession(modelBuffer, baseUrl);

    // 4. Load Quran phonemes data
    postMsg({ type: 'loading_status', message: 'Loading Quran data...' });
    const quranResp = await fetch(baseUrl + 'quran_phonemes.json');
    if (!quranResp.ok) throw new Error(`quran_phonemes.json fetch failed: ${quranResp.status}`);
    const quranData = await quranResp.json();

    // 5. Build QuranDB
    db = new QuranDB(quranData, decoder);

    // 6. Build phoneme trie
    postMsg({ type: 'loading_status', message: 'Building search trie...' });
    trie = buildPhonemeTrie(quranData, vocabRaw!, 3).trie;

    // 7. Create tracker
    tracker = new RecitationTracker(db, transcribe);

    postMsg({ type: 'ready' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Worker init failed:', message);
    postMsg({ type: 'error', message });
  }
}

// ── Model download with progress + IndexedDB caching ──

const MODEL_CACHE_KEY = 'quran_model_v1';

async function downloadModel(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  // Try cache first
  const cached = await getCachedModel(MODEL_CACHE_KEY);
  if (cached) return cached;

  const resp = await fetch(url);
  const total = parseInt(resp.headers.get('content-length') || '0');
  const reader = resp.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  await setCachedModel(MODEL_CACHE_KEY, result.buffer);
  return result.buffer;
}

// IndexedDB helpers for model caching
async function getCachedModel(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openModelDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readonly');
      const req = tx.objectStore('models').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedModel(key: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openModelDB();
    const tx = db.transaction('models', 'readwrite');
    tx.objectStore('models').put(buffer, key);
  } catch {
    // Caching failure is non-fatal
  }
}

function openModelDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('quran-model-cache', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('models');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Message handler ──

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'init') {
    if (msg.baseUrl) {
      baseUrl = msg.baseUrl;
      modelPath = baseUrl + 'fastconformer_phoneme_q8.onnx';
    }
    await initialize();
  } else if (msg.type === 'reset') {
    if (db) {
      tracker = new RecitationTracker(db, transcribe);
    }
  } else if (msg.type === 'audio') {
    if (!tracker) return;
    const events = await tracker.feed(msg.samples);
    for (const event of events) {
      postMsg(event);
    }
  } else if (msg.type === 'vad_pause') {
    // Instant pause detection from AudioWorklet (~50ms latency vs 300ms+ from ASR)
    if (tracker) {
      tracker.onVadPause(msg.durationMs ?? 200);
    }
  } else if (msg.type === 'vad_speech') {
    if (tracker) {
      tracker.onVadSpeech();
    }
  }
};
