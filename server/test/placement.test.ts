import { describe, expect, it } from "vitest";
import type { Segment } from "shared";
import { placementJsonSchema } from "../src/prompts/placement";
import { checkOption, cutAfterLine, freeIntervals, mergeSilences, renderLines, scheduleBreaks, type ScheduleItem } from "../src/stages/placement";
import { brand, SCORING } from "./fixtures";

const seg = (start: number, end: number, text = "x"): Segment => ({ id: 0, start, end, text, chunkIndex: 0, source: "scribe" });

describe("mergeSilences", () => {
  it("joins touching pieces", () => {
    expect(mergeSilences([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2.02, end: 3 }])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });
});

describe("renderLines", () => {
  it("numbers dialogue lines and puts silence and shot-cut markers where they happen, unnumbered", () => {
    const text = renderLines([seg(10, 11, "a"), seg(14, 15, "b")], "", { silences: [{ start: 11.2, end: 13 }, { start: 16, end: 16.1 }], shotCuts: [12.5] }, { from: 10, to: 20, showSilenceMinSec: 0.5 });
    expect(text.split("\n")).toEqual(["1. [10.0–11.0] a", "    · silence 1.8s [11.2–13.0]", "    · shot cut [12.5]", "2. [14.0–15.0] b"]);
  });
});

describe("cutAfterLine", () => {
  const o = { minSpeechFreeSec: 1.5, padSec: 0.15, durationSec: 1000 };
  it("cuts inside a measured silence, on a shot cut if one falls there", () => {
    const r = cutAfterLine(seg(10, 11), seg(15, 16), { silences: [{ start: 11.2, end: 13 }], shotCuts: [12.5], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 12.5, basis: "silence" });
  });
  it("uses a speech-free pause (music) when there is no silence", () => {
    const r = cutAfterLine(seg(10, 11), seg(15, 16), { silences: [], shotCuts: [], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 13, basis: "speechFree" });
  });
  it("refuses a pause shorter than minSpeechFreeSec when there is no silence in it", () => {
    const r = cutAfterLine(seg(10, 11), seg(11.5, 12), { silences: [], shotCuts: [11.4], speech: [] }, o);
    expect(r.cutTime).toBeUndefined();
    expect(r.reason).toMatch(/only 0.5s/);
  });
  it("uses a silence of any length inside the gap", () => {
    const r = cutAfterLine(seg(10, 11), seg(12, 13), { silences: [{ start: 10.7, end: 11.6 }], shotCuts: [], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 11.3, basis: "silence" });
  });
  it("refuses a pause filled with transcribed words", () => {
    const words = [{ start: 11.5, end: 12.4 }, { start: 13.2, end: 14.3 }];
    expect(cutAfterLine(seg(10, 11), seg(15, 16), { silences: [], shotCuts: [], speech: words }, o).cutTime).toBeUndefined();
  });
  it("takes the earliest word-free stretch of the pause, not just its middle", () => {
    // Real case (indubala 5:48): words start 0.6 s after the line, then a 1.8 s free stretch, then a song.
    const words = [{ start: 348.87, end: 349.87 }, { start: 351.67, end: 358 }]; // free stretch is exactly 1.5 s after padding
    const r = cutAfterLine(seg(346.9, 348.3), seg(360, 366), { silences: [], shotCuts: [], speech: words }, o);
    expect(r.basis).toBe("speechFree");
    expect(r.cutTime).toBeCloseTo(350.77, 1);
  });
});

describe("freeIntervals", () => {
  it("returns the parts of a span with no (padded) word", () => {
    expect(freeIntervals({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 6, end: 7 }], 0.5)).toEqual([
      { start: 0, end: 1.5 },
      { start: 3.5, end: 5.5 },
      { start: 7.5, end: 10 },
    ]);
  });
});

