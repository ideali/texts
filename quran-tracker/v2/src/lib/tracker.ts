import type { QuranDB } from './quran-db';
import type {
  TranscribeFn,
  TranscribeResult,
  TrackerEvent,
  TrackerOptions,
  VerseRecord,
  Candidate,
  AcousticData,
  RankedCandidate,
  WordPrefix,
  PendingLeader,
  CommitEvidence,
  QuranVerse,
} from './types';
import {
  SAMPLE_RATE,
  DISCOVERY_TRIGGER,
  MAX_UTTERANCE,
  SILENCE_THRESHOLD,
  SILENCE_FLUSH,
  TRACKING_TRIGGER,
  TRACKING_TRIGGER_RELAXED,
  TRACKING_SILENCE_TIMEOUT,
  TRACKING_MAX_AUDIO,
  STALE_CYCLES,
  WORD_LOOKAHEAD,
  MIN_SCORE_AFTER_EMIT,
  MIN_SCORE_FIRST,
  MIN_MATCH_THRESHOLD,
  REPEAT_LEADER_COUNT,
  CANDIDATE_LIMIT,
  TOP_SURAHS,
  MAX_SPAN,
  ACOUSTIC_MARGIN_THRESHOLD,
  ACOUSTIC_MARGIN_CONTINUATION,
  STRONG_MATCH_THRESHOLD,
  WEAK_MATCH_THRESHOLD,
  ACOUSTIC_OVERRIDE_THRESHOLD,
  SHORT_RESCUE_LIMIT,
  ACOUSTIC_WORD_MARGIN,
  STRONG_CONFIDENCE_THRESHOLD,
  AUTO_ADVANCE_ACOUSTIC_DIFF,
  AUTO_ADVANCE_TAIL_TOKENS,
  SURROUNDING_RANGE,
  RESIDUAL_THRESHOLD,
  MAX_CONSECUTIVE_AUTO_ADVANCES,
} from './types';
import { levenshteinSimilarity } from './ctc-rescore';
import { scoreSequence, rescoreAll, pickLongestInMargin } from './ctc-rescore';
import { getCorrections } from './phoneme-aligner';
import { getAyahTimings, loadSurahTimings, estimateWordPosition } from './timing-cache';

// ── Helpers ──

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(a.length + b.length);
  result.set(a as Float32Array<ArrayBuffer>);
  result.set(b as Float32Array<ArrayBuffer>, a.length);
  return result;
}

function isSilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(sumSq / samples.length) < SILENCE_THRESHOLD;
}

function phonemeWordMatch(a: string, b: string, threshold = 0.7): boolean {
  if (a === b) return true;
  if (a.length <= 2 || b.length <= 2) return a === b;
  return levenshteinSimilarity(a, b) >= threshold;
}

/**
 * Align recognized phoneme words against verse words using levenshtein
 * similarity with lookahead. Returns matched positions and the new position.
 */
function alignPosition(
  recognized: string[],
  verseWords: string[],
  startIdx = 0,
): { position: number; matchedIndices: number[] } {
  if (!recognized.length || !verseWords.length) {
    return { position: 0, matchedIndices: [] };
  }

  const matched: number[] = [];
  let cursor = startIdx;

  for (const recWord of recognized) {
    if (cursor >= verseWords.length) break;
    const limit = Math.min(cursor + WORD_LOOKAHEAD, verseWords.length);
    for (let i = cursor; i < limit; i++) {
      if (phonemeWordMatch(recWord, verseWords[i])) {
        matched.push(i);
        cursor = i + 1;
        break;
      }
    }
  }

  return matched.length
    ? { position: matched[matched.length - 1] + 1, matchedIndices: matched }
    : { position: startIdx, matchedIndices: [] };
}

function getSurroundingVerses(
  db: QuranDB,
  surah: number,
  ayah: number,
): { surah: number; ayah: number; text: string; is_current: boolean }[] {
  const surahVerses = db.getSurah(surah);
  const result: { surah: number; ayah: number; text: string; is_current: boolean }[] = [];
  for (const v of surahVerses) {
    if (Math.abs(v.ayah - ayah) <= SURROUNDING_RANGE) {
      result.push({
        surah: v.surah,
        ayah: v.ayah,
        text: v.text_uthmani,
        is_current: v.ayah === ayah,
      });
    }
  }
  return result;
}

function refKey(surah: number, ayah: number, ayahEnd?: number): string {
  return ayahEnd && ayahEnd !== ayah
    ? `${surah}:${ayah}-${ayahEnd}`
    : `${surah}:${ayah}`;
}

// ── RecitationTracker ──

export class RecitationTracker {
  private db: QuranDB;
  private transcribe: TranscribeFn;
  private options: TrackerOptions;

