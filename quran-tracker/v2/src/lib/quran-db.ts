import type { QuranVerse, Candidate, CandidateSet, MatchResult } from './types';
import { CONTINUATION_BONUSES } from './types';
import type { CTCDecoder } from './ctc-decode';

const BISMILLAH_TEXT = 'bismi allahi arraHmaani arraHiimi';
const BISMILLAH_PHONEMES = 'b i s m i | a l l a h i | a r r a H m aa n i | a r r a H ii m i'.split(' ');

// ── String distance utilities ───────────────────────────────────────

/** Levenshtein distance using two Uint16Array rows (O(min(m,n)) space). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string as `a` for memory efficiency
  if (a.length > b.length) [a, b] = [b, a];

  const aLen = a.length;
  const bLen = b.length;
  let prev = new Uint16Array(aLen + 1);
  let curr = new Uint16Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

/** Normalized similarity ratio: (|a|+|b| - dist) / (|a|+|b|), in [0,1]. */
export function levenshteinRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (total - levenshteinDistance(a, b)) / total;
}

/**
 * Minimum edit distance of `query` against any prefix of `ref`.
 * First row initialized to 0 (free alignment start in ref),
 * tracks minimum of the final query-column across all ref positions.
 */
export function prefixEditDistance(query: string, ref: string): number {
  if (query.length === 0) return 0;
  if (ref.length === 0) return query.length;

  const qLen = query.length;
  const rLen = ref.length;
  let prev = new Uint16Array(qLen + 1);
  let curr = new Uint16Array(qLen + 1);

  for (let i = 0; i <= qLen; i++) prev[i] = i;
  let best = prev[qLen];

  for (let j = 1; j <= rLen; j++) {
    curr[0] = 0; // free start in ref
    for (let i = 1; i <= qLen; i++) {
      const cost = query[i - 1] === ref[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
    }
    best = Math.min(best, curr[qLen]);
    [prev, curr] = [curr, prev];
  }

  return best;
}

/** Fragment score: 1 - prefixEditDistance / queryLength, clamped to [0,1]. */
export function fragmentScore(query: string, ref: string): number {
  if (query.length === 0) return 1;
  return Math.max(0, 1 - prefixEditDistance(query, ref) / query.length);
}

// ── Sliding window suffix-prefix overlap ────────────────────────────

function suffixPrefixScore(query: string, ref: string): number {
  const qWords = query.split(' ');
  const rWords = ref.split(' ');
  if (qWords.length < 2 || rWords.length < 2) return 0;

  let best = 0;
  const maxDrop = Math.min(Math.floor(qWords.length / 2), 4);

  for (let drop = 1; drop <= maxDrop; drop++) {
    const suffix = qWords.slice(drop).join(' ');
    const suffixWordCount = qWords.length - drop;
    const refPrefix = rWords.slice(0, Math.min(suffixWordCount, rWords.length)).join(' ');
    best = Math.max(best, levenshteinRatio(suffix, refPrefix));
  }

  return best;
}

// ── QuranDB ─────────────────────────────────────────────────────────

export class QuranDB {
  readonly verses: QuranVerse[];
  private readonly tokenEncoder: CTCDecoder | null;
  private readonly _byRef = new Map<string, QuranVerse>();
  private readonly _bySurah = new Map<number, QuranVerse[]>();

  constructor(verses: QuranVerse[], tokenEncoder: CTCDecoder | null) {
    this.tokenEncoder = tokenEncoder;
    this.verses = verses;

    for (const v of verses) {
      this._byRef.set(`${v.surah}:${v.ayah}`, v);

      const surahList = this._bySurah.get(v.surah) ?? [];
      surahList.push(v);
      this._bySurah.set(v.surah, surahList);

      // Tokenize phonemes
      v.phoneme_tokens = v.phonemes.trim().split(/\s+/).filter(Boolean);

      // Strip bismillah prefix for ayah 1 (except surahs 1 and 9)
      if (v.ayah === 1 && v.surah !== 1 && v.surah !== 9 && v.phonemes_joined.startsWith(BISMILLAH_TEXT)) {
        const rest = v.phonemes_joined.slice(BISMILLAH_TEXT.length).trim();
        v.phonemes_joined_no_bsm = rest || null;

        let noBsmTokens = v.phoneme_tokens.slice(BISMILLAH_PHONEMES.length);
        if (noBsmTokens[0] === '|') noBsmTokens = noBsmTokens.slice(1);
        v.phoneme_tokens_no_bsm = noBsmTokens.length ? noBsmTokens : null;
      } else {
        v.phonemes_joined_no_bsm = null;
        v.phoneme_tokens_no_bsm = null;
      }

      // No-space versions for character-level matching
      v.phonemes_joined_ns = v.phonemes_joined.replace(/ /g, '');
      v.phonemes_joined_no_bsm_ns = v.phonemes_joined_no_bsm
        ? v.phonemes_joined_no_bsm.replace(/ /g, '')
        : null;

      // Token IDs via encoder
      if (this.tokenEncoder) {
        v.phoneme_token_ids = this.tokenEncoder.encodeRawPhonemes(v.phonemes);
        v.phoneme_token_ids_no_bsm = v.phoneme_tokens_no_bsm
          ? this.tokenEncoder.encodeRawPhonemes(v.phoneme_tokens_no_bsm.join(' '))
          : null;
      } else {
        v.phoneme_token_ids = [];
        v.phoneme_token_ids_no_bsm = null;
      }

      v.word_token_ends = this._computeWordTokenEnds(v.phoneme_tokens);
    }
  }

  get totalVerses(): number {
    return this.verses.length;
  }

  get surahCount(): number {
    return this._bySurah.size;
  }

  getVerse(surah: number, ayah: number): QuranVerse | undefined {
    return this._byRef.get(`${surah}:${ayah}`);
  }

  getSurah(surah: number): QuranVerse[] {
    return this._bySurah.get(surah) ?? [];
  }

  getNextVerse(surah: number, ayah: number): QuranVerse | undefined {
    const verses = this._bySurah.get(surah) ?? [];
    for (let i = 0; i < verses.length; i++) {
      if (verses[i].ayah === ayah) {
        return i + 1 < verses.length
          ? verses[i + 1]
          : (this._bySurah.get(surah + 1) ?? [])[0];
      }
    }
    return undefined;
  }

  /** Get all verses with short phoneme sequences (for acoustic-only rescue). */
  getShortVerseCandidates(tokenLimit: number = 15): Candidate[] {
    const result: Candidate[] = [];
    for (const v of this.verses) {
      const ids = v.phoneme_token_ids_no_bsm ?? v.phoneme_token_ids ?? [];
      if (ids.length === 0 || ids.length > tokenLimit) continue;
      result.push({
        surah: v.surah,
        ayah: v.ayah,
        ayah_end: v.ayah,
        text: v.phonemes_joined,
        phonemes_joined: v.phonemes_joined,
        phoneme_token_ids: ids,
        stage_a_score: 0,
        raw_score: 0,
        bonus: 0,
        kind: 'single',
      });
    }
    return result;
  }

  /** Simple full-scan search by phoneme similarity. */
  search(query: string, limit: number = 5): (QuranVerse & { score: number })[] {
    const scored = this.verses.map((v) => ({
      ...v,
      score: levenshteinRatio(query, v.phonemes_joined),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Two-stage candidate retrieval.
   * Stage A: text similarity + continuation bonuses.
   * Returns singles (individual verses) and spans (multi-verse sequences).
   */
  retrieveCandidates(
    query: string,
    options: {
      maxSpan?: number;
      hint?: [number, number] | null;
      singleLimit?: number;
      topSurahs?: number;
      spanLimit?: number;
    } = {},
  ): CandidateSet {
    const {
      maxSpan = 4,
      hint = null,
      singleLimit = 32,
      topSurahs = 3,
      spanLimit = 32,
    } = options;

    if (!query.trim()) return { singles: [], spans: [], combined: [] };

    const bonuses = this._continuationBonuses(hint);
    const queryNoSpaces = query.replace(/ /g, '');

    // Score all verses
    const scored: [QuranVerse, number, number, number][] = [];
    for (const v of this.verses) {
      let score = levenshteinRatio(query, v.phonemes_joined);

      // Short query boost: compare no-space prefix
      if (queryNoSpaces.length <= 10) {
        score = Math.max(score, this._shortQueryBoost(queryNoSpaces, v));
      }

      // Also try without bismillah
      if (v.phonemes_joined_no_bsm) {
        score = Math.max(score, levenshteinRatio(query, v.phonemes_joined_no_bsm));
        if (queryNoSpaces.length <= 10) {
          score = Math.max(score, this._shortQueryBoost(queryNoSpaces, v, true));
        }
      }

      const bonus = bonuses.get(`${v.surah}:${v.ayah}`) ?? 0;

      // For continuation candidates, also try suffix-prefix overlap
      if (bonus > 0) {
        const overlapScore = suffixPrefixScore(query, v.phonemes_joined);
        score = Math.max(score, overlapScore);
      }

      scored.push([v, score, bonus, Math.min(score + bonus, 1)]);
    }

    scored.sort((a, b) => b[3] - a[3]);

    // Pick top surahs for span search
    const topSurahIds: number[] = [];
    for (let i = 0; i < scored.length && topSurahIds.length < topSurahs; i++) {
      const sid = scored[i][0].surah;
      if (!topSurahIds.includes(sid)) topSurahIds.push(sid);
    }

    // Fragment score refinement for longer queries
    if (queryNoSpaces.length >= 8) {
      let changed = false;
      for (let i = 0; i < scored.length; i++) {
        const [v, rawScore, bonus] = scored[i];

        // Skip if query is nearly as long as the full verse
        if (queryNoSpaces.length >= (v.phonemes_joined_ns?.length ?? 0) * 0.8) continue;

        let frag = fragmentScore(queryNoSpaces, v.phonemes_joined_ns ?? '');
        if (v.phonemes_joined_no_bsm_ns) {
          frag = Math.max(frag, fragmentScore(queryNoSpaces, v.phonemes_joined_no_bsm_ns));
        }

        if (frag > rawScore) {
          const blended = rawScore + (frag - rawScore) * 0.7;
          scored[i] = [v, blended, bonus, Math.min(blended + bonus, 1)];
          changed = true;
        }
      }
      if (changed) scored.sort((a, b) => b[3] - a[3]);
    }

    // Build single candidates
    const singles = scored
      .slice(0, singleLimit)
      .map(([v, rawScore, bonus, combined]) => this._candidateFromVerse(v, rawScore, bonus, combined));

    // Build span candidates from top surahs
    const spans: Candidate[] = [];
    for (let si = 0; si < topSurahIds.length; si++) {
      const surahId = topSurahIds[si];
      const surahVerses = this._bySurah.get(surahId) ?? [];

      for (let start = 0; start < surahVerses.length; start++) {
        for (let len = 2; len <= maxSpan && start + len <= surahVerses.length; len++) {
          const spanVerses = surahVerses.slice(start, start + len);
          const joinedPhonemes = this._joinedSpanPhonemes(spanVerses);
          const rawScore = levenshteinRatio(query, joinedPhonemes);
          const bonus = bonuses.get(`${spanVerses[0].surah}:${spanVerses[0].ayah}`) ?? 0;
          const combined = Math.min(rawScore + bonus, 1);
          spans.push(this._candidateFromSpan(spanVerses, rawScore, bonus, combined, si));
        }
      }
    }

    spans.sort((a, b) => b.stage_a_score - a.stage_a_score);

    return {
      singles,
      spans: spans.slice(0, spanLimit),
      combined: singles.concat(spans.slice(0, spanLimit)),
    };
  }

  /** Full match pipeline: retrieve + rank, return best match above threshold. */
  matchVerse(
    query: string,
    threshold: number = 0.3,
    maxSpan: number = 3,
    hint: [number, number] | null = null,
    runnersUpCount: number = 0,
  ): MatchResult | null {
    const candidates = this.retrieveCandidates(query, {
      maxSpan,
      hint,
      singleLimit: Math.max(runnersUpCount, 5),
      topSurahs: 20,
      spanLimit: 64,
    });

    const sorted = candidates.combined
      .slice()
      .sort((a, b) => b.stage_a_score - a.stage_a_score);

    const best = sorted[0];
    if (!best || best.stage_a_score < threshold) return null;

    const result: MatchResult = {
      surah: best.surah,
      ayah: best.ayah,
      ayah_end: best.ayah_end,
      text: best.text,
      phonemes_joined: best.phonemes_joined,
      score: best.stage_a_score,
      raw_score: best.raw_score,
      bonus: best.bonus,
    };

    if (runnersUpCount > 0) {
      result.runners_up = candidates.singles.slice(0, runnersUpCount).map((c) => ({
        surah: c.surah,
        ayah: c.ayah,
        raw_score: Math.round(c.raw_score * 1000) / 1000,
        bonus: Math.round(c.bonus * 1000) / 1000,
        score: Math.round(c.stage_a_score * 1000) / 1000,
        phonemes_joined: c.phonemes_joined.slice(0, 60),
      }));
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────

  /** Compute cumulative token end positions per word (for word-level tracking). */
  private _computeWordTokenEnds(tokens: string[]): number[] {
    const ends: number[] = [];
    let pos = 0;
    let isNewWord = true;

    for (const token of tokens) {
      pos++;
      if (token === '|') {
        isNewWord = true;
        continue;
      }
      if (isNewWord) {
        ends.push(pos);
      } else {
        ends[ends.length - 1] = pos;
      }
      isNewWord = false;
    }

    return ends;
  }

  private _candidateFromVerse(
    verse: QuranVerse,
    rawScore: number,
    bonus: number,
    combinedScore: number,
  ): Candidate {
    return {
      surah: verse.surah,
      ayah: verse.ayah,
      ayah_end: verse.ayah,
      text: verse.text_uthmani,
      phonemes_joined: verse.phonemes_joined,
      phoneme_token_ids: verse.phoneme_token_ids_no_bsm ?? verse.phoneme_token_ids ?? [],
      stage_a_score: combinedScore,
      raw_score: rawScore,
      bonus,
      kind: 'single',
    };
  }

  private _candidateFromSpan(
    verses: QuranVerse[],
    rawScore: number,
    bonus: number,
    combinedScore: number,
    surahRank: number,
  ): Candidate {
    const first = verses[0];
    const ids: number[] = [];

    // First verse may use no-bismillah variant
    const firstIds = first.phoneme_token_ids_no_bsm ?? first.phoneme_token_ids ?? [];
    ids.push(...firstIds);

    for (let i = 1; i < verses.length; i++) {
      ids.push(...(verses[i].phoneme_token_ids ?? []));
    }

    return {
      surah: first.surah,
      ayah: first.ayah,
      ayah_end: verses[verses.length - 1].ayah,
      text: verses.map((v) => v.text_uthmani).join(' '),
      phonemes_joined: this._joinedSpanPhonemes(verses),
      phoneme_token_ids: ids,
      stage_a_score: combinedScore,
      raw_score: rawScore,
      bonus,
      kind: 'span',
      surah_rank: surahRank,
    };
  }

  /** Join phonemes for a multi-verse span (first verse may strip bismillah). */
  private _joinedSpanPhonemes(verses: QuranVerse[]): string {
    const parts = [verses[0].phonemes_joined_no_bsm ?? verses[0].phonemes_joined];
    for (let i = 1; i < verses.length; i++) {
      parts.push(verses[i].phonemes_joined);
    }
    return parts.join(' ');
  }

  /**
   * Short query boost: compare no-space query against a truncated
   * prefix of the verse, and also against the first phoneme word.
   */
  private _shortQueryBoost(queryNoSpaces: string, verse: QuranVerse, noBsm: boolean = false): number {
    const target = noBsm
      ? (verse.phonemes_joined_no_bsm_ns ?? verse.phonemes_joined_ns ?? '')
      : (verse.phonemes_joined_ns ?? '');

    if (!target) return 0;

    const prefixLen = Math.min(target.length, queryNoSpaces.length + 6);
    const prefixScore = levenshteinRatio(queryNoSpaces, target.slice(0, prefixLen));

    const firstWord = noBsm
      ? ((verse.phonemes_joined_no_bsm ?? '').split(' ')[0] ?? '')
      : (verse.phoneme_words[0] ?? '');
    const wordScore = firstWord ? levenshteinRatio(queryNoSpaces, firstWord) : 0;

    return Math.max(prefixScore, wordScore);
  }

  /** Build continuation bonus map for verses following the hint. */
  private _continuationBonuses(hint: [number, number] | null): Map<string, number> {
    const bonuses = new Map<string, number>();
    if (!hint) return bonuses;

    const [surah, ayah] = hint;

    if (this._byRef.get(`${surah}:${ayah + 1}`)) {
      // Next verses in same surah
      bonuses.set(`${surah}:${ayah + 1}`, CONTINUATION_BONUSES[0]);
      if (this._byRef.has(`${surah}:${ayah + 2}`)) {
        bonuses.set(`${surah}:${ayah + 2}`, CONTINUATION_BONUSES[1]);
      }
      if (this._byRef.has(`${surah}:${ayah + 3}`)) {
        bonuses.set(`${surah}:${ayah + 3}`, CONTINUATION_BONUSES[2]);
      }
    } else {
      // End of surah: bonus goes to first verses of next surah
      const nextSurahVerses = this._bySurah.get(surah + 1) ?? [];
      for (let i = 0; i < Math.min(nextSurahVerses.length, 3); i++) {
        bonuses.set(
          `${nextSurahVerses[i].surah}:${nextSurahVerses[i].ayah}`,
          CONTINUATION_BONUSES[i],
        );
      }
    }

    return bonuses;
  }
}