describe("placementJsonSchema", () => {
  // Every option reports the contexts around its OWN line, so a sensitive scene beside the main
  // pick cannot block an alternative further away, and one beside an alternative is still caught.
  it("asks for contexts_nearby on each choice, not once per chunk", () => {
    const schema: any = placementJsonSchema({ lineCount: 4, brandIds: ["brand_a"], contexts: ["funeral"] });
    expect(schema.properties.contexts_nearby).toBeUndefined();
    expect(schema.required).not.toContain("contexts_nearby");
    for (const choice of [schema.properties.placement.anyOf[0], schema.properties.alternatives.items]) {
      expect(choice.required).toContain("contexts_nearby");
      expect(choice.properties.contexts_nearby.items.enum).toEqual(["funeral"]);
    }
  });
});

describe("checkOption", () => {
  const brands = [brand("brand_a", ["funeral"]), brand("brand_b", ["eating"])];
  const base = { brands, blockAll: ["violence"], contextsNearby: [] as string[], minBrandFit: 0.3 };
  it("passes a clean option", () => {
    expect(checkOption({ brandId: "brand_a", fit: 0.9 }, base)).toEqual([]);
  });
  it("rejects reported contexts, block-all contexts and low fit", () => {
    const p = checkOption({ brandId: "brand_a", fit: 0.2 }, { ...base, contextsNearby: ["funeral", "violence"] });
    expect(p.join(" | ")).toMatch(/funeral/);
    expect(p.join(" | ")).toMatch(/blocks every brand/);
    expect(p.join(" | ")).toMatch(/fit 0.20/);
  });
  it("rejects a brand reporting its own negative context, and an unknown brand", () => {
    expect(checkOption({ brandId: "brand_b", fit: 0.9 }, { ...base, contextsNearby: ["Eating "] })[0]).toMatch(/eating/);
    expect(checkOption({ brandId: "nope", fit: 0.9 }, base)).toEqual(["unknown brand nope"]);
  });
});