  // Audio state
  utteranceAudio: Float32Array<ArrayBufferLike> = new Float32Array(0);
  newAudioCount = 0;
  silenceSamples = 0;
  utteranceHasSpeech = false;
  didFinalFlush = false;

  // Emit state
  lastEmittedRef: [number, number] | null = null;
  lastEmittedText = '';
  prevEmittedRef: [number, number] | null = null;
  prevEmittedText = '';
  pendingLeader: PendingLeader | null = null;
  lastCommitEvidence: CommitEvidence | null = null;

  // Tracking mode state (null = discovery mode)
  trackingVerse: VerseRecord | null = null;
  trackingVerseWords: string[] = [];
  trackingPrefixes: WordPrefix[] = [];
  trackingLastWordIdx = -1;
  trackingProgressEstablished = false;
  staleCycles = 0;
  cyclesSinceCommit = Infinity;
  lastTrackingResult: TranscribeResult | null = null;
  consecutiveAutoAdvances = 0;
  vadPauseHint = false;  // set by onVadPause(), consumed by _handleTracking()

  // Predictive cursor state
  trackingStartTime = 0;          // performance.now() when tracking started
  predictiveTempoRatio = 1.0;     // EMA of actual/reference speed
  predictiveLastWordIdx = -1;     // last word index emitted by prediction
  private _timings: import('./timing-cache').AyahTimings | null = null;

  constructor(db: QuranDB, transcribe: TranscribeFn, options: TrackerOptions = {}) {
    this.db = db;
    this.transcribe = transcribe;
    this.options = options;
  }

  // ── Main entry ──

  async feed(samples: Float32Array): Promise<TrackerEvent[]> {
    const events: TrackerEvent[] = [];

    this.utteranceAudio = concatFloat32(this.utteranceAudio, samples);

    const maxLen = this.trackingVerse !== null ? TRACKING_MAX_AUDIO : MAX_UTTERANCE;
    if (this.utteranceAudio.length > maxLen) {
      this.utteranceAudio = this.utteranceAudio.slice(-maxLen);
    }

    this.newAudioCount += samples.length;

    if (isSilent(samples)) {
      this.silenceSamples += samples.length;
    } else {
      this.silenceSamples = 0;
      this.utteranceHasSpeech = true;
      this.didFinalFlush = false;
    }

    const isFinalFlush =
      this.utteranceHasSpeech && !this.didFinalFlush && this.silenceSamples >= SILENCE_FLUSH;

    // Predictive cursor: emit word progress between ASR cycles
    // This runs every 300ms audio chunk, before the ASR gate check
    if (this.trackingVerse !== null && this._timings && !isSilent(samples)) {
      const predicted = this._predictWordPosition();
      if (predicted !== null) {
        events.push(predicted);
      }
    }

    if (this.trackingVerse !== null) {
      events.push(...(await this._handleTracking(isFinalFlush)));
    } else {
      events.push(...(await this._handleDiscovery(isFinalFlush)));
    }

    if (isFinalFlush) {
      this.didFinalFlush = true;
      this._emitDiagnostic({
        type: 'flush',
        mode: this.trackingVerse ? 'tracking' : 'discovery',
        duration_sec: this.utteranceAudio.length / SAMPLE_RATE,
      });
      if (this.trackingVerse === null) {
        this._resetUtterance();
      }
    }

    return events;
  }

  // ── Tracking mode ──

