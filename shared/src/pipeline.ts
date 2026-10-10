import type { CallKindUsage, StageUsage } from "./job";

export interface VideoMeta {
  durationSec: number;
  startTimeSec: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
}

export interface AudioChunk {
  index: number;
  file: string;
  offsetSec: number;
  durationSec: number;
}

export interface IngestArtifact {
  meta: VideoMeta;
  fullAudio: string;
  chunks: AudioChunk[];
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  chunkIndex: number;
  /** Which transcriber produced it. */
  source: "scribe";
  /** Transcriber confidence (Deepgram utterance confidence), when available. */
  confidence?: number;
  /** Set when the hallucination filter removed it from the transcript. Still counts as occupied time for cuts. */
  dropped?: { reason: string };
}

export interface Transcript {
  segments: Segment[];
  /** Absolute times (sec) where one chunk ends and the next begins. */
  chunkSeams: number[];
  /** Per-utterance field names the transcriber actually returned. */
  rawFieldsSeen: string[];
  /** Chunks each provider covered, e.g. { deepgram: 12, llm: 12 } when both succeeded everywhere. */
  providers: Record<string, number>;
  /** Audio-aligned speech intervals: every Scribe word (each capped), plus audio-event spans,
   *  which carry no words but are not silence either. Hard walls for cuts. */
  speech: Interval[];
  /** Time ranges the transcriber covered, i.e. where `speech` is complete. "Nobody is speaking"
   *  is only ever inferred inside these ranges. */
  speechCoverage: Interval[];
  /** Non-speech sound Scribe named ([music], [crying], [screaming]). Already folded into `speech`;
   *  kept separately because what the sound is matters for whether an ad belongs there. */
  audioEvents: AudioEvent[];
}

export interface Interval {
  start: number;
  end: number;
}

export interface AudioEvent extends Interval {
  /** Scribe's own label, e.g. "[বাদ্যসঙ্গীত]", "[screaming]". */
  text: string;
}

export interface Signals {
  silences: Interval[];
  shotCuts: number[];
}

/**
 * The final "is anyone speaking within ±1s of the cut?" gate. Silero VAD decides the clear cases
 * (method "vad"); only when it is unsure is the audio LLM asked (method "llm").
 */
export interface ListenCheck {
  speech: boolean;
  method: "vad" | "llm";
  vad: { max: number; frac: number };
  /** Half-window actually judged: listen.windowSec, clamped so it never reaches past the pause. */
  windowSec: number;
  speechNear: boolean;
  answers?: { speechNearMark: boolean; heard: string; transcript: string }[];
  reason: string;
}

/** One dialogue line, as the model was shown it. */
export interface LineRef {
  start: number;
  end: number;
  text: string;
}

/** The dialogue around a cut: the line the ad follows, and the one that resumes after it
 *  (absent when the chosen line is the last one in view). Enough to read a decision back. */
export interface CutDialogue {
  after: LineRef;
  before?: LineRef;
}

export interface Break {
  candidateId: string;
  timeSec: number;
  brandId: string;
  creativeId: string;
  adDurationSec: number;
  whereScore: number;
  fit: number;
  combinedScore: number;
  reason: string;
  /** What is actually being said either side of the cut. */
  dialogue?: CutDialogue;
}

export interface SelectionLog {
  candidateId: string;
  outcome: "selected" | "rejected";
  reason: string;
}

export interface ProgrammeContext {
  summary: string;
  genre: string;
  /** Activities/settings that recur across the programme. */
  recurringContexts: string[];
}

export interface DebugReport {
  /** A plain-language account of how the ads were placed, and the settings that were used. */
  explanation: string[];
  settingsUsed: Record<string, unknown>;
  jobId: string;
  programme?: ProgrammeContext;
  fileHash: string;
  meta: VideoMeta;
  config: unknown;
  transcriptStats: { segments: number; dropped: number; rawFieldsSeen: string[] };
  /** One entry per chunk. */
  selection: SelectionLog[];
  breaks: Break[];
  /** Every chunk: what the model was shown, what it answered, and what code accepted or rejected. */
  placement: unknown;
  /** Every API call recorded for this video, across every attempt (including earlier failed retries —
   *  it's money already spent), and what it cost. Omitted for a CLI/script run that never opened the
   *  database (npm run stage, playground). */
  costSummary?: { totalUsd: number; totalCalls: number; totalErrors: number; byStage: StageUsage[]; byKind: CallKindUsage[] };
}
