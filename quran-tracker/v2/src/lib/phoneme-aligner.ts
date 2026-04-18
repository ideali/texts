export interface AlignmentError {
  type: 'substitution' | 'deletion' | 'insertion';
  position: number;
  expected: string | null;
  got: string | null;
}

export interface AlignmentResult {
  errors: AlignmentError[];
  /** Phoneme Error Rate: errors / reference length */
  per: number;
  /** Fraction of reference phonemes matched correctly */
  correctRate: number;
  /** Aligned pairs: [reference, predicted], null = gap */
  alignment: [string | null, string | null][];
}

export interface WordCorrection {
  word_index: number;
  expected: string;
  got: string;
  error_type: 'substitution' | 'deletion' | 'insertion';
}

/**
 * Full Levenshtein DP alignment with backtrace.
 * Returns edit operations, PER, correctRate, and the aligned pairs.
 */
export function alignPhonemes(
  predicted: string[],
  reference: string[],
): AlignmentResult {
  const refLen = reference.length;
  const predLen = predicted.length;

  if (refLen === 0 && predLen === 0) {
    return { errors: [], per: 0, correctRate: 1, alignment: [] };
  }
  if (refLen === 0) {
    return {
      errors: predicted.map((p) => ({ type: 'insertion' as const, position: 0, expected: null, got: p })),
      per: predLen,
      correctRate: 0,
      alignment: predicted.map((p) => [null, p] as [null, string]),
    };
  }
  if (predLen === 0) {
    return {
      errors: reference.map((r, i) => ({ type: 'deletion' as const, position: i, expected: r, got: null })),
      per: 1,
      correctRate: 0,
      alignment: reference.map((r) => [r, null] as [string, null]),
    };
  }

  // DP cost and backtrace matrices
  const cost: number[][] = [];
  const ops: string[][] = [];
  for (let i = 0; i <= refLen; i++) {
    cost.push(new Array(predLen + 1).fill(0));
    ops.push(new Array(predLen + 1).fill(''));
  }
  for (let i = 1; i <= refLen; i++) { cost[i][0] = i; ops[i][0] = 'D'; }
  for (let j = 1; j <= predLen; j++) { cost[0][j] = j; ops[0][j] = 'I'; }

  for (let i = 1; i <= refLen; i++) {
    for (let j = 1; j <= predLen; j++) {
      const subCost = reference[i - 1] === predicted[j - 1] ? 0 : 1;
      const sub = cost[i - 1][j - 1] + subCost;
      const ins = cost[i][j - 1] + 1;
      const del = cost[i - 1][j] + 1;
      const best = Math.min(sub, ins, del);

      cost[i][j] = best;
      if (best === sub) ops[i][j] = 'S';
      else if (best === del) ops[i][j] = 'D';
      else ops[i][j] = 'I';
    }
  }

  // Backtrace to build alignment
  const alignmentReversed: [string | null, string | null][] = [];
  let i = refLen;
  let j = predLen;

  while (i > 0 || j > 0) {
    if (i === 0) {
      alignmentReversed.push([null, predicted[j - 1]]);
      j--;
    } else if (j === 0) {
      alignmentReversed.push([reference[i - 1], null]);
      i--;
    } else {
      const op = ops[i][j];
      if (op === 'S') {
        alignmentReversed.push([reference[i - 1], predicted[j - 1]]);
        i--; j--;
      } else if (op === 'D') {
        alignmentReversed.push([reference[i - 1], null]);
        i--;
      } else {
        alignmentReversed.push([null, predicted[j - 1]]);
        j--;
      }
    }
  }

  const alignment = alignmentReversed.reverse();

  // Extract errors from alignment
  const errors: AlignmentError[] = [];
  let correct = 0;
  let refPos = 0;

  for (const [ref, pred] of alignment) {
    if (ref !== null && pred !== null) {
      if (ref === pred) {
        correct++;
      } else {
        errors.push({ type: 'substitution', position: refPos, expected: ref, got: pred });
      }
      refPos++;
    } else if (ref !== null) {
      errors.push({ type: 'deletion', position: refPos, expected: ref, got: null });
      refPos++;
    } else {
      errors.push({ type: 'insertion', position: refPos, expected: null, got: pred });
    }
  }

  return {
    errors,
    per: errors.length / refLen,
    correctRate: correct / refLen,
    alignment,
  };
}

/**
 * Map phoneme-level errors to word-level corrections.
 *
 * Strips "|" separators from both sequences, runs alignment on the
 * phoneme-only tokens, then maps each error back to the word index
 * it belongs to (based on "|" positions in the reference).
 */
export function mapCorrectionsToWords(
  rawPredicted: string,
  rawReference: string,
  maxWordIdx?: number,
): WordCorrection[] {
  const predTokens = rawPredicted.trim().split(/\s+/).filter(Boolean);
  const refTokens = rawReference.trim().split(/\s+/).filter(Boolean);

  if (!predTokens.length || !refTokens.length) return [];

  // Strip "|" and track which word each reference phoneme belongs to
  const predPhonemes = predTokens.filter((t) => t !== '|');
  const refPhonemes = refTokens.filter((t) => t !== '|');

  // Build ref-phoneme-index -> word-index mapping from "|" positions
  const phonemeToWord: number[] = [];
  let wordIdx = 0;
  for (const token of refTokens) {
    if (token === '|') {
      wordIdx++;
    } else {
      phonemeToWord.push(wordIdx);
    }
  }

  const result = alignPhonemes(predPhonemes, refPhonemes);
  if (result.errors.length === 0) return [];

  // Group errors by word index
  const byWord = new Map<number, { expected: string[]; got: string[]; type: string }>();

  for (const err of result.errors) {
    const wIdx = err.position < phonemeToWord.length
      ? phonemeToWord[err.position]
      : phonemeToWord[phonemeToWord.length - 1];

    if (maxWordIdx !== undefined && wIdx >= maxWordIdx) continue;

    if (!byWord.has(wIdx)) {
      byWord.set(wIdx, { expected: [], got: [], type: err.type });
    }
    const entry = byWord.get(wIdx)!;
    if (err.expected) entry.expected.push(err.expected);
    if (err.got) entry.got.push(err.got);
    if (err.type === 'substitution') entry.type = 'substitution';
  }

  const corrections: WordCorrection[] = [];
  for (const [wIdx, data] of byWord) {
    corrections.push({
      word_index: wIdx,
      expected: data.expected.join(''),
      got: data.got.join(''),
      error_type: data.type as WordCorrection['error_type'],
    });
  }

  return corrections;
}

/** Alias used by RecitationTracker. */
export const getCorrections = mapCorrectionsToWords;