  async _handleTracking(isFinalFlush: boolean): Promise<TrackerEvent[]> {
    const events: TrackerEvent[] = [];
    if (!this.trackingVerse) return events;

    // Gate: VAD-forced cycles use TRACKING_TRIGGER (0.5s),
    // routine cycles use TRACKING_TRIGGER_RELAXED (1.5s) to save CPU.
    // onVadPause() sets newAudioCount >= TRACKING_TRIGGER for instant response.
    const triggerThreshold = this.vadPauseHint ? TRACKING_TRIGGER : TRACKING_TRIGGER_RELAXED;
    if (!isFinalFlush && this.newAudioCount < triggerThreshold) {
      if (this.silenceSamples >= TRACKING_SILENCE_TIMEOUT) {
        this._rollbackWeakCommit('tracking silence timeout');
        this._exitTracking('extended silence');
      }
      return events;
    }

    this.newAudioCount = 0;
    this.vadPauseHint = false;  // consumed
    const result = await this.transcribe(this.utteranceAudio.slice());
    this.lastTrackingResult = result;

    const text = result.text.trim();
    if (!text && !isFinalFlush) return events;

    const words = text.split(' ').filter(Boolean);
    const startFrom = Math.max(this.trackingLastWordIdx, 0);

    // Strategy 1: phoneme word alignment
    let { matchedIndices } = alignPosition(words, this.trackingVerseWords, startFrom);

    // Strategy 2: acoustic word CTC rescoring
    if (matchedIndices.length === 0) {
      const acousticIdx = this._resolveTrackingAcousticWord(result);
      if (acousticIdx > this.trackingLastWordIdx) {
        matchedIndices = [acousticIdx];
      }
    }

    // Strategy 3: character-level sliding window
    if (matchedIndices.length === 0 && text.length >= 5 && this.trackingVerseWords.length >= 10) {
      const charIdx = this._charLevelProgress(text);
      if (charIdx > this.trackingLastWordIdx) {
        matchedIndices = [charIdx];
      }
    }

    // No progress detected
    if (!(matchedIndices.length > 0 && matchedIndices[matchedIndices.length - 1] > this.trackingLastWordIdx)) {
      this.staleCycles++;
      if (this.staleCycles >= STALE_CYCLES || isFinalFlush) {
        this._emitDiagnostic({
          type: 'stale_exit',
          ref: `${this.trackingVerse.surah}:${this.trackingVerse.ayah}`,
          stale_cycles: this.staleCycles,
        });
        this._rollbackWeakCommit(isFinalFlush ? 'final silence flush' : 'stale tracking');
        this._exitTracking(isFinalFlush ? 'final silence flush' : 'stale tracking');
      }
      return events;
    }

    // Progress detected
    this.staleCycles = 0;
    this.trackingProgressEstablished = true;
    this.trackingLastWordIdx = matchedIndices[matchedIndices.length - 1];

    // Calibrate predictive cursor tempo from ASR-confirmed position
    this._calibrateTempo(this.trackingLastWordIdx);

    const wordsMatched = this.trackingLastWordIdx + 1;
    events.push({
      type: 'word_progress',
      surah: this.trackingVerse.surah,
      ayah: this.trackingVerse.ayah,
      word_index: wordsMatched,
      total_words: this.trackingVerseWords.length,
      matched_indices: matchedIndices,
    });

    // Corrections (tajweed feedback)
    const corrections = getCorrections(
      result.rawPhonemes,
      this.trackingVerse.phonemes,
      wordsMatched,
    );
    if (corrections.length > 0) {
      events.push({
        type: 'word_correction',
        surah: this.trackingVerse.surah,
        ayah: this.trackingVerse.ayah,
        corrections,
      });
    }

    // Verse completion check
    const progress = wordsMatched / this.trackingVerseWords.length;
    const nearEnd = this.trackingLastWordIdx >= this.trackingVerseWords.length - 2;

    if (progress >= 0.8 && nearEnd) {
      if (!this.lastCommitEvidence?.strong) {
        this._exitTracking('weak completion');
        return events;
      }

      const completedRef: [number, number] = [this.trackingVerse.surah, this.trackingVerse.ayah];
      const currentTokenIds = this.trackingVerse.phoneme_token_ids ?? [];
      this.lastEmittedRef = completedRef;
      this.lastEmittedText = this.trackingVerse.phonemes_joined;

      const nextVerse = this.db.getNextVerse(completedRef[0], completedRef[1]);

      this._exitTracking('verse complete');

      if (nextVerse) {
        let shouldAdvance = true;
        const acoustic = this.lastTrackingResult?.acoustic;
        const nextTokenIds = nextVerse.phoneme_token_ids ?? [];

        if (acoustic && currentTokenIds.length > 0 && nextTokenIds.length > 0) {
          const tailLen = AUTO_ADVANCE_TAIL_TOKENS;
          const tailCurrent = currentTokenIds.slice(
            -Math.min(tailLen, currentTokenIds.length),
          );
          const headNext = nextTokenIds.slice(0, Math.min(tailLen, nextTokenIds.length));
          const scoreCurrent = scoreSequence(acoustic, tailCurrent);
          const scoreNext = scoreSequence(acoustic, headNext);

          if (!Number.isFinite(scoreCurrent) || !Number.isFinite(scoreNext)) {
            shouldAdvance = false;
          } else {
            shouldAdvance = scoreNext - scoreCurrent < AUTO_ADVANCE_ACOUSTIC_DIFF;
          }
        }

        if (shouldAdvance) {
          events.push({
            type: 'verse_match',
            surah: nextVerse.surah,
            ayah: nextVerse.ayah,
            verse_text: nextVerse.text_uthmani,
            surah_name: nextVerse.surah_name,
            confidence: 0.99,
            surrounding_verses: getSurroundingVerses(this.db, nextVerse.surah, nextVerse.ayah),
          });

          this.prevEmittedRef = completedRef;
          this.prevEmittedText = this.lastEmittedText;
          this.lastEmittedRef = [nextVerse.surah, nextVerse.ayah];
          this.lastEmittedText = nextVerse.phonemes_joined;
          this.lastCommitEvidence = {
            confidence: 0.99,
            acousticMargin: 1,
            strong: true,
          };

          this._enterTracking(nextVerse);

          this.consecutiveAutoAdvances++;
          if (this.consecutiveAutoAdvances >= MAX_CONSECUTIVE_AUTO_ADVANCES) {
            this.lastCommitEvidence = {
              ...this.lastCommitEvidence,
              strong: false,
            };
          }
        }
      }

      this._retainTailAfterCommit();
    }

    return events;
  }

