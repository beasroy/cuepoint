// Pure decision rules for the final "is anyone speaking at the cut?" gate.
// VAD decides the clear cases; the audio LLM is only asked when VAD is unsure, because on quiet
// audio it invents plausible Bengali dialogue (measured: 6–7 of 9 calls on confirmed-quiet clips).
import type { Interval } from "shared";
import type { VadScore } from "../../lib/vad";

export interface ListenThresholds {
  windowSec: number;
  vadSpeechMin: number;
  vadQuietMax: number;
}

export interface LlmListenAnswer {
  speech_near_mark: boolean;
  heard_at_mark: string;
  transcript: string;
}

/** Pure: any transcribed word or audio event inside ±windowSec of the cut. */
export const speechIntervalNear = (speech: Interval[], cut: number, windowSec: number) =>
  speech.some((w) => w.start < cut + windowSec && w.end > cut - windowSec);

/**
 * Pure: how far either side of the cut the check may listen. The window must never reach past the
 * pause the cut sits in — a 2s window around a 1.5s pause takes in the dialogue on both sides, and
 * the VAD then reports that as speech at the cut. Measured on money_honey: 91% of 1.5–2s pauses were
 * rejected that way, against 0% once the pause passed 4s. Clamped to the nearer speech edge, with a
 * floor so there is always some audio to judge.
 */
export function listenHalfWindow(speech: Interval[], cut: number, windowSec: number, floorSec: number): number {
  let before = -Infinity;
  let after = Infinity;
  for (const w of speech) {
    if (w.end <= cut) before = Math.max(before, w.end);
    if (w.start >= cut) after = Math.min(after, w.start);
  }
  return Math.max(floorSec, Math.min(windowSec, cut - before, after - cut));
}

/** Pure: "speech" / "quiet" when VAD (plus the transcript) is clear, else "unsure" (ask the LLM). */
export function vadGate(vad: VadScore, speechNear: boolean, t: ListenThresholds): "speech" | "quiet" | "unsure" {
  if (vad.max >= t.vadSpeechMin) return "speech";
  if (vad.max < t.vadQuietMax && !speechNear) return "quiet";
  return "unsure";
}

/**
 * Pure: an LLM answer counts as speech only if it says so AND gives words it heard. A "speech"
 * flag with an empty transcript is the model contradicting itself, not evidence of speech.
 */
export const answerHasSpeech = (a: LlmListenAnswer) =>
  (a.speech_near_mark || a.heard_at_mark === "speech") && /\p{L}/u.test(a.transcript);

/** Pure: with VAD unsure, the cut is accepted only if every LLM answer arrived and none heard speech. */
export function llmVerdict(answers: (LlmListenAnswer | Error)[]): { speech: boolean; reason: string } {
  const failed = answers.filter((a): a is Error => a instanceof Error);
  if (failed.length || !answers.length) {
    return { speech: true, reason: `listening check failed, cannot confirm no speech (${failed[0]?.message.slice(0, 120) ?? "no answer"})` };
  }
  const heard = (answers as LlmListenAnswer[]).find(answerHasSpeech);
  return heard
    ? { speech: true, reason: `audio LLM heard speech at the cut (${heard.transcript.slice(0, 120)})` }
    : { speech: false, reason: `audio LLM heard no speech in ${answers.length}/${answers.length} checks` };
}
