import type { AcousticData, ScoredCandidate } from './types';

const NEG_INF = Number.NEGATIVE_INFINITY;
const MAX_SCORE = 1e9;

/** Numerically stable log(exp(a) + exp(b)). */
export function logAddExp(a: number, b: number): number {
  if (a === NEG_INF) return b;
  if (b === NEG_INF) return a;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi + Math.log1p(Math.exp(lo - hi));
}

/**
 * Minimum number of frames needed to produce a CTC label sequence.
 * Each token needs at least 1 frame; consecutive identical tokens
 * need an extra blank frame between them.
 */
export function minFramesForLabel(label: number[]): number {
  if (label.length === 0) return 1;
  let extraBlanks = 0;
  for (let i = 1; i < label.length; i++) {
    if (label[i] === label[i - 1]) extraBlanks++;
  }
  return label.length + extraBlanks;
}

/**
 * CTC forward algorithm. Returns negative log-probability per token,
 * i.e. lower = better acoustic match.
 *
 * Uses the standard CTC topology: interleave blanks between labels,
 * allow skip-transitions for non-identical adjacent labels.
 */
export function ctcForwardScore(acoustic: AcousticData, labelIds: number[]): number {
  const { logprobs, timeSteps, vocabSize, blankId } = acoustic;
  const labelLen = labelIds.length;

  if (labelLen === 0 || minFramesForLabel(labelIds) > timeSteps) {
    return MAX_SCORE;
  }

  // Extended label: interleave blanks: [blank, l0, blank, l1, blank, ...]
  const extLen = labelLen * 2 + 1;
  const extLabel = new Int32Array(extLen);
  for (let i = 0; i < extLen; i++) {
    extLabel[i] = i % 2 === 0 ? blankId : labelIds[(i - 1) >> 1];
  }

  let alpha = new Float64Array(extLen);
  let alphaPrev = new Float64Array(extLen);

  alpha.fill(NEG_INF);
  alphaPrev.fill(NEG_INF);

  // Initialize: only blank and first label can start
  alpha[0] = logprobs[blankId];
  if (extLen > 1) {
    alpha[1] = logprobs[extLabel[1]];
  }

  for (let t = 1; t < timeSteps; t++) {
    alphaPrev.fill(NEG_INF);
    const offset = t * vocabSize;

    for (let s = 0; s < extLen; s++) {
      let score = alpha[s];

      // Transition from previous state
      if (s > 0) {
        score = logAddExp(score, alpha[s - 1]);
      }

      // Skip transition (non-blank, different from s-2)
      if (s > 1 && extLabel[s] !== blankId && extLabel[s] !== extLabel[s - 2]) {
        score = logAddExp(score, alpha[s - 2]);
      }

      if (score !== NEG_INF) {
        alphaPrev[s] = score + logprobs[offset + extLabel[s]];
      }
    }

    // Swap buffers
    const tmp = alpha;
    alpha = alphaPrev;
    alphaPrev = tmp;
  }

  // Final probability: sum of last two states (last blank + last label)
  let finalScore = alpha[extLen - 1];
  if (extLen > 1) {
    finalScore = logAddExp(finalScore, alpha[extLen - 2]);
  }

  return Number.isFinite(finalScore) ? -finalScore / labelLen : MAX_SCORE;
}

/**
 * Score a list of candidates against acoustic data.
 * Returns candidates sorted by acoustic score (ascending = best first).
 */
export function scoreCandidates<T extends { ids: number[]; meta: unknown; priorScore?: number }>(
  acoustic: AcousticData,
  candidates: T[],
): (T & { acousticScore: number; feasible: boolean; minFramesRequired: number })[] {
  return candidates
    .map((c) => {
      const minFrames = minFramesForLabel(c.ids);
      const score = ctcForwardScore(acoustic, c.ids);
      return {
        ...c,
        acousticScore: score,
        feasible: Number.isFinite(score) && score < MAX_SCORE,
        minFramesRequired: minFrames,
      };
    })
    .sort((a, b) =>
      a.acousticScore !== b.acousticScore
        ? a.acousticScore - b.acousticScore
        : (b.priorScore ?? 0) - (a.priorScore ?? 0),
    );
}

/**
 * Among feasible candidates within `margin` of the best score,
 * pick the one with the longest token sequence (most specific match).
 */
export function chooseLongestStablePrefix<
  T extends { ids: number[]; acousticScore: number; feasible: boolean },
>(scored: T[], margin: number = 0.12): T | null {
  if (!scored.length) return null;

  const feasible = scored.filter((c) => c.feasible);
  if (!feasible.length) return null;

  const bestScore = feasible[0].acousticScore;
  let longest = feasible[0];

  for (const c of feasible) {
    if (c.acousticScore > bestScore + margin) break;
    if (c.ids.length >= longest.ids.length) {
      longest = c;
    }
  }

  return longest;
}

// ── Aliases used by RecitationTracker ──────────────────────────────