  // ── Discovery mode ──

  async _handleDiscovery(isFinalFlush: boolean): Promise<TrackerEvent[]> {
    const events: TrackerEvent[] = [];

    if (!this.utteranceHasSpeech) {
      this._emitDiagnostic({
        type: 'silence_skip',
        mode: 'discovery',
        reason: 'no speech detected',
      });
      return events;
    }

    if (!isFinalFlush && this.newAudioCount < DISCOVERY_TRIGGER) return events;

    this.newAudioCount = 0;
    this.cyclesSinceCommit++;

    const transcribeResult = await this.transcribe(this.utteranceAudio.slice());
    const text = transcribeResult.text.trim();

    // Short / empty transcript -- try short-verse rescue via acoustic scoring
    if (!text || text.length < 5) {
      if (
        transcribeResult.acoustic &&
        (transcribeResult.tokenIds?.length ?? 0) >= 2 &&
        this.cyclesSinceCommit > 1
      ) {
        const shortCandidates = this.db.getShortVerseCandidates();
        if (shortCandidates.length > 0) {
          const scored = rescoreAll(
            transcribeResult.acoustic,
            shortCandidates.map((c) => ({ ids: c.phoneme_token_ids, meta: c })),
          ).filter((s) => s.feasible);

          if (scored.length >= 2) {
            const margin = scored[1].acousticScore - scored[0].acousticScore;
            if (margin >= ACOUSTIC_MARGIN_THRESHOLD) {
              const best = scored[0].meta as Candidate;
              const verse = this.db.getVerse(best.surah, best.ayah);
              if (verse) {
                const verseRef: [number, number] = [best.surah, best.ayah];
                const key = refKey(best.surah, best.ayah);
                if (
                  !this.lastEmittedRef ||
                  this.lastEmittedRef[0] !== verseRef[0] ||
                  this.lastEmittedRef[1] !== verseRef[1]
                ) {
                  const conf = Math.min(0.85, 0.5 + margin);
                  events.push({
                    type: 'verse_match',
                    surah: best.surah,
                    ayah: best.ayah,
                    verse_text: verse.text_uthmani,
                    surah_name: verse.surah_name,
                    confidence: Math.round(conf * 100) / 100,
                    surrounding_verses: getSurroundingVerses(this.db, best.surah, best.ayah),
                  });

                  this.prevEmittedRef = this.lastEmittedRef;
                  this.prevEmittedText = this.lastEmittedText;
                  this.lastEmittedRef = verseRef;
                  this.lastEmittedText = verse.phonemes_joined;
                  this.lastCommitEvidence = {
                    confidence: conf,
                    acousticMargin: margin,
                    strong: margin >= 0.3,
                  };
                  this.pendingLeader = null;
                  this.cyclesSinceCommit = 0;
                  this.consecutiveAutoAdvances = 0;
                  this._emitDiagnostic({
                    type: 'commit',
                    ref: key,
                    reason: 'short_rescue',
                    confidence: conf,
                  });
                  this._enterTracking(verse);
                  return events;
                }
              }
            }
          }
        }
      }

      this._emitDiagnostic({
        type: 'silence_skip',
        mode: 'discovery',
        reason: 'transcript too short',
      });
      return events;
    }

    // Residual detection: skip if transcript is mostly old committed text
    if (this.lastEmittedText && this.lastCommitEvidence?.strong) {
      const residual = slidingWindowSimilarity(text, this.lastEmittedText);
      if (residual > RESIDUAL_THRESHOLD && !isFinalFlush) {
        this._emitDiagnostic({
          type: 'silence_skip',
          mode: 'discovery',
          reason: `residual=${residual.toFixed(3)}`,
        });
        return events;
      }
    }

    // Full discovery pipeline
    const matchResult = this.db.matchVerse(
      text,
      MIN_MATCH_THRESHOLD,
      MAX_SPAN,
      this.lastEmittedRef,
      5,
    );

    const weakMatch = !matchResult || matchResult.score < WEAK_MATCH_THRESHOLD;
    const singleLimit = weakMatch ? SHORT_RESCUE_LIMIT : CANDIDATE_LIMIT;

    const candidates = this.db.retrieveCandidates(text, {
      maxSpan: MAX_SPAN,
      hint: this.lastEmittedRef,
      singleLimit,
      topSurahs: weakMatch ? 10 : TOP_SURAHS,
      spanLimit: CANDIDATE_LIMIT,
    });

    const ranked = this._rankCandidates(candidates.combined, transcribeResult);

    this._emitDiagnostic({
      type: 'discovery_cycle',
      text,
      final_flush: isFinalFlush,
      candidates: ranked.slice(0, 8).map((r) => ({
        ref: refKey(r.candidate.surah, r.candidate.ayah, r.candidate.ayah_end),
        kind: r.candidate.kind,
        stageA: Math.round(r.candidate.stage_a_score * 1e3) / 1e3,
        acoustic: Math.round(r.acousticScore * 1e3) / 1e3,
      })),
    });

    let acousticMargin = 0;
    let lengthFit = 1;
    let bestMatch = matchResult;

    const feasible = ranked
      .filter((r) => r.feasible)
      .sort((a, b) => a.acousticScore - b.acousticScore);
    const topAcoustic = feasible[0] ?? null;

    if (topAcoustic && feasible.length >= 2) {
      topAcoustic.acousticMargin = feasible[1].acousticScore - topAcoustic.acousticScore;
    }

    if (matchResult) {
      const matchKey = refKey(matchResult.surah, matchResult.ayah, matchResult.ayah_end);
      const matchInRanked = ranked.find(
        (r) =>
          refKey(r.candidate.surah, r.candidate.ayah, r.candidate.ayah_end) === matchKey,
      );

      acousticMargin = matchInRanked?.acousticMargin ?? 0;
      lengthFit = matchInRanked?.lengthFit ?? 1;

      // Acoustic override: if a different candidate scores much better acoustically
      if (
        topAcoustic &&
        refKey(topAcoustic.candidate.surah, topAcoustic.candidate.ayah, topAcoustic.candidate.ayah_end) !== matchKey
      ) {
        const weakOverride =
          matchResult.score < WEAK_MATCH_THRESHOLD &&
          topAcoustic.acousticMargin! >= ACOUSTIC_OVERRIDE_THRESHOLD;
        const strongOverride =
          topAcoustic.acousticMargin! >= 0.5 &&
          topAcoustic.candidate.stage_a_score >= MIN_SCORE_AFTER_EMIT &&
          topAcoustic.lengthFit >= 0.5;

        if (weakOverride || strongOverride) {
          bestMatch = {
            surah: topAcoustic.candidate.surah,
            ayah: topAcoustic.candidate.ayah,
            ayah_end: topAcoustic.candidate.ayah_end,
            text: topAcoustic.candidate.text,
            phonemes_joined: topAcoustic.candidate.phonemes_joined,
            score: Math.max(
              matchResult.score,
              topAcoustic.candidate.stage_a_score,
              0.5,
            ),
            raw_score: topAcoustic.candidate.raw_score,
            bonus: topAcoustic.candidate.bonus,
          };
          acousticMargin = topAcoustic.acousticMargin!;
          lengthFit = topAcoustic.lengthFit;
        }
      }
    }

    const scoreThreshold = this.lastEmittedRef ? MIN_SCORE_AFTER_EMIT : MIN_SCORE_FIRST;

    if (bestMatch && bestMatch.score >= scoreThreshold) {
      const key = refKey(bestMatch.surah, bestMatch.ayah, bestMatch.ayah_end);

      // Pending leader tracking (repeated detection of same verse)
      this.pendingLeader =
        this.pendingLeader?.key === key
          ? { key, count: this.pendingLeader.count + 1 }
          : { key, count: 1 };

      const isCont = this._isContinuation(bestMatch.surah, bestMatch.ayah);
      const acousticPass =
        lengthFit >= 0.6 &&
        acousticMargin >= (isCont ? ACOUSTIC_MARGIN_CONTINUATION : ACOUSTIC_MARGIN_THRESHOLD);
      const repeatPass = (this.pendingLeader?.count ?? 0) >= REPEAT_LEADER_COUNT;

      // Anti-cascade: block fast non-continuation commits with weak evidence
      let blocked = false;
      if (
        !isCont &&
        this.lastEmittedRef &&
        this.cyclesSinceCommit <= 2 &&
        bestMatch.score < STRONG_MATCH_THRESHOLD &&
        !repeatPass
      ) {
        blocked = true;
      }

      const flushPass = isFinalFlush && bestMatch.score >= scoreThreshold;

      if (!blocked && (acousticPass || repeatPass || flushPass)) {
        const verseRef: [number, number] = [bestMatch.surah, bestMatch.ayah];

        // Skip if same as last emitted
        if (
          this.lastEmittedRef &&
          this.lastEmittedRef[0] === verseRef[0] &&
          this.lastEmittedRef[1] === verseRef[1]
        ) {
          return events;
        }

        const verse = this.db.getVerse(bestMatch.surah, bestMatch.ayah);
        const surrounding = getSurroundingVerses(this.db, bestMatch.surah, bestMatch.ayah);
        const confidence = Math.max(
          bestMatch.score,
          Math.min(0.99, 0.45 + acousticMargin + lengthFit * 0.2),
        );

        events.push({
          type: 'verse_match',
          surah: bestMatch.surah,
          ayah: bestMatch.ayah,
          verse_text: verse?.text_uthmani ?? bestMatch.text ?? '',
          surah_name: verse?.surah_name ?? '',
          confidence: Math.round(confidence * 100) / 100,
          surrounding_verses: surrounding,
        });

        // Emit multi-ayah spans
        const ayahEnd = bestMatch.ayah_end;
        if (ayahEnd && ayahEnd > bestMatch.ayah) {
          for (let q = bestMatch.ayah + 1; q <= ayahEnd; q++) {
            const spanVerse = this.db.getVerse(bestMatch.surah, q);
            if (spanVerse) {
              events.push({
                type: 'verse_match',
                surah: spanVerse.surah,
                ayah: spanVerse.ayah,
                verse_text: spanVerse.text_uthmani,
                surah_name: spanVerse.surah_name,
                confidence: Math.round(confidence * 100) / 100,
                surrounding_verses: getSurroundingVerses(this.db, spanVerse.surah, spanVerse.ayah),
              });
            }
          }
        }

        this.prevEmittedRef = this.lastEmittedRef;
        this.prevEmittedText = this.lastEmittedText;

        const finalRef: [number, number] = ayahEnd ? [bestMatch.surah, ayahEnd] : verseRef;
        this.lastEmittedRef = finalRef;

        const finalVerse = ayahEnd ? this.db.getVerse(bestMatch.surah, ayahEnd) : verse;
        this.lastEmittedText =
          finalVerse?.phonemes_joined ?? bestMatch.phonemes_joined ?? verse?.phonemes_joined ?? '';

        this.lastCommitEvidence = {
          confidence,
          acousticMargin,
          strong: confidence >= STRONG_CONFIDENCE_THRESHOLD && lengthFit >= 0.8 && acousticPass,
        };
        this.pendingLeader = null;
        this.cyclesSinceCommit = 0;
        this.consecutiveAutoAdvances = 0;

        this._emitDiagnostic({
          type: 'commit',
          ref: key,
          reason: acousticPass ? 'acoustic_margin' : 'repeat_leader',
          confidence: Math.round(confidence * 1e3) / 1e3,
        });

        const trackTarget = finalVerse ?? verse;
        if (trackTarget) {
          this._enterTracking(trackTarget);
        } else {
          this._retainTailAfterCommit();
        }
      } else {
        events.push({
          type: 'raw_transcript',
          text,
          confidence: Math.round(bestMatch.score * 100) / 100,
        });
      }
    } else {
      const score = bestMatch ? Math.round(bestMatch.score * 100) / 100 : 0;
      events.push({
        type: 'raw_transcript',
        text,
        confidence: score,
      });
    }

    return events;
  }

