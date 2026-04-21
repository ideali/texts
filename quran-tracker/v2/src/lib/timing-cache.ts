/**
 * Loads and caches word-level timing data from Quran.com API.
 * Used by the predictive cursor to estimate word positions
 * without waiting for ASR inference.
 *
 * API: GET /api/v4/recitations/{reciter}/by_ayah/{surah}:{ayah}?fields=segments
 * Segment format: [word_index, word_position, start_ms, end_ms]
 */

const API_BASE = 'https://api.quran.com/api/v4';
const DEFAULT_RECITER = 7; // Mishari Rashid al-Afasy

export interface WordTiming {
  wordIndex: number;
  startMs: number;
  endMs: number;
}

export interface AyahTimings {
  surah: number;
  ayah: number;
  totalDurationMs: number;
  words: WordTiming[];
}

// Cache: surah -> ayah -> timings
const cache = new Map<number, Map<number, AyahTimings>>();

/**
 * Load word timings for an entire surah from Quran.com API.
 * Results are cached in memory.
 */
export async function loadSurahTimings(
  surah: number,
  reciterId = DEFAULT_RECITER,
): Promise<Map<number, AyahTimings>> {
  const existing = cache.get(surah);
  if (existing && existing.size > 0) return existing;

  const ayahMap = new Map<number, AyahTimings>();
  cache.set(surah, ayahMap);

  try {
    // Fetch all ayahs for this surah (paginated, max 50 per page)
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${API_BASE}/recitations/${reciterId}/by_ayah/${surah}?fields=segments&per_page=50&page=${page}`;
      const resp = await fetch(url);
      if (!resp.ok) break;

      const data = await resp.json();
      const files = data.audio_files || [];

      for (const file of files) {
        const vk = file.verse_key as string; // "1:1"
        const parts = vk.split(':');
        const ayah = parseInt(parts[1]);
        const segments: number[][] = file.segments || [];

        const words: WordTiming[] = [];
        let maxEnd = 0;

        for (const seg of segments) {
          // Format: [word_index, word_position, start_ms, end_ms]
          const [wordIdx, , startMs, endMs] = seg;
          words.push({ wordIndex: wordIdx, startMs, endMs });
          if (endMs > maxEnd) maxEnd = endMs;
        }

        ayahMap.set(ayah, {
          surah,
          ayah,
          totalDurationMs: maxEnd,
          words,
        });
      }

      hasMore = data.pagination?.next_page != null;
      page++;
    }
  } catch {
    // Network errors are non-fatal -- predictive cursor is optional
  }

  return ayahMap;
}

/**
 * Get cached timings for a specific ayah. Returns null if not loaded.
 */
export function getAyahTimings(surah: number, ayah: number): AyahTimings | null {
  return cache.get(surah)?.get(ayah) ?? null;
}

/**
 * Given elapsed time in the current ayah and the timing data,
 * estimate which word should be highlighted.
 *
 * @param elapsedMs - time since the ayah started being recited
 * @param timings - word timing data for this ayah
 * @param tempoRatio - speed adjustment (1.0 = reference speed, 0.8 = slower, 1.2 = faster)
 * @returns estimated word index (0-based), or -1 if no timing data
 */
export function estimateWordPosition(
  elapsedMs: number,
  timings: AyahTimings,
  tempoRatio: number,
): number {
  if (timings.words.length === 0) return -1;

  // Adjust elapsed time by tempo ratio
  // If imam reads faster (tempoRatio > 1), reference time passes faster
  const adjustedMs = elapsedMs * tempoRatio;

  let lastMatch = -1;
  for (const word of timings.words) {
    if (adjustedMs >= word.startMs) {
      lastMatch = word.wordIndex;
    } else {
      break;
    }
  }

  return lastMatch;
}
