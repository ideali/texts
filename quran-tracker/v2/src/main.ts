/**
 * Quran Recitation Tracker -- UI entry point.
 *
 * - Loads inference worker via Blob URL (Arc browser compatibility)
 * - Captures microphone audio, resamples to 16kHz via AudioWorklet
 * - Renders verse groups with surah headers, bismillah handling
 * - Highlights active/recited verses and spoken/error words
 * - Shows Russian translation bar at bottom
 */

import './style.css';

// Worker URL: Vite builds inference.ts as a separate entry with stable name.
// At runtime we fetch as text -> Blob URL for Arc browser compatibility.
const BASE = import.meta.env.BASE_URL; // "/quran/" in production
const InferenceWorkerUrl = import.meta.env.DEV
  ? new URL('../worker/inference.ts', import.meta.url).href
  : BASE + 'assets/inference.js';

// ── Types ──

interface VerseData {
  ayah: number;
  text_uthmani: string;
}

interface SurahData {
  surah: number;
  surah_name: string;
  surah_name_en: string;
  verses: VerseData[];
}

interface VerseGroup {
  surah: number;
  surahName: string;
  surahNameEn: string;
  currentAyah: number;
  verses: VerseData[];
  element: HTMLDivElement;
}

interface AppState {
  groups: VerseGroup[];
  worker: Worker | null;
  audioCtx: AudioContext | null;
  stream: MediaStream | null;
  isActive: boolean;
  hasFirstMatch: boolean;
  modelReady: boolean;
  surahCache: Map<number, SurahData>;
  quranData: any[] | null;
  translations: Record<string, string> | null;
  lastModelPrediction: { surah: number; ayah: number; confidence: number } | null;
}

// ── State ──

const state: AppState = {
  groups: [],
  worker: null,
  audioCtx: null,
  stream: null,
  isActive: false,
  hasFirstMatch: false,
  modelReady: false,
  surahCache: new Map(),
  quranData: null,
  translations: null,
  lastModelPrediction: null,
};

// ── DOM references ──

const versesEl = document.getElementById('verses')!;
const translationText = document.getElementById('translation-text')!;
const surahIndicator = document.getElementById('surah-indicator')!;
const rawTranscript = document.getElementById('raw-transcript')!;
const listeningIndicator = document.getElementById('listening-indicator')!;
const permissionPrompt = document.getElementById('permission-prompt')!;
const listeningStatus = document.getElementById('listening-status')!;
const modelStatus = document.getElementById('model-status')!;
const loadingStatus = document.getElementById('loading-status')!;
const loadingProgress = document.getElementById('loading-progress')! as HTMLDivElement;
const loadingDetail = document.getElementById('loading-detail')!;
const readyState = document.getElementById('ready-state')!;
const recordingState = document.getElementById('recording-state')!;
const postRecording = document.getElementById('post-recording')!;
const btnStart = document.getElementById('btn-start')!;
const btnStop = document.getElementById('btn-stop')!;
const btnRestart = document.getElementById('btn-restart')!;

// ── Eastern Arabic numerals ──

const EASTERN_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

function toEasternArabic(n: number): string {
  return String(n)
    .split('')
    .map((ch) => EASTERN_DIGITS[parseInt(ch)])
    .join('');
}

// ── Quran data loading ──

async function ensureQuranData(): Promise<void> {
  if (state.quranData) return;
  const basePath = '/quran/';
  const [quranResp, transResp] = await Promise.all([
    fetch(basePath + 'quran_phonemes.json'),
    fetch(basePath + 'translations_ru.json'),
  ]);
  state.quranData = await quranResp.json();
  state.translations = await transResp.json();
}

async function loadSurah(surahNum: number): Promise<SurahData> {
  const cached = state.surahCache.get(surahNum);
  if (cached) return cached;

  await ensureQuranData();
  const verses = state.quranData!.filter((v: any) => v.surah === surahNum);
  if (!verses.length) throw new Error(`Surah ${surahNum} not found`);

  const data: SurahData = {
    surah: surahNum,
    surah_name: verses[0].surah_name,
    surah_name_en: verses[0].surah_name_en,
    verses: verses.map((v: any) => ({
      ayah: v.ayah,
      text_uthmani: v.text_uthmani,
    })),
  };
  state.surahCache.set(surahNum, data);
  return data;
}

// ── Text processing ──