/** Alias: scoreSequence = ctcForwardScore */
export const scoreSequence = ctcForwardScore;

/** Alias: rescoreAll = scoreCandidates */
export const rescoreAll = scoreCandidates;

/** Alias: pickLongestInMargin = chooseLongestStablePrefix */
export const pickLongestInMargin = chooseLongestStablePrefix;

// ── Levenshtein utilities (used by tracker for phoneme word matching) ──

/** Levenshtein distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
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

/** Normalized Levenshtein similarity in [0,1]. */
export function levenshteinSimilarity(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (total - levenshteinDistance(a, b)) / total;
}

// ── Beam search with trie (used by worker for constrained decoding) ──

import type { CompactTrie } from './phoneme-trie';

interface BeamState {
  tokenIds: number[];
  blankScore: number;
  nonBlankScore: number;
  trieNodeIdx: number;
  matchedVerses: { verseIndex: number; spanLength: number }[];
}

function beamTotalScore(b: BeamState): number {
  return logAddExp(b.blankScore, b.nonBlankScore);
}

/**
 * Trie-constrained CTC beam search.
 * Returns beams sorted by score (descending), each with matched verse indices.
 */
export function beamSearchWithTrie(
  logprobs: Float32Array,
  timeSteps: number,
  vocabSize: number,
  blankId: number,
  trie: CompactTrie,
  beamWidth: number = 8,
): { tokenIds: number[]; score: number; matchedVerses: { verseIndex: number; spanLength: number }[]; isComplete: boolean }[] {
  let beams = new Map<string, BeamState>();
  beams.set('', {
    tokenIds: [],
    blankScore: 0,
    nonBlankScore: NEG_INF,
    trieNodeIdx: 0,
    matchedVerses: [],
  });

  for (let t = 0; t < timeSteps; t++) {
    const offset = t * vocabSize;
    const nextBeams = new Map<string, BeamState>();

    for (const beam of beams.values()) {
      const total = beamTotalScore(beam);
      if (total === NEG_INF) continue;

      // Blank extension
      const blankLogprob = logprobs[offset + blankId];
      const beamKey = beam.tokenIds.join(',');
      const blankScore = total + blankLogprob;
      const existing = nextBeams.get(beamKey);
      if (existing) {
        existing.blankScore = logAddExp(existing.blankScore, blankScore);
      } else {
        nextBeams.set(beamKey, {
          tokenIds: beam.tokenIds,
          blankScore,
          nonBlankScore: NEG_INF,
          trieNodeIdx: beam.trieNodeIdx,
          matchedVerses: beam.matchedVerses,
        });
      }

      // Token extensions (following trie edges)
      const nodeIdx = beam.trieNodeIdx;
      const edgeStart = trie.edgeStart[nodeIdx];
      const edgeCount = trie.edgeCount[nodeIdx];

      for (let e = 0; e < edgeCount; e++) {
        const tokenId = trie.edgeToken[edgeStart + e];
        const childIdx = trie.edgeChild[edgeStart + e];
        const tokenLogprob = logprobs[offset + tokenId];
        const lastToken = beam.tokenIds.length > 0 ? beam.tokenIds[beam.tokenIds.length - 1] : -1;

        let nonBlankScore: number;
        if (tokenId === lastToken) {
          nonBlankScore = beam.blankScore + tokenLogprob;
        } else {
          nonBlankScore = total + tokenLogprob;
        }

        const newKey = beamKey.length > 0 ? beamKey + ',' + tokenId : '' + tokenId;
        const verseEnds = trie.verseEnds[childIdx];
        const existingNext = nextBeams.get(newKey);

        if (existingNext) {
          existingNext.nonBlankScore = logAddExp(existingNext.nonBlankScore, nonBlankScore);
          if (verseEnds.length > 0 && existingNext.matchedVerses.length === 0) {
            existingNext.matchedVerses = [...beam.matchedVerses, ...verseEnds];
          }
        } else {
          const matched = verseEnds.length > 0
            ? [...beam.matchedVerses, ...verseEnds]
            : beam.matchedVerses;
          nextBeams.set(newKey, {
            tokenIds: [...beam.tokenIds, tokenId],
            blankScore: NEG_INF,
            nonBlankScore,
            trieNodeIdx: childIdx,
            matchedVerses: matched,
          });
        }
      }
    }

    // Prune to beam width
    if (nextBeams.size > beamWidth) {
      const sorted = [...nextBeams.entries()].sort(
        ([, a], [, b]) => beamTotalScore(b) - beamTotalScore(a),
      );
      beams = new Map(sorted.slice(0, beamWidth));
    } else {
      beams = nextBeams;
    }
  }

  return [...beams.values()]
    .map((b) => ({
      tokenIds: b.tokenIds,
      score: beamTotalScore(b),
      matchedVerses: b.matchedVerses,
      isComplete: trie.verseEnds[b.trieNodeIdx].length > 0,
    }))
    .sort((a, b) => b.score - a.score);
}
