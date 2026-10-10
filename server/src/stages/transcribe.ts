// Stage 2: transcribe each audio chunk with ElevenLabs Scribe (raw responses cached per chunk),
// then merge onto one timeline.
// Scribe gives audio-aligned word timestamps (the hard walls for cuts), Bengali text, and tags for
// non-speech sound. It returns words only — no utterances — so utterances are grouped here on a
// pause. If a chunk fails the stage fails, because a hole in the transcript could hide a sensitive
// scene and a cut would be placed as if nothing were happening there.
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioChunk, AudioEvent, IngestArtifact, Interval, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed, exists, readJson, writeJson } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { mapLimit } from "../lib/pool";
import { transcribeScribe, type ScribeResponse, type ScribeWord } from "../lib/scribe";
import { artifactPath, type StageContext } from "./context";

export interface RawChunkResult {
  chunkIndex: number;
  scribe: ScribeResponse;
}

export interface ScribeSettings {
  uttSplitSec: number;
  maxWordSec: number;
  audioEventsAreSpeech: boolean;
  musicEventsAreSpeech: boolean;
}

/** Bump when merge/filter logic changes so cached transcripts are rebuilt (raw chunk responses are reused). */
const TRANSCRIPT_BUILD_VERSION = 9;

/**
 * Pure: is this audio event music rather than a voice? A cut inside someone crying is as wrong as
 * one mid-sentence, but a music bed is where television puts its breaks — thresholds.minSpeechFreeSec
 * exists to allow exactly that — so music must not become a wall that forbids cutting.
 * Scribe's tag text is inconsistent and sometimes garbled ("[বাদ্যসদ]", "[আhapsodyমূলক মিউজিক]"),
 * so this matches loosely and anything it cannot recognise stays a wall.
 */
export const isMusicEvent = (text: string) => /music|jingle|song|theme|মিউজিক|সঙ্গীত|সংগীত|গান|বাদ্য/i.test(text);

const scribeDir = (ctx: StageContext) => artifactPath(ctx, path.join("transcribe", `scribe-${ctx.config.scribe.model}`));

export async function transcribeChunks(ctx: StageContext, ingest: IngestArtifact): Promise<RawChunkResult[]> {
  const dir = scribeDir(ctx);
  await fs.mkdir(dir, { recursive: true });

  return mapLimit(ingest.chunks, ctx.config.openrouter.concurrency, async (chunk) => {
    const file = path.join(dir, `chunk_${String(chunk.index).padStart(3, "0")}.json`);
    if (!ctx.force && (await exists(file))) return { chunkIndex: chunk.index, scribe: await readJson<ScribeResponse>(file) };
    const raw = await transcribeScribe(chunk.file);
    if (!Array.isArray(raw?.words)) throw new Error(`no words in Scribe response for chunk ${chunk.index}`);
    await writeJson(file, raw);
    return { chunkIndex: chunk.index, scribe: raw };
  });
}

const overlap = (a: Interval, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export function silenceCoverage(seg: Interval, silences: Interval[]): number {
  const len = seg.end - seg.start;
  if (len <= 0) return 1;
  let covered = 0;
  for (const s of silences) {
    if (s.start >= seg.end) break;
    covered += overlap(seg, s);
  }
  return covered / len;
}

/** Text sitting almost entirely inside measured silence is the transcriber inventing words. */
export function hallucinationReason(seg: Segment, silences: Interval[], t: Thresholds): string | undefined {
  if (!seg.text.trim()) return "empty text";
  const cov = silenceCoverage(seg, silences);
  if (cov >= t.hallucinationSilenceOverlap) return `${Math.round(cov * 100)}% inside silence`;
  return undefined;
}

type Piece = Omit<Segment, "id">;

const valid = (p: Piece) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && !!p.text;

/** Words only: Scribe also returns "spacing" separators and "audio_event" tags on the same list. */
const spokenWords = (raw: ScribeResponse): ScribeWord[] =>
  (raw?.words ?? []).filter((w) => (w.type ?? "word") === "word" && Number.isFinite(w.start) && Number.isFinite(w.end));

/** Pure: Scribe words → absolute-time pieces, one per run of words with no `uttSplitSec` pause in it. */
export function scribePieces(raw: ScribeResponse, chunk: AudioChunk, uttSplitSec: number): Piece[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  const out: Piece[] = [];
  let cur: { start: number; end: number; words: string[] } | undefined;
  const flush = () => {
    if (cur) out.push({ start: cur.start, end: Math.min(cur.end, chunkEnd), text: cur.words.join(" ").trim(), chunkIndex: chunk.index, source: "scribe" });
    cur = undefined;
  };
  for (const w of spokenWords(raw)) {
    const start = off + Math.max(0, Number(w.start));
    const end = off + Number(w.end);
    if (cur && start - cur.end >= uttSplitSec) flush();
    if (!cur) cur = { start, end, words: [] };
    cur.end = Math.max(cur.end, end);
    cur.words.push(String(w.text ?? "").trim());
  }
  flush();
  return out.filter(valid);
}

/** Pure: sound Scribe named but produced no words for — music, laughter, crying. Absolute time. */
export function scribeAudioEvents(raw: ScribeResponse, chunk: AudioChunk): AudioEvent[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  return (raw?.words ?? [])
    .filter((w) => w.type === "audio_event")
    .map((w) => ({ start: off + Math.max(0, Number(w.start)), end: Math.min(off + Number(w.end), chunkEnd), text: String(w.text ?? "").trim() }))
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start);
}