const PAUSE_MARKS = new Set(['ۖ', 'ۗ', 'ۘ', 'ۙ', 'ۚ', 'ۛ', 'ۜ']);

function isPauseMark(text: string): boolean {
  return text.length <= 2 && [...text].every((ch) => PAUSE_MARKS.has(ch));
}

interface WordToken {
  text: string;
  isRealWord: boolean;
}

function tokenizeVerse(text: string): WordToken[] {
  const rawWords = text.split(/\s+/).filter((w) => w.length > 0);
  const tokens: WordToken[] = [];
  for (const w of rawWords) {
    if (isPauseMark(w) && tokens.length > 0) {
      tokens[tokens.length - 1].text += ' ' + w;
    } else {
      tokens.push({ text: w, isRealWord: true });
    }
  }
  return tokens;
}

// ── Bismillah handling ──

const BISMILLAH_WORD_COUNT = 4;
const BISMILLAH = 'بسم الله الرحمن الرحيم';

function stripDiacritics(text: string): string {
  return text.replace(
    /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g,
    '',
  );
}

function startsWithBismillah(text: string): boolean {
  const stripped = stripDiacritics(text);
  return stripped.startsWith(BISMILLAH) || stripped.startsWith(stripDiacritics(BISMILLAH));
}

// ── Verse group rendering ──

function createVerseGroup(group: VerseGroup): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'verse-group';
  container.setAttribute('data-surah', String(group.surah));

  // Surah header
  const header = document.createElement('div');
  header.className = 'surah-header';
  header.textContent = group.surahNameEn;
  container.appendChild(header);

  // Bismillah line (except Al-Fatiha and At-Tawbah)
  const hasBismillah =
    group.surah !== 1 &&
    group.surah !== 9 &&
    startsWithBismillah(group.verses[0]?.text_uthmani ?? '');

  if (hasBismillah) {
    const bsmText = group.verses[0].text_uthmani.split(/\s+/).slice(0, BISMILLAH_WORD_COUNT).join(' ');
    const bsmEl = document.createElement('div');
    bsmEl.className = 'bismillah';
    bsmEl.dir = 'rtl';
    bsmEl.lang = 'ar';
    bsmEl.textContent = bsmText;
    container.appendChild(bsmEl);
  }

  // Verse body
  const body = document.createElement('div');
  body.className = 'verse-body';
  body.dir = 'rtl';
  body.lang = 'ar';

  for (const verse of group.verses) {
    const verseSpan = document.createElement('span');
    verseSpan.className = 'verse verse--upcoming';
    verseSpan.setAttribute('data-ayah', String(verse.ayah));

    const tokens = tokenizeVerse(verse.text_uthmani);
    const skipWords = hasBismillah && verse.ayah === 1 ? BISMILLAH_WORD_COUNT : 0;

    const textSpan = document.createElement('span');
    textSpan.className = 'verse-text';

    for (let i = skipWords; i < tokens.length; i++) {
      const wordEl = document.createElement('span');
      wordEl.className = 'word';
      wordEl.setAttribute('data-word-idx', String(i));
      wordEl.textContent = tokens[i].text;
      textSpan.appendChild(wordEl);

      if (i < tokens.length - 1) {
        textSpan.appendChild(document.createTextNode(' '));
      }
    }

    verseSpan.appendChild(textSpan);

    const marker = document.createElement('span');
    marker.className = 'verse-marker';
    marker.textContent = ` ۝${toEasternArabic(verse.ayah)} `;
    verseSpan.appendChild(marker);

    body.appendChild(verseSpan);
  }

  container.appendChild(body);
  return container;
}

// ── Verse highlighting ──

function highlightVerse(group: VerseGroup, ayah: number): void {
  const el = group.element;
  const prevAyah = group.currentAyah;
  const verseEls = el.querySelectorAll('.verse');

  for (const vEl of verseEls) {
    const vAyah = parseInt(vEl.getAttribute('data-ayah') || '0');
    if (vAyah === ayah) {
      vEl.className = 'verse verse--active';
    } else if (
      vAyah <= ayah &&
      (vEl.classList.contains('verse--active') || vAyah > prevAyah || vAyah <= prevAyah)
    ) {
      vEl.className = 'verse verse--recited';
    }
  }

  group.currentAyah = ayah;
  scrollToActive();
}