  // ── Acoustic word resolution (CTC rescoring of word prefixes) ──

  _resolveTrackingAcousticWord(result: TranscribeResult): number {
    if (!result.acoustic || !this.trackingPrefixes.length) return -1;

    const startFrom = Math.max(this.trackingLastWordIdx, 0);
    const candidates = this.trackingPrefixes.slice(startFrom);

    const scored = rescoreAll(
      result.acoustic,
      candidates.map((p) => ({
        ids: p.ids,
        meta: p,
        priorScore: p.wordIndex + 1,
      })),
    );

    return pickLongestInMargin(scored, ACOUSTIC_WORD_MARGIN)?.meta.wordIndex ?? -1;
  }

  // ── Acoustic ranking of candidates ──

  _rankCandidates(
    candidates: Candidate[],
    transcribeResult: TranscribeResult,
  ): RankedCandidate[] {
    if (!transcribeResult.acoustic || candidates.length === 0) {
      return candidates
        .map((c) => ({
          candidate: c,
          acousticScore: 0,
          acousticMargin: 0,
          feasible: false,
          lengthFit: 1,
        }))
        .sort((a, b) => b.candidate.stage_a_score - a.candidate.stage_a_score);
    }

    const tokenCount = Math.max(transcribeResult.tokenIds?.length ?? 0, 1);

    const scored = rescoreAll(
      transcribeResult.acoustic,
      candidates.map((c) => ({
        ids: c.phoneme_token_ids,
        meta: c,
        priorScore: c.stage_a_score,
      })),
    );

    const feasibleScores = scored.filter((s) => s.feasible).map((s) => s.acousticScore);
    const minScore = feasibleScores.length ? Math.min(...feasibleScores) : 0;
    const maxScore = feasibleScores.length ? Math.max(...feasibleScores) : 1;
    const range = Math.max(maxScore - minScore, 1e-6);

    const ranked: RankedCandidate[] = scored.map((s, i) => {
      const candidateTokenLen = Math.max(s.meta.phoneme_token_ids.length, 1);
      const fit = Math.min(candidateTokenLen, tokenCount) / Math.max(candidateTokenLen, tokenCount);

      // Normalized acoustic score (not stored but computed for potential use)
      if (s.feasible) {
        1 - (s.acousticScore - minScore) / range;
      }

      return {
        candidate: s.meta as Candidate,
        acousticScore: s.acousticScore,
        acousticMargin:
          (scored[i + 1]?.acousticScore ?? s.acousticScore) - s.acousticScore,
        feasible: s.feasible,
        lengthFit: fit,
      };
    });

    ranked.sort((a, b) =>
      b.candidate.stage_a_score !== a.candidate.stage_a_score
        ? b.candidate.stage_a_score - a.candidate.stage_a_score
        : a.acousticScore - b.acousticScore,
    );

    return ranked;
  }

