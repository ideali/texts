/**
 * CTC greedy decoder for phoneme recognition output.
 *
 * Takes raw logprobs from the FastConformer model and produces
 * a phoneme string, splitting words at the "|" token.
 */
export class CTCDecoder {
  private vocab: Map<number, string>;
  private tokenToId: Map<string, number>;
  private blankId: number;

  constructor(vocabJson: Record<string, string>) {
    this.vocab = new Map();
    this.tokenToId = new Map();
    this.blankId = -1;

    for (const [idStr, token] of Object.entries(vocabJson)) {
      const id = parseInt(idStr);
      this.vocab.set(id, token);
      this.tokenToId.set(token, id);
      if (token === '<blank>') {
        this.blankId = id;
      }
    }

    // Fallback: if no explicit <blank> token, use the highest id
    if (this.blankId === -1) {
      let maxId = 0;
      for (const id of this.vocab.keys()) {
        if (id > maxId) maxId = id;
      }
      this.blankId = maxId;
    }
  }

  /**
   * Greedy CTC decode: argmax per timestep, collapse consecutive
   * duplicates, remove blanks, join tokens, split words at "|".
   */
  decode(
    logprobs: Float32Array,
    timeSteps: number,
    vocabSize: number,
  ): { text: string; rawPhonemes: string; tokenIds: number[] } {
    // Step 1: argmax per timestep
    const bestIds: number[] = [];
    for (let t = 0; t < timeSteps; t++) {
      let bestId = 0;
      let bestScore = logprobs[t * vocabSize];
      for (let v = 1; v < vocabSize; v++) {
        const score = logprobs[t * vocabSize + v];
        if (score > bestScore) {
          bestScore = score;
          bestId = v;
        }
      }
      bestIds.push(bestId);
    }

    // Step 2: collapse consecutive duplicates, remove blanks
    const decodedTokens: string[] = [];
    let prevId = -1;
    for (const id of bestIds) {
      if (id !== prevId && id !== this.blankId) {
        const token = this.vocab.get(id) ?? '';
        decodedTokens.push(token);
      }
      prevId = id;
    }

    // Step 3: raw phoneme string (space-separated tokens)
    const rawPhonemes = decodedTokens.join(' ');

    // Step 4: split into words at "|" separator
    const words: string[] = [];
    let currentWord: string[] = [];
    for (const token of decodedTokens) {
      if (token === '|') {
        if (currentWord.length > 0) {
          words.push(currentWord.join(''));
        }
        currentWord = [];
      } else {
        currentWord.push(token);
      }
    }
    if (currentWord.length > 0) {
      words.push(currentWord.join(''));
    }

    // Token IDs (excluding blanks and unknowns)
    const tokenIds = decodedTokens
      .map((t) => this.tokenToId.get(t) ?? -1)
      .filter((id) => id >= 0);

    return { text: words.join(' '), rawPhonemes, tokenIds };
  }

  getBlankId(): number {
    return this.blankId;
  }

  /** Encode a space-separated phoneme string into token IDs. */
  encodeRawPhonemes(phonemes: string): number[] {
    const ids: number[] = [];
    for (const token of phonemes.trim().split(/\s+/)) {
      if (!token) continue;
      const id = this.tokenToId.get(token);
      if (id !== undefined && id !== this.blankId) {
        ids.push(id);
      }
    }
    return ids;
  }
}
