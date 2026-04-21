// ── Worker-to-Main messages ──────────────────────────────────────────

export interface VerseMatchMessage {
  type: 'verse_match';
  surah: number;
  ayah: number;
  verse_text: string;
  surah_name: string;
  confidence: number;
  surrounding_verses: SurroundingVerse[];
}

export interface WordProgressMessage {
  type: 'word_progress';
  surah: number;
  ayah: number;
  word_index: number;
  total_words: number;
  matched_indices: number[];
}

export interface WordCorrectionMessage {
  type: 'word_correction';
  surah: number;
  ayah: number;
  corrections: WordCorrection[];
}

export interface RawTranscriptMessage {
  type: 'raw_transcript';
  text: string;
  confidence: number;
}

export interface LoadingMessage {
  type: 'loading';
  percent: number;
}

export interface LoadingStatusMessage {
  type: 'loading_status';
  message: string;
}

export interface ReadyMessage {
  type: 'ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerOutMessage =
  | VerseMatchMessage
  | WordProgressMessage
  | WordCorrectionMessage
  | RawTranscriptMessage
  | LoadingMessage
  | LoadingStatusMessage
  | ReadyMessage
  | ErrorMessage;

// ── Main-to-Worker messages ─────────────────────────────────────────

export interface InitMessage {
  type: 'init';
  baseUrl?: string;
}

export interface AudioMessage {
  type: 'audio';
  samples: Float32Array;
}

export interface ResetMessage {
  type: 'reset';
}

export type WorkerInMessage = InitMessage | AudioMessage | ResetMessage;

// ── Data interfaces ─────────────────────────────────────────────────

export interface SurroundingVerse {
  surah: number;
  ayah: number;
  text: string;
  is_current: boolean;
}

export interface WordCorrection {
  word_index: number;
  expected: string;
  got: string;
  error_type: 'substitution' | 'deletion' | 'insertion';
}

export interface QuranVerse {
  surah: number;
  ayah: number;
  text_uthmani: string;
  surah_name: string;
  surah_name_en: string;
  phonemes: string;
  phonemes_joined: string;
  phoneme_words: string[];