/**
 * Pure: Scribe words → audio-aligned speech intervals, each capped to `maxWordSec` from its start.
 * Audio-event spans join them when `audioEventsAreSpeech`: they carry no words, but a cut inside
 * someone crying is exactly as wrong as one mid-sentence. Music is the exception — see isMusicEvent.
 */
export function scribeSpeech(raw: ScribeResponse, chunk: AudioChunk, s: ScribeSettings): Interval[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  const out: Interval[] = [];
  for (const w of spokenWords(raw)) {
    const start = off + Math.max(0, Number(w.start));
    const end = Math.min(off + Number(w.end), start + s.maxWordSec, chunkEnd);
    if (end > start) out.push({ start, end });
  }
  if (s.audioEventsAreSpeech)
    out.push(
      ...scribeAudioEvents(raw, chunk)
        .filter((e) => s.musicEventsAreSpeech || !isMusicEvent(e.text))
        .map(({ start, end }) => ({ start, end })),
    );
  return out;
}

/** Pure: every chunk's words and audio events merged onto one timeline. */
export function buildTranscript(
  results: RawChunkResult[],
  chunks: AudioChunk[],
  silences: Interval[],
  t: Thresholds,
  s: ScribeSettings,
): Transcript {
  const fields = new Set<string>();
  const providers: Record<string, number> = {};
  const text: Piece[] = [];
  const speech: Interval[] = [];
  const speechCoverage: Interval[] = [];
  const audioEvents: AudioEvent[] = [];
  const sortedSilences = [...silences].sort((a, b) => a.start - b.start);

  for (const r of results) {
    const chunk = chunks.find((c) => c.index === r.chunkIndex);
    if (!chunk) throw new Error(`Unknown chunk ${r.chunkIndex}`);
    providers.scribe = (providers.scribe ?? 0) + 1;
    for (const w of r.scribe.words ?? []) Object.keys(w).forEach((k) => fields.add(`scribe.${k}`));
    text.push(...scribePieces(r.scribe, chunk, s.uttSplitSec));
    speech.push(...scribeSpeech(r.scribe, chunk, s));
    audioEvents.push(...scribeAudioEvents(r.scribe, chunk));
    speechCoverage.push({ start: chunk.offsetSec, end: chunk.offsetSec + chunk.durationSec });
  }

  text.sort((a, b) => a.start - b.start || a.end - b.end);
  speech.sort((a, b) => a.start - b.start);
  audioEvents.sort((a, b) => a.start - b.start);
  const segments: Segment[] = text.map((p, id) => {
    const seg: Segment = { id, ...p };
    const reason = hallucinationReason(seg, sortedSilences, t);
    return reason ? { ...seg, dropped: { reason } } : seg;
  });

  const chunkSeams = chunks.slice(1).map((c) => c.offsetSec);
  speechCoverage.sort((a, b) => a.start - b.start);
  return { segments, speech, speechCoverage, audioEvents, chunkSeams, rawFieldsSeen: [...fields].sort(), providers };
}

export async function runTranscribe(
  ctx: StageContext,
  ingest: IngestArtifact,
  raw: RawChunkResult[],
  signals: Signals,
): Promise<Transcript> {
  const out = artifactPath(ctx, ARTIFACTS.transcript);
  const { uttSplitSec, maxWordSec, audioEventsAreSpeech, musicEventsAreSpeech } = ctx.config.scribe;
  const settings: ScribeSettings = { uttSplitSec, maxWordSec, audioEventsAreSpeech, musicEventsAreSpeech };
  const key = hashJson({
    v: TRANSCRIPT_BUILD_VERSION,
    dir: scribeDir(ctx),
    t: ctx.config.thresholds,
    s: settings,
    c: ingest.chunks.length,
  });
  const cached = ctx.force ? undefined : await readKeyed<Transcript>(out, key);
  if (cached) return cached;
  const transcript = buildTranscript(raw, ingest.chunks, signals.silences, ctx.config.thresholds, settings);
  await writeKeyed(out, key, transcript);
  const dropped = transcript.segments.filter((s) => s.dropped).length;
  ctx.log(
    `transcript: ${transcript.segments.length} text segments, ${transcript.speech.length} speech intervals, ` +
      `${transcript.audioEvents.length} audio events (${JSON.stringify(transcript.providers)}), ${dropped} flagged as hallucination`,
  );
  return transcript;
}