function scrollToActive(): void {
  const active = document.querySelector('.verse--active');
  if (active) {
    active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ── Event handlers ──

async function handleVerseMatch(event: any): Promise<void> {
  rawTranscript.textContent = '';
  rawTranscript.classList.remove('visible');

  state.lastModelPrediction = {
    surah: event.surah,
    ayah: event.ayah,
    confidence: event.confidence,
  };

  // Translation
  if (state.translations) {
    const key = event.surah + ':' + event.ayah;
    translationText.textContent = state.translations[key] || '';
  }

  // Surah indicator
  if (state.quranData) {
    const verse = state.quranData.find(
      (v: any) => v.surah === event.surah && v.ayah === event.ayah,
    );
    surahIndicator.textContent = verse
      ? verse.surah_name + ' · ' + event.surah + ':' + event.ayah
      : '';
  }

  // First match -- hide listening prompt
  if (!state.hasFirstMatch) {
    state.hasFirstMatch = true;
    listeningStatus.hidden = true;
    listeningIndicator.classList.add('has-verses');
  }

  // Check if same surah group exists
  const lastGroup = state.groups[state.groups.length - 1];
  if (lastGroup && lastGroup.surah === event.surah) {
    highlightVerse(lastGroup, event.ayah);
    return;
  }

  // Remove old group with animation
  if (lastGroup) {
    lastGroup.element.classList.add('verse-group--exiting');
    const oldEl = lastGroup.element;
    setTimeout(() => oldEl.remove(), 400);
  }

  // Create new group
  const surahData = await loadSurah(event.surah);
  const newGroup: VerseGroup = {
    surah: event.surah,
    surahName: surahData.surah_name,
    surahNameEn: surahData.surah_name_en,
    currentAyah: 0,
    verses: surahData.verses,
    element: document.createElement('div'),
  };
  newGroup.element = createVerseGroup(newGroup);

  state.groups.push(newGroup);
  versesEl.appendChild(newGroup.element);

  highlightVerse(newGroup, event.ayah);
}

// ── Word progress ──

let spokenWords = new Set<number>();
let currentProgressRef = '';

function handleWordProgress(event: any): void {
  const lastGroup = state.groups[state.groups.length - 1];
  if (!lastGroup || lastGroup.surah !== event.surah) return;

  const verseEl = lastGroup.element.querySelector(
    `.verse[data-ayah="${event.ayah}"]`,
  );
  if (!verseEl) return;

  // Ensure verse is active
  if (!verseEl.classList.contains('verse--active')) {
    highlightVerse(lastGroup, event.ayah);
  }

  const ref = `${event.surah}:${event.ayah}`;
  if (ref !== currentProgressRef) {
    spokenWords = new Set();
    currentProgressRef = ref;
  }

  for (const idx of event.matched_indices) {
    spokenWords.add(idx);
  }

  // Find contiguous spoken range from start
  let lastContiguous = -1;
  for (let i = 0; i <= event.total_words && spokenWords.has(i); i++) {
    lastContiguous = i;
  }

  const wordEls = verseEl.querySelectorAll('.word');
  for (const wEl of wordEls) {
    const idx = parseInt(wEl.getAttribute('data-word-idx') || '-1');
    if (idx <= lastContiguous) {
      wEl.classList.add('word--spoken');
    }
  }
}

// ── Word corrections ──

function handleWordCorrection(event: any): void {
  const lastGroup = state.groups[state.groups.length - 1];
  if (!lastGroup || lastGroup.surah !== event.surah) return;

  const verseEl = lastGroup.element.querySelector(
    `.verse[data-ayah="${event.ayah}"]`,
  );
  if (!verseEl) return;

  const errorIndices = new Set(event.corrections.map((c: any) => c.word_index));
  const wordEls = verseEl.querySelectorAll('.word');

  for (const wEl of wordEls) {
    const idx = parseInt(wEl.getAttribute('data-word-idx') || '-1');
    if (errorIndices.has(idx)) {
      wEl.classList.add('word--error');
    } else {
      wEl.classList.remove('word--error');
    }
  }
}

// ── Raw transcript ──

function handleRawTranscript(event: any): void {
  rawTranscript.textContent = event.text;
  rawTranscript.classList.add('visible');
}

// ── Worker message router ──

function handleWorkerMessage(event: any): void {
  if (event.type === 'loading') {
    modelStatus.textContent = `Loading model... ${event.percent}%`;
    modelStatus.classList.remove('ready');
    loadingProgress.style.width = `${event.percent}%`;
    loadingDetail.textContent = `Downloading model — ${event.percent}%`;
  } else if (event.type === 'loading_status') {
    loadingDetail.textContent = event.message;
  } else if (event.type === 'error') {
    loadingDetail.textContent = `Error: ${event.message}`;
    modelStatus.textContent = 'Error';
    console.error('Worker reported error:', event.message);
  } else if (event.type === 'ready') {
    modelStatus.textContent = 'Model ready';
    modelStatus.classList.add('ready');
    state.modelReady = true;
    loadingStatus.hidden = true;
    readyState.hidden = false;
  } else if (event.type === 'verse_match') {
    handleVerseMatch(event);
  } else if (event.type === 'word_progress') {
    handleWordProgress(event);
  } else if (event.type === 'word_correction') {
    handleWordCorrection(event);
  } else if (event.type === 'raw_transcript') {
    handleRawTranscript(event);
  }
}

// ── Audio capture ──

async function startAudio(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    state.stream = stream;
    permissionPrompt.hidden = true;

    const ctx = new AudioContext();
    state.audioCtx = ctx;

    await ctx.audioWorklet.addModule('/quran/' + 'audio-processor.js');

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, 'audio-stream-processor');

    workletNode.port.onmessage = (msg: MessageEvent) => {
      const samples = new Float32Array(msg.data);
      if (state.worker) {
        state.worker.postMessage(
          { type: 'audio', samples },
          [samples.buffer],
        );
      }
    };

    // Audio level visualization
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    source.connect(workletNode);

    const timeDomain = new Float32Array(analyser.fftSize);

    const visualize = () => {
      if (!state.isActive) return;
      analyser.getFloatTimeDomainData(timeDomain);

      let rms = 0;
      for (let i = 0; i < timeDomain.length; i++) {
        rms += timeDomain[i] * timeDomain[i];
      }

      if (Math.sqrt(rms / timeDomain.length) > 0.01) {
        listeningIndicator.classList.add('audio-detected');
        listeningIndicator.classList.remove('silence');
      } else {
        listeningIndicator.classList.remove('audio-detected');
        listeningIndicator.classList.add('silence');
      }

      requestAnimationFrame(visualize);
    };
    visualize();

    state.isActive = true;
    listeningIndicator.classList.add('active');
  } catch (err) {
    console.error('Failed to start audio:', err);
    permissionPrompt.hidden = false;
  }
}