  // ── Character-level sliding window fallback ──

  _charLevelProgress(text: string): number {
    if (!this.trackingVerse) return -1;

    const versePhonemes = this.trackingVerse.phonemes_joined;
    const words = this.trackingVerseWords;
    if (!versePhonemes || words.length === 0) return -1;

    const textNoSpaces = text.replace(/ /g, '');
    const verseNoSpaces = versePhonemes.replace(/ /g, '');
    const len = textNoSpaces.length;

    if (len < 3 || len >= verseNoSpaces.length) return -1;

    let bestSim = 0;
    let bestEnd = 0;
    const step = Math.max(1, Math.floor(len / 5));

    // Coarse pass
    for (let pos = 0; pos <= verseNoSpaces.length - len; pos += step) {
      const window = verseNoSpaces.slice(pos, pos + len);
      const sim = levenshteinSimilarity(textNoSpaces, window);
      if (sim > bestSim) {
        bestSim = sim;
        bestEnd = pos + len;
      }
    }

    // Fine pass around best position
    if (step > 1) {
      const searchStart = Math.max(0, bestEnd - len - step);
      const searchEnd = Math.min(verseNoSpaces.length - len, bestEnd - len + step);
      for (let pos = searchStart; pos <= searchEnd; pos++) {
        const window = verseNoSpaces.slice(pos, pos + len);
        const sim = levenshteinSimilarity(textNoSpaces, window);
        if (sim > bestSim) {
          bestSim = sim;
          bestEnd = pos + len;
        }
      }
    }

    if (bestSim < 0.55) return -1;

    // Map character position back to word index
    let charCount = 0;
    for (let w = 0; w < words.length; w++) {
      charCount += words[w].length;
      if (charCount >= bestEnd) return w;
    }
    return words.length - 1;
  }