describe("scheduleBreaks", () => {
  const brands = [brand("a", []), brand("b", []), brand("c", [])];
  const item = (chunk: number, cutTime: number, brandId: string, fit: number, pauseSec: number): ScheduleItem => ({
    chunk,
    lineId: 1,
    brandId,
    fit,
    reason: `fits ${brandId}`,
    cutTime,
    basis: "silence",
    pauseSec,
  });
  const run = (itemsByChunk: ScheduleItem[][], maxAdLoadPct = 0.15, extraBrands: typeof brands = [], repeatPenalty = 0, maxRepeats = 3) =>
    scheduleBreaks({
      itemsByChunk,
      brands: [...brands, ...extraBrands],
      durationSec: 2700,
      maxAdLoadPct,
      weights: SCORING,
      language: "bn",
      repeatPenalty,
      maxBrandRepeats: maxRepeats,
    });

  it("takes every item when nothing conflicts, however many that is", () => {
    const a = item(1, 100, "a", 0.9, 3);
    const b = item(2, 900, "b", 0.4, 0);
    const c = item(3, 1700, "c", 0.9, 3);
    expect(run([[a], [b], [c]]).picks.map((p) => p.item.brandId)).toEqual(["a", "b", "c"]);
  });

  it("no minimum gap: two different brands seconds apart both air", () => {
    // Distinct brands, cut times only 5s apart — nothing here relies on any spacing between ads.
    const close1 = item(1, 500, "a", 0.9, 3);
    const close2 = item(2, 505, "b", 0.85, 3);
    expect(run([[close1], [close2]]).picks.map((p) => p.item.brandId)).toEqual(["a", "b"]);
  });

  it("airs the same brand on two breaks in a row when it is clearly the better fit", () => {
    // Chunk 2 can take "a" again (fit 0.9) or "b" (fit 0.4). Even carrying the repeat penalty the
    // better-fitting repeat wins: the right advertiser against the right scene serves a viewer
    // better than a worse match chosen only for variety.
    const c1 = item(1, 100, "a", 0.9, 3);
    const c2a = item(2, 900, "a", 0.9, 3); // 0.96, less 0.15 for the repeat = 0.81
    const c2b = item(2, 900, "b", 0.4, 3); // 0.76, no penalty
    expect(run([[c1], [c2a, c2b]], 0.15, [], 0.15).picks.map((p) => p.item.brandId)).toEqual(["a", "a"]);
  });

  it("but a close call still goes to the fresh brand", () => {
    const c1 = item(1, 100, "a", 0.9, 3);
    const c2a = item(2, 900, "a", 0.9, 3); // 0.96, less 0.15 = 0.81
    const c2b = item(2, 900, "b", 0.85, 3); // 0.94 — behind before the penalty, ahead after it
    expect(run([[c1], [c2a, c2b]], 0.15, [], 0.15).picks.map((p) => p.item.brandId)).toEqual(["a", "b"]);
  });

  it("the repeat cap still bounds it, however well the brand fits", () => {
    const only = (chunk: number, cut: number) => item(chunk, cut, "a", 0.95, 3);
    const picks = run([[only(1, 100)], [only(2, 900)], [only(3, 1700)]], 0.15, [], 0.15, 2).picks;
    expect(picks.map((p) => p.item.brandId)).toEqual(["a", "a"]); // third is refused by the cap
  });

  it("stays under the ad-load budget, and says so for the item that didn't fit", () => {
    const heavy = brand("heavy", [], [1000]); // its only creative is far longer than the budget
    const heavyItem = item(1, 100, "heavy", 0.9, 3);
    const light = item(2, 900, "light", 0.9, 3);
    const { picks, reasonUnpicked } = run([[heavyItem], [light]], 0.15, [heavy, brand("light", [])]);
    expect(picks.map((p) => p.item.brandId)).toEqual(["light"]);
    expect(reasonUnpicked(heavyItem)).toMatch(/ad-load budget/);
  });

  it("the repeat penalty is a tie-break: a fresh brand wins a close call, but a clearly better repeat still airs", () => {
    // "a" airs at chunk 1, "c" (a filler that always pays for itself) at chunk 2 — so "a" reappearing
    // at chunk 3 would repeat, but is not adjacent to its first use (chunk 2's "c" sits between them;
    // the same-brand-adjacent ban only forbids repeating right next to the brand's OWN last break).
    const c1 = item(1, 100, "a", 0.9, 3); // score 0.96
    const c2 = item(2, 700, "c", 0.6, 3); // score 0.84
    // Close call: repeating "a" (0.96 - 0.15 penalty = 0.81) loses to fresh "b" (0.94, no penalty).
    const closeA = item(3, 1300, "a", 0.9, 3);
    const closeB = item(3, 1300, "b", 0.85, 3);
    expect(run([[c1], [c2], [closeA, closeB]], 0.15, [], 0.15).picks.map((p) => p.item.brandId)).toEqual(["a", "c", "b"]);

    // Not close: repeating "a" (0.98 - 0.15 = 0.83) still beats a much weaker fresh "b" (0.12).
    const betterA = item(3, 1300, "a", 0.95, 3);
    const worseB = item(3, 1300, "b", 0.3, 0);
    expect(run([[c1], [c2], [betterA, worseB]], 0.15, [], 0.15).picks.map((p) => p.item.brandId)).toEqual(["a", "c", "a"]);
  });

  it("caps how many times a brand may air, however well it scores everywhere", () => {
    // "a" (fillers of "c" keeping every use non-adjacent) would happily air a 3rd time — it scores
    // far above "b" — but the cap forbids it, so the last chunk falls back to "b" instead.
    const a1 = item(1, 500, "a", 0.9, 3);
    const c1 = item(2, 1000, "c", 0.6, 3);
    const a2 = item(3, 1500, "a", 0.9, 3);
    const c2 = item(4, 2000, "c", 0.6, 3);
    const a3 = item(5, 2500, "a", 0.9, 3);
    const b3 = item(5, 2500, "b", 0.3, 0);
    const { picks } = run([[a1], [c1], [a2], [c2], [a3, b3]], 0.15, [], 0, 2); // maxBrandRepeats = 2
    expect(picks.map((p) => p.item.brandId)).toEqual(["a", "c", "a", "c", "b"]);
  });
});
