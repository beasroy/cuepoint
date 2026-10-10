import { describe, expect, it } from "vitest";
import { buildTranscript, isMusicEvent, scribeAudioEvents, scribePieces, scribeSpeech, type ScribeSettings } from "../src/stages/transcribe";
import { config } from "../src/config";

const chunk = { index: 1, file: "c.mp3", offsetSec: 120, durationSec: 120 };
const S: ScribeSettings = {
  uttSplitSec: config.scribe.uttSplitSec,
  maxWordSec: config.scribe.maxWordSec,
  audioEventsAreSpeech: config.scribe.audioEventsAreSpeech,
  musicEventsAreSpeech: config.scribe.musicEventsAreSpeech,
};

// Shape taken from a real ElevenLabs scribe_v2 response (Bengali): one flat `words` list carrying
// words, the spacing between them, and audio events.
const scribe = {
  language_code: "ben",
  audio_duration_secs: 120,
  words: [
    { text: "তুমি", start: 1.2, end: 1.5, type: "word" as const },
    { text: " ", start: 1.5, end: 1.6, type: "spacing" as const },
    { text: "আসো", start: 1.6, end: 4.6, type: "word" as const }, // 3s span, capped for walls
    { text: "উনি", start: 16.52, end: 16.9, type: "word" as const }, // pause before it -> new utterance
    { text: " ", start: 16.9, end: 17.0, type: "spacing" as const },
    { text: "এসেছেন?", start: 17.0, end: 17.4, type: "word" as const },
    { text: "[বাদ্যসঙ্গীত]", start: 30, end: 40, type: "audio_event" as const },
    { text: "শেষ", start: 118, end: 125, type: "word" as const }, // runs past the chunk end
  ],
};

describe("scribePieces", () => {
  it("groups words into utterances on a pause, on the absolute timeline, clamped to the chunk", () => {
    const u = scribePieces(scribe, chunk, S.uttSplitSec);
    expect(u.map((x) => [x.start, x.end])).toEqual([
      [121.2, 124.6],
      [136.52, 137.4],
      [238, 240],
    ]);
    expect(u[0].text).toBe("তুমি আসো");
    expect(u[1].text).toBe("উনি এসেছেন?");
    expect(u.every((x) => x.source === "scribe")).toBe(true);
  });

  it("leaves audio events and spacing out of the text", () => {
    expect(scribePieces(scribe, chunk, S.uttSplitSec).some((u) => u.text.includes("বাদ্যসঙ্গীত"))).toBe(false);
    expect(scribePieces(scribe, chunk, S.uttSplitSec).some((u) => u.text.includes("  "))).toBe(false);
  });
});

describe("scribeAudioEvents", () => {
  it("returns named non-speech sound with its label, on the absolute timeline", () => {
    expect(scribeAudioEvents(scribe, chunk)).toEqual([{ start: 150, end: 160, text: "[বাদ্যসঙ্গীত]" }]);
  });
});

describe("scribeSpeech", () => {
  it("uses word timings as walls, capping an over-long span, and clamping to the chunk", () => {
    expect(scribeSpeech(scribe, chunk, { ...S, audioEventsAreSpeech: false })).toEqual([
      { start: 121.2, end: 121.5 },
      { start: 121.6, end: 123.6 }, // 3s span capped to maxWordSec
      { start: 136.52, end: 136.9 },
      { start: 137, end: 137.4 },
      { start: 238, end: 240 }, // clamped to the chunk end
    ]);
  });

  it("counts a voice audio event as a wall: a cut inside someone crying is as wrong as one mid-sentence", () => {
    const crying = { ...scribe, words: scribe.words.map((w) => (w.type === "audio_event" ? { ...w, text: "[কান্না]" } : w)) };
    const withEvents = scribeSpeech(crying, chunk, { ...S, audioEventsAreSpeech: true });
    expect(withEvents).toContainEqual({ start: 150, end: 160 });
    expect(withEvents).toHaveLength(scribeSpeech(crying, chunk, { ...S, audioEventsAreSpeech: false }).length + 1);
  });

  it("does not wall off music: a music bed is where a break belongs, not a place ads may not go", () => {
    const withEvents = scribeSpeech(scribe, chunk, { ...S, audioEventsAreSpeech: true });
    expect(withEvents).not.toContainEqual({ start: 150, end: 160 });
    expect(withEvents).toEqual(scribeSpeech(scribe, chunk, { ...S, audioEventsAreSpeech: false }));
    // ...unless the setting says otherwise.
    expect(scribeSpeech(scribe, chunk, { ...S, audioEventsAreSpeech: true, musicEventsAreSpeech: true })).toContainEqual({ start: 150, end: 160 });
  });
});

describe("isMusicEvent", () => {
  it("recognises Scribe's music tags across both languages, and its garbled ones", () => {
    for (const t of ["[music]", "[suspenseful music]", "[outro jingle]", "[মিউজিক]", "[বাদ্যসঙ্গীত]", "[গান]", "[বাদ্যসদ]"])
      expect(isMusicEvent(t), t).toBe(true);
  });
  it("leaves voices and other sounds as walls", () => {
    for (const t of ["[screaming]", "[crying]", "[heavy breathing]", "[হাসি]", "[ফোন রিং]", "[শব্দ]"])
      expect(isMusicEvent(t), t).toBe(false);
  });
});

describe("buildTranscript", () => {
  it("merges one chunk's words, walls and events onto one timeline", () => {
    const t = buildTranscript([{ chunkIndex: 1, scribe }], [chunk], [], config.thresholds, S);
    expect(t.segments.every((s) => s.source === "scribe")).toBe(true);
    expect(t.speech).toEqual(scribeSpeech(scribe, chunk, S).sort((a, b) => a.start - b.start));
    expect(t.audioEvents).toEqual([{ start: 150, end: 160, text: "[বাদ্যসঙ্গীত]" }]);
    expect(t.providers).toEqual({ scribe: 1 });
    expect(t.speechCoverage).toEqual([{ start: 120, end: 240 }]);
  });

  it("flags text that sits inside measured silence as hallucination", () => {
    const t = buildTranscript([{ chunkIndex: 1, scribe }], [chunk], [{ start: 120, end: 125 }], config.thresholds, S);
    expect(t.segments[0].dropped?.reason).toMatch(/silence/);
    expect(t.segments[1].dropped).toBeUndefined();
  });
});