  // ── State transitions ──

  _enterTracking(verse: VerseRecord): void {
    this.trackingVerse = verse;
    this.trackingVerseWords = verse.phoneme_words;
    this.trackingLastWordIdx = -1;
    this.trackingProgressEstablished = false;
    this.staleCycles = 0;

    const tokenIds = verse.phoneme_token_ids ?? [];
    const wordEnds = verse.word_token_ends ?? [];

    this.trackingPrefixes = wordEnds
      .map((end, idx) => ({
        wordIndex: idx,
        ids: tokenIds.slice(0, end),
      }))
      .filter((p) => p.ids.length > 0);

    // Start predictive cursor
    this.trackingStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.predictiveLastWordIdx = -1;
    this._timings = getAyahTimings(verse.surah, verse.ayah);

    // Pre-load surah timings in background (non-blocking)
    if (!this._timings) {
      loadSurahTimings(verse.surah).then(() => {
        // Update timings if still tracking same verse
        if (this.trackingVerse?.surah === verse.surah && this.trackingVerse?.ayah === verse.ayah) {
          this._timings = getAyahTimings(verse.surah, verse.ayah);
        }
      });
    }

    this._retainTailAfterCommit();
  }

  _exitTracking(reason: string): void {
    this.trackingVerse = null;
    this.trackingVerseWords = [];
    this.trackingPrefixes = [];
    this.trackingLastWordIdx = -1;
    this.trackingProgressEstablished = false;
    this.staleCycles = 0;
    this.lastTrackingResult = null;
  }

  _rollbackWeakCommit(reason: string): void {
    if (!this.lastCommitEvidence?.strong && !this.trackingProgressEstablished) {
      this.lastEmittedRef = this.prevEmittedRef;
      this.lastEmittedText = this.prevEmittedText;
      this.lastCommitEvidence = null;
      this._emitDiagnostic({
        type: 'rollback',
        reason,
        restored_ref: this.prevEmittedRef
          ? `${this.prevEmittedRef[0]}:${this.prevEmittedRef[1]}`
          : null,
      });
    }
  }

  _retainTailAfterCommit(): void {
    if (this.lastCommitEvidence?.strong) {
      const tailSize = Math.min(this.utteranceAudio.length, DISCOVERY_TRIGGER);
      this.utteranceAudio = this.utteranceAudio.slice(-tailSize);
    }
    this.newAudioCount = 0;
    this.silenceSamples = 0;
    this.utteranceHasSpeech = this.utteranceAudio.length > 0;
    this.didFinalFlush = false;
  }