function stopAudio(): void {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close();
    state.audioCtx = null;
  }
  state.isActive = false;
  listeningIndicator.classList.remove('active', 'audio-detected', 'silence', 'has-verses');
}

// ── DOM clearing helper ──

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// ── App initialization ──

function initApp(): void {
  // Load worker via Blob URL trick (Arc browser compatibility)
  (async () => {
    try {
      const resp = await fetch(InferenceWorkerUrl);
      const workerText = await resp.text();
      const blob = new Blob([workerText], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const worker = new Worker(blobUrl);

      state.worker = worker;

      worker.onmessage = (msg: MessageEvent) => {
        handleWorkerMessage(msg.data);
      };

      worker.onerror = (err: ErrorEvent) => {
        loadingDetail.textContent = `Worker: ${err.message || 'error'}`;
      };

      const workerBaseUrl = location.origin + '/quran/';
      worker.postMessage({ type: 'init', baseUrl: workerBaseUrl });
    } catch (err) {
      loadingDetail.textContent = `Worker load: ${err instanceof Error ? err.message : err}`;
    }
  })();

  // Start button
  btnStart.addEventListener('click', async () => {
    readyState.hidden = true;
    recordingState.hidden = false;
    state.lastModelPrediction = null;
    state.hasFirstMatch = false;
    state.groups = [];
    clearChildren(versesEl);
    rawTranscript.textContent = '';
    rawTranscript.classList.remove('visible');
    state.worker?.postMessage({ type: 'reset' });
    await startAudio();
  });

  // Stop button
  btnStop.addEventListener('click', () => {
    stopAudio();
    recordingState.hidden = true;
    postRecording.hidden = false;
  });

  // Restart button
  btnRestart.addEventListener('click', () => {
    state.lastModelPrediction = null;
    state.hasFirstMatch = false;
    state.groups = [];
    clearChildren(versesEl);
    rawTranscript.textContent = '';
    rawTranscript.classList.remove('visible');
    postRecording.hidden = true;
    readyState.hidden = false;
  });
}

// ── Entry point ──

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