  // Computed at runtime by QuranDB
  phoneme_tokens: string[];
  phoneme_token_ids: number[];
  phoneme_token_ids_no_bsm: number[] | null;
  phonemes_joined_no_bsm: string | null;
  phoneme_tokens_no_bsm: string[] | null;
  phonemes_joined_ns: string;          // no-spaces version
  phonemes_joined_no_bsm_ns: string | null;
  word_token_ends: number[];
}

export interface Candidate {
  surah: number;
  ayah: number;
  ayah_end: number;
  text: string;
  phonemes_joined: string;
  phoneme_token_ids: number[];
  stage_a_score: number;
  raw_score: number;
  bonus: number;
  kind: 'single' | 'span';
  surah_rank?: number;
}

export interface AcousticData {
  logprobs: Float32Array;
  timeSteps: number;
  vocabSize: number;
  blankId: number;
}

export interface TranscribeResult {
  text: string;
  rawPhonemes: string;
  tokenIds: number[];
  acoustic: AcousticData;
  beamMatches?: BeamMatch[];
}

export interface BeamMatch {
  verseIndex: number;
  spanLength: number;
  score: number;
}

export interface ScoredCandidate {
  ids: number[];
  meta: Candidate;
  priorScore?: number;
  acousticScore: number;
  feasible: boolean;
  minFramesRequired: number;
}

export interface RankedCandidate {
  candidate: Candidate;
  acousticScore: number;
  acousticMargin: number;
  feasible: boolean;
  lengthFit: number;
}

export interface MatchResult {
  surah: number;
  ayah: number;
  ayah_end?: number;
  text: string;
  phonemes_joined: string;
  score: number;
  raw_score: number;
  bonus: number;
  runners_up?: RunnerUp[];
}

export interface RunnerUp {
  surah: number;
  ayah: number;
  raw_score: number;
  bonus: number;
  score: number;
  phonemes_joined: string;
}

export interface CandidateSet {
  singles: Candidate[];
  spans: Candidate[];
  combined: Candidate[];
}

// ── Tracker sub-types ──────────────────────────────────────────────

/** VerseRecord = QuranVerse used inside tracker (same shape). */
export type VerseRecord = QuranVerse;

/** Type signature for the transcribe function passed to RecitationTracker. */
export type TranscribeFn = (audio: Float32Array) => Promise<TranscribeResult>;

/** Union of all events emitted by RecitationTracker.feed(). */
export type TrackerEvent =
  | VerseMatchMessage
  | WordProgressMessage
  | WordCorrectionMessage
  | RawTranscriptMessage;

/** Options for RecitationTracker constructor. */
export interface TrackerOptions {
  onDiagnostic?: (data: Record<string, unknown>) => void;
}

export interface PendingLeader {
  key: string;
  count: number;
}

export interface CommitEvidence {
  confidence: number;
  acousticMargin: number;
  strong: boolean;
}

export interface WordPrefix {
  wordIndex: number;
  ids: number[];
}

/** Compact phoneme trie type (re-exported from phoneme-trie). */
export type { CompactTrie as PhonemeTrieCompact } from './phoneme-trie';

// ── Constants ───────────────────────────────────────────────────────

export const SAMPLE_RATE = 16000;

// Discovery mode
export const DISCOVERY_TRIGGER = SAMPLE_RATE * 2;                  // 32000
export const MAX_UTTERANCE = SAMPLE_RATE * 30;                     // 480000
export const SILENCE_THRESHOLD = 0.005;
export const SILENCE_FLUSH = SAMPLE_RATE * 1.2;                    // 19200

// Matching thresholds
export const MIN_SCORE_AFTER_EMIT = 0.45;
export const MIN_SCORE_FIRST = 0.75;
export const MIN_MATCH_THRESHOLD = 0.25;
export const REPEAT_LEADER_COUNT = 2;
export const SURROUNDING_RANGE = 2;

// Candidate retrieval
export const CANDIDATE_LIMIT = 64;
export const TOP_SURAHS = 5;
export const MAX_SPAN = 4;

// Acoustic scoring
export const ACOUSTIC_MARGIN_THRESHOLD = 0.12;
export const ACOUSTIC_MARGIN_CONTINUATION = 0.08;
export const STRONG_MATCH_THRESHOLD = 0.65;
export const WEAK_MATCH_THRESHOLD = 0.55;
export const ACOUSTIC_OVERRIDE_THRESHOLD = 0.25;

// Wide search
export const SHORT_RESCUE_LIMIT = 200;

// Tracking mode
export const TRACKING_TRIGGER = SAMPLE_RATE * 0.5;                // 8000 (VAD-forced)
export const TRACKING_TRIGGER_RELAXED = SAMPLE_RATE * 1.5;        // 24000 (routine cycle)
export const TRACKING_SILENCE_TIMEOUT = SAMPLE_RATE * 4;           // 64000
export const TRACKING_MAX_AUDIO = SAMPLE_RATE * 30;                // 480000
export const STALE_CYCLES = 4;

// Word progress
export const WORD_LOOKAHEAD = 5;
export const ACOUSTIC_WORD_MARGIN = 0.12;
export const STRONG_CONFIDENCE_THRESHOLD = 0.6;

// Auto-advance
export const AUTO_ADVANCE_ACOUSTIC_DIFF = 3;
export const AUTO_ADVANCE_TAIL_TOKENS = 15;
export const MAX_CONSECUTIVE_AUTO_ADVANCES = 5;

// Residual detection
export const RESIDUAL_THRESHOLD = 0.7;

// Continuation bonuses for next verses after a match
export const CONTINUATION_BONUSES = [0.22, 0.12, 0.06] as const;