  _resetUtterance(): void {
    this.utteranceAudio = new Float32Array(0);
    this.newAudioCount = 0;
    this.silenceSamples = 0;
    this.utteranceHasSpeech = false;
    this.didFinalFlush = false;
    this.pendingLeader = null;
  }

  _isContinuation(surah: number, ayah: number): boolean {
    if (!this.lastEmittedRef) return false;
    return (
      surah === this.lastEmittedRef[0] &&
      ayah >= this.lastEmittedRef[1] + 1 &&
      ayah <= this.lastEmittedRef[1] + 3
    );
  }

  _emitDiagnostic(data: Record<string, unknown>): void {
    this.options.onDiagnostic?.(data);
  }

  // ── Predictive cursor ──

  /**
   * Estimate current word position based on elapsed time and reference
   * timing data from Quran.com API. Emits word_progress events between
   * ASR cycles, giving near-zero latency word highlighting.
   *
   * Returns a word_progress event if the predicted position advanced,
   * or null if no prediction is available/needed.
   */
  _predictWordPosition(): TrackerEvent | null {
    if (!this.trackingVerse || !this._timings) return null;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsedMs = now - this.trackingStartTime;
    const predicted = estimateWordPosition(elapsedMs, this._timings, this.predictiveTempoRatio);

    // Only emit if prediction is ahead of ASR-confirmed position
    // and ahead of last prediction (monotonically increasing)
    if (predicted <= this.trackingLastWordIdx || predicted <= this.predictiveLastWordIdx) {
      return null;
    }

    this.predictiveLastWordIdx = predicted;

    return {
      type: 'word_progress',
      surah: this.trackingVerse.surah,
      ayah: this.trackingVerse.ayah,
      word_index: predicted + 1,
      total_words: this.trackingVerseWords.length,
      matched_indices: [predicted],
    };
  }

  /**
   * Calibrate tempo ratio when ASR confirms a word position.
   * Uses exponential moving average for smooth adaptation.
   */
  _calibrateTempo(asrWordIdx: number): void {
    if (!this._timings || asrWordIdx < 0) return;

    const word = this._timings.words.find(w => w.wordIndex === asrWordIdx);
    if (!word) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const actualMs = now - this.trackingStartTime;
    const referenceMs = word.startMs;

    if (referenceMs > 100 && actualMs > 100) {
      // tempo = reference / actual: >1 means imam reads faster than reference
      const instantTempo = referenceMs / actualMs;
      // EMA with alpha=0.3 for smooth adaptation
      this.predictiveTempoRatio = 0.7 * this.predictiveTempoRatio + 0.3 * instantTempo;
    }
  }

  // ── VAD hints from AudioWorklet (instant, ~50ms latency) ──

  /**
   * Called when AudioWorklet detects a pause (~200ms of silence).
   * In tracking mode, this triggers an immediate ASR cycle instead of
   * waiting for the next 500ms tracking trigger. This cuts perceived
   * latency for ayah transitions from ~500-1600ms to ~200-300ms.
   */
  onVadPause(durationMs: number): void {
    if (this.trackingVerse !== null && durationMs >= 200) {
      // Force immediate transcription on next feed() by pretending
      // we have enough new audio and setting the hint flag
      this.vadPauseHint = true;
      this.newAudioCount = Math.max(this.newAudioCount, TRACKING_TRIGGER);
      this._emitDiagnostic({
        type: 'vad_pause',
        durationMs,
        mode: 'tracking',
        forced_trigger: true,
      });
    }

    // Update silence counter with VAD's more accurate measurement
    // VAD runs at ~2.67ms resolution vs 300ms audio chunk resolution
    const vadSilenceSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
    this.silenceSamples = Math.max(this.silenceSamples, vadSilenceSamples);
  }

  /**
   * Called when AudioWorklet detects speech onset.
   * Resets silence counter immediately rather than waiting for
   * the next audio chunk to arrive.
   */
  onVadSpeech(): void {
    this.silenceSamples = 0;
    this.utteranceHasSpeech = true;
    this.didFinalFlush = false;
  }
}

// ── Sliding window similarity (used for residual detection) ──

function slidingWindowSimilarity(shorter: string, longer: string): number {
  if (!shorter || !longer) return 0;
  if (shorter.length > longer.length) [shorter, longer] = [longer, shorter];
  const len = shorter.length;
  let best = 0;
  for (let i = 0; i <= Math.max(0, longer.length - len); i++) {
    const sim = levenshteinSimilarity(shorter, longer.slice(i, i + len));
    if (sim > best) {
      best = sim;
      if (best === 1) break;
    }
  }
  return best;
}
