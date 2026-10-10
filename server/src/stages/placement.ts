// LLM ad placement. One LLM call per transcription chunk (the audio
// pieces from ingest) reads that chunk's dialogue, with the measured silences and shot cuts written
// in, and picks the line after which an ad plays and the brand. Every chunk is called independently
// and in parallel: none is told what any other chunk decided, so the model only ever judges one
// stretch on its own merits. Code decides where exactly each pick's cut goes, rejects anything unsafe
// or below a strict fit floor (no-ad zone, negative contexts, fit < placement.minBrandFit), then —
// once every chunk has answered — chooses the best combination across all of them: highest total
// quality subject to the ad-load budget and never repeating a brand back to back (see
// scheduleBreaks). There is no minimum gap between ads: the fit floor alone gates what plays. A cut
// that then fails the speech check is dropped and the schedule is redrawn without it.
import type { Brand, Break, Catalogue, Creative, CutDialogue, IngestArtifact, Interval, LineRef, ProgrammeContext, ScheduleWeights, Segment, SelectionLog, Signals, Transcript } from "shared";
import fs from "node:fs/promises";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { chatJson } from "../lib/openrouter";
import { mapLimit } from "../lib/pool";
import {
  PLACEMENT_PROMPT_VERSION,
  PlacementResponse,
  placementJsonSchema,
  placementSystemPrompt,
  placementUserPrompt,
  type PlacementAnswer,
  type PlacementBrand,
} from "../prompts/placement";
import { ProgrammeResponse, STORY_PROMPT_VERSION, programmeJsonSchema, storySystemPrompt, storyUserPrompt } from "../prompts/programme";
import { artifactPath, type StageContext } from "./context";
import { pickCreative, shortestCreative } from "./creatives";
import { listenCheck } from "./listen";

/** Bump when the chunk, cut, scheduling or check logic below changes, so cached placements are recomputed. */
export const PLACEMENT_LOGIC_VERSION = 17;

/** Safety valve for pathological inputs; real episodes explore a few thousand schedules at most (see select.ts). */
const MAX_SEARCH_NODES = 500_000;

/** Bounded re-scheduling: a chosen cut can fail the speech check, which drops it and reschedules
 *  around the rest. Each iteration only re-checks cuts not yet verified, so cost stays close to one
 *  listen check per finally-accepted ad; this just caps the pathological case. */
const MAX_RESCHEDULE_ROUNDS = 20;

/** Tolerance for "at least N seconds" on times that are sums of floats (1.5 s must not come out as 1.4999…). */
const EPS = 1e-6;

/** Pure: measured silences sorted, with pieces that touch (ffmpeg splits long silences) joined. */
export function mergeSilences(silences: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of [...silences].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && x.start - last.end < 0.05) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

/**
 * Pure: dialogue lines numbered ("P1.", "1.", "N1."), with measured silences and shot cuts
 * between them where they happen, as unnumbered marker lines.
 */
export function renderLines(
  lines: Segment[],
  prefix: string,
  signals: { silences: Interval[]; shotCuts: number[] },
  o: { from: number; to: number; showSilenceMinSec: number },
): string {
  const items: { t: number; text: string }[] = lines.map((l, i) => ({
    t: l.start,
    text: `${prefix}${i + 1}. [${l.start.toFixed(1)}–${l.end.toFixed(1)}] ${l.text}`,
  }));
  for (const x of signals.silences) {
    const len = x.end - x.start;
    if (len >= o.showSilenceMinSec && x.start >= o.from && x.start < o.to)
      items.push({ t: x.start, text: `    · silence ${len.toFixed(1)}s [${x.start.toFixed(1)}–${x.end.toFixed(1)}]` });
  }
  for (const c of signals.shotCuts) if (c >= o.from && c < o.to) items.push({ t: c, text: `    · shot cut [${c.toFixed(1)}]` });
  return items
    .sort((a, b) => a.t - b.t)
    .map((x) => x.text)
    .join("\n");
}

/** Pure: one dialogue line trimmed to what is worth reading back. */
export const lineRef = (l: Segment): LineRef => ({ start: l.start, end: l.end, text: l.text });

/**
 * Pure: where exactly the ad cuts in after a chosen line. Inside a measured silence in the gap
 * before the next line, of any length (on a shot cut if one falls in it, else its middle); else,
 * in the earliest stretch of the pause with no transcribed word for at least minSpeechFreeSec
 * (music may play). Undefined, with a reason, when there is neither. The listen check at the cut is
 * the final gate against speech.
 */
export function cutAfterLine(
  line: Segment,
  following: Segment | undefined,
  s: { silences: Interval[]; shotCuts: number[]; speech: Interval[] },
  o: { minSpeechFreeSec: number; padSec: number; durationSec: number },
): { cutTime?: number; basis?: "silence" | "speechFree"; pauseSec: number; reason?: string } {
  const gapStart = line.end;
  const gapEnd = Math.min(following ? following.start : line.end + 10, o.durationSec);
  const pauseSec = Math.max(0, gapEnd - gapStart);
  const clear = (t: number) => !s.speech.some((w) => w.start < t + o.padSec && w.end > t - o.padSec);
  const within = (a: number, b: number) => s.shotCuts.filter((c) => c > a + o.padSec && c < b - o.padSec);

  const best = s.silences
    .map((x) => ({ start: Math.max(x.start, gapStart), end: Math.min(x.end, gapEnd) }))
    .filter((x) => x.end - x.start > EPS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (best) {
    const mid = (best.start + best.end) / 2;
    const cut = within(best.start, best.end).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid;
    if (clear(cut)) return { cutTime: cut, basis: "silence", pauseSec };
  }
  // No usable silence: take the earliest stretch of the pause with no transcribed word for at least
  // minSpeechFreeSec (music may play), i.e. the one closest to where the conversation ended.
  const need = `no measured silence and no ${o.minSpeechFreeSec}s stretch without transcribed words`;
  if (pauseSec < o.minSpeechFreeSec - EPS) return { pauseSec, reason: `only ${pauseSec.toFixed(1)}s before the next line, ${need}` };
  const free = freeIntervals({ start: gapStart, end: gapEnd }, s.speech, o.padSec).find((x) => x.end - x.start >= o.minSpeechFreeSec - EPS);
  if (!free) return { pauseSec, reason: `transcribed words fill the ${pauseSec.toFixed(1)}s pause after this line, ${need}` };
  const mid = (free.start + free.end) / 2;
  const cut = within(free.start, free.end).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid;
  return { cutTime: cut, basis: "speechFree", pauseSec };
}

/** Pure: the parts of `span` not covered by any word (each word widened by pad), in time order. */
export function freeIntervals(span: Interval, words: Interval[], pad: number): Interval[] {
  const out: Interval[] = [];
  let t = span.start;
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const ws = w.start - pad;
    const we = w.end + pad;
    if (we <= t || ws >= span.end) continue;
    if (ws > t) out.push({ start: t, end: Math.min(ws, span.end) });
    t = Math.max(t, we);
    if (t >= span.end) break;
  }
  if (t < span.end) out.push({ start: t, end: span.end });
  return out;
}

/**
 * Pure: the content safety rules code enforces on one option from the model, independent of any
 * other option or chunk. Empty = passes. Relies on the contexts the model reported as nearby for
 * THIS option's own line — each option carries its own list, so a sensitive scene beside one option
 * never blocks another further away, and one beside an alternative is still caught (there is no
 * separate scene analysis). Not repeating a brand back to back is a separate, later check (see
 * scheduleBreaks): it depends on which chunks end up adjacent in the final schedule, which isn't
 * known until every chunk has answered.
 */
export function checkOption(
  o: { brandId: string; fit: number },
  d: { brands: Brand[]; blockAll: string[]; contextsNearby: string[]; minBrandFit: number },
): string[] {
  const problems: string[] = [];
  const brand = d.brands.find((b) => b.id === o.brandId);
  if (!brand) return [`unknown brand ${o.brandId}`];
  const reported = new Set(d.contextsNearby.map((c) => c.trim().toLowerCase()));
  const own = brand.negativeContexts.filter((c) => reported.has(c));
  if (own.length) problems.push(`model reported ${own.join(", ")} nearby, which ${brand.name} must never be next to`);
  const all = d.blockAll.filter((c) => reported.has(c));
  if (all.length) problems.push(`model reported ${all.join(", ")} nearby, which blocks every brand`);
  if (o.fit < d.minBrandFit) problems.push(`fit ${o.fit.toFixed(2)} below ${d.minBrandFit}`);
  return problems;
}

/**
 * The episode summary shown to every placement call as background, read straight from the dialogue
 * (one call, cached in programme.json). Best effort: placement works without it.
 */
export async function runStory(ctx: StageContext, transcript: Transcript): Promise<ProgrammeContext | undefined> {
  const out = artifactPath(ctx, ARTIFACTS.programme);
  const lines = transcript.segments.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  const key = hashJson({ v: STORY_PROMPT_VERSION, model: ctx.config.openrouter.reasonModel, lines: hashJson(lines) });
  const cached = ctx.force ? undefined : await readKeyed<ProgrammeContext>(out, key);
  if (cached) return cached;
  if (!lines.length) return undefined;
  try {
    const p = ProgrammeResponse.parse(
      await chatJson({ label: "story", system: storySystemPrompt, user: storyUserPrompt(lines), schemaName: "programme", schema: programmeJsonSchema }),
    );
    const story: ProgrammeContext = { summary: p.summary, genre: p.genre, recurringContexts: p.recurring_contexts.slice(0, 8) };
    await writeKeyed(out, key, story);
    ctx.log(`story: ${story.genre} — ${story.recurringContexts.join(", ")}`);
    return story;
  } catch (err) {
    ctx.log(`story summary failed (${(err as Error).message.slice(0, 200)}); placing without it`);
    return undefined;
  }
}

/** One LLM call's worth of work: the log for a chunk. `slot` is the chunk number (1-based). */
export interface SlotLog {
  slot: number;
  window: [number, number];
  currentLines: number;
  prompt?: string;
  answer?: PlacementAnswer;
  error?: string;
  options: {
    lineId: number;
    brandId: string;
    fit: number;
    reason: string;
    /** The dialogue either side of the cut, so a decision can be read without the prompt. */
    dialogue?: CutDialogue;
    /** The sensitive contexts the model reported at THIS option's line. */
    contextsNearby: string[];
    cutTime?: number;
    basis?: string;
    outcome: "accepted" | "rejected";
    problems: string[];
  }[];
  accepted?: { lineId: number; brandId: string; cutTime: number; creativeId: string };
}

const toPlacementBrand = (b: Brand): PlacementBrand => ({
  brand_id: b.id,
  name: b.name,
  category: b.category,
  fits_scenes_about: b.targetContexts,
  never_next_to: b.negativeContexts,
});

/** The "block every brand" contexts: listed by more than consensusNegativeShare of the brands. */
const blockAllContexts = (c: Catalogue, share: number) =>
  c.negativeVocab.filter((ctx) => c.brands.filter((b) => b.negativeContexts.includes(ctx)).length / c.brands.length > share);

/** One (line, brand) choice from one chunk that passed every content check on its own — a schedulable option. */
export interface ScheduleItem {
  chunk: number;
  lineId: number;
  brandId: string;
  fit: number;
  reason: string;
  cutTime: number;
  basis: "silence" | "speechFree";
  pauseSec: number;
  /** The dialogue either side of the cut, carried through so a placed break can show it. */
  dialogue?: CutDialogue;
}

export interface ScheduledPick {
  item: ScheduleItem;
  creative: Creative;
  combinedScore: number;
}

export interface ScheduleInputs {
  /** Every chunk's viable items, in chunk (= time) order; a chunk with none is an empty array. Within
   *  a chunk, best first — ties among a chunk's own items always favour the earlier one. */
  itemsByChunk: ScheduleItem[][];
  brands: Brand[];
  durationSec: number;
  maxAdLoadPct: number;
  weights: ScheduleWeights;
  language: string;
  /** Subtracted from an item's score for every earlier use of the same brand in this schedule — a
   *  tie-break, not a ban: a repeat still wins when it is clearly the better fit. */
  repeatPenalty: number;
  /** Hard cap: a brand already used this many times cannot be picked again, whatever it scores. */
  maxBrandRepeats: number;
}

/** Pure: a candidate's score — how good the pause is, and how well the brand fits, weighted. */
export const combinedScore = (item: Pick<ScheduleItem, "fit" | "pauseSec">, weights: ScheduleWeights) =>
  Math.min(1, item.pauseSec / 3) * weights.where + item.fit * weights.brandFit;

/**
 * How many times one brand may air in an episode: 2 for anything up to about 75 minutes, 3 beyond
 * that. Kept separate from the per-pick repeatPenalty, which discourages a repeat before this stops
 * it outright — with a small catalogue, some repetition is unavoidable, so this only bounds it.
 */
export const maxBrandRepeats = (durationSec: number): number => Math.min(3, Math.max(2, Math.round(durationSec / 1800)));

/**
 * Picks the highest-total-quality combination of at most one item per chunk, subject to: the
 * ad-load budget, never the same brand as the adjacent pick, and the repeat cap — with a score
 * penalty pushing a fresh brand ahead of a repeat before the cap forces it. There is no minimum gap
 * between ads and no target ad count: every item that has already cleared the fit floor (0.7 by
 * default; see checkOption) and every other content check is free to be scheduled as close to
 * another as the content allows, and there is no preference for more ads over fewer either — the
 * fit floor alone decides which ads exist to choose from. Exhaustive search over chunks in order
 * (small n; see MAX_SEARCH_NODES).
 */
export function scheduleBreaks(inp: ScheduleInputs): { picks: ScheduledPick[]; reasonUnpicked: (item: ScheduleItem) => string } {
  const brandById = new Map(inp.brands.map((b) => [b.id, b]));
  const score = (item: ScheduleItem) => combinedScore(item, inp.weights);
  const maxAdSec = inp.maxAdLoadPct * inp.durationSec;
  const groups = inp.itemsByChunk.filter((g) => g.length > 0);

  type Sel = { item: ScheduleItem; creative: Creative };
  let best: Sel[] = [];
  let bestScore = -1;
  let nodes = 0;
  const path: Sel[] = [];
  const brandCounts = new Map<string, number>();
  const dfs = (gi: number, adUsed: number, total: number) => {
    if (++nodes > MAX_SEARCH_NODES) return;
    if (total > bestScore) {
      best = [...path];
      bestScore = total;
    }
    if (gi >= groups.length) return;
    dfs(gi + 1, adUsed, total); // skip this chunk entirely
    const last = path.at(-1);
    for (const item of groups[gi]) {
      if (last && item.brandId === last.item.brandId) continue;
      const priorUses = brandCounts.get(item.brandId) ?? 0;
      if (priorUses >= inp.maxBrandRepeats) continue;
      const brand = brandById.get(item.brandId);
      const creative = brand && shortestCreative(brand, inp.language);
      if (!creative || creative.durationSec > maxAdSec - adUsed + 1e-9) continue;
      path.push({ item, creative });
      brandCounts.set(item.brandId, priorUses + 1);
      dfs(gi + 1, adUsed + creative.durationSec, total + score(item) - (priorUses > 0 ? inp.repeatPenalty : 0));
      brandCounts.set(item.brandId, priorUses);
      path.pop();
    }
  };
  dfs(0, 0, 0);

  // Spend the remaining ad-load budget: upgrade to longer creatives, best-scoring picks first.
  let used = best.reduce((t, s) => t + s.creative.durationSec, 0);
  for (const s of [...best].sort((a, b) => score(b.item) - score(a.item))) {
    const brand = brandById.get(s.item.brandId)!;
    const up = pickCreative(brand, maxAdSec - used + s.creative.durationSec, inp.language);
    if (up && up.durationSec > s.creative.durationSec) {
      used += up.durationSec - s.creative.durationSec;
      s.creative = up;
    }
  }

  // Recompute each pick's own repeat penalty in time order, for a combinedScore that shows what it
  // actually scored (this matches the order the search's own penalty was applied in).
  const finalCounts = new Map<string, number>();
  const picks: ScheduledPick[] = best
    .sort((a, b) => a.item.cutTime - b.item.cutTime)
    .map((s) => {
      const priorUses = finalCounts.get(s.item.brandId) ?? 0;
      finalCounts.set(s.item.brandId, priorUses + 1);
      return { item: s.item, creative: s.creative, combinedScore: score(s.item) - (priorUses > 0 ? inp.repeatPenalty : 0) };
    });

  // Explain any viable item that did not make the schedule.
  const reasonUnpicked = (item: ScheduleItem): string => {
    const before = [...picks].reverse().find((p) => p.item.cutTime < item.cutTime);
    const after = picks.find((p) => p.item.cutTime > item.cutTime);
    if (before?.item.brandId === item.brandId || after?.item.brandId === item.brandId) {
      return "same brand as the adjacent accepted break, and a higher-scoring choice covers that spot";
    }
    const uses = picks.filter((p) => p.item.brandId === item.brandId).length;
    if (uses >= inp.maxBrandRepeats) {
      return `${brandById.get(item.brandId)?.name ?? item.brandId} already plays ${inp.maxBrandRepeats} times this episode, the most allowed`;
    }
    const brand = brandById.get(item.brandId);
    const shortest = brand && shortestCreative(brand, inp.language);
    if (!shortest || used + shortest.durationSec > maxAdSec + 1e-9) {
      return `would exceed the ${Math.round(inp.maxAdLoadPct * 100)}% ad-load budget`;
    }
    return "a higher-scoring schedule exists without it";
  };

  return { picks, reasonUnpicked };
}

export async function runPlacement(
  ctx: StageContext,
  ingest: IngestArtifact,
  transcript: Transcript,
  signals: Signals,
): Promise<{ breaks: Break[]; log: SelectionLog[]; slots: SlotLog[] }> {
  const cfg = ctx.config;
  const out = artifactPath(ctx, ARTIFACTS.placement);
  const programme = await runStory(ctx, transcript);
  const key = hashJson({
    v: PLACEMENT_PROMPT_VERSION,
    logic: PLACEMENT_LOGIC_VERSION,
    model: cfg.openrouter.reasonModel,
    catalogue: ctx.catalogue.hash,
    placement: cfg.placement,
    thresholds: cfg.thresholds,
    listen: cfg.listen,
    segments: hashJson(transcript.segments),
    speech: hashJson(transcript.speech ?? []),
    signals: hashJson(signals),
    programme,
  });
  const cached = ctx.force ? undefined : await readKeyed<{ breaks: Break[]; log: SelectionLog[]; slots: SlotLog[] }>(out, key);
  if (cached) return cached;

  // Fresh per run: request + response for every placement LLM call, for debugging prompts/answers.
  const llmLog = artifactPath(ctx, "placement-llm.jsonl");
  await fs.writeFile(llmLog, "").catch(() => {});

  const duration = ingest.meta.durationSec;
  const lines = transcript.segments.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  const silences = mergeSilences(signals.silences);
  const shotCuts = signals.shotCuts;
  const speech = transcript.speech ?? [];
  const brands = ctx.catalogue.brands;
  const blockAll = blockAllContexts(ctx.catalogue, cfg.thresholds.consensusNegativeShare);
  const brandName = (id?: string) => (id ? brands.find((b) => b.id === id)?.name ?? id : undefined);
  // One window per transcription chunk, ending where the no-ad zone at the end of the episode starts.
  const lastAdSec = duration - cfg.placement.noAdLastSec;
  const windows = ingest.chunks.map((c) => ({ chunk: c.index + 1, from: c.offsetSec, to: Math.min(c.offsetSec + c.durationSec, lastAdSec) }));

  // ---- Phase 1: every chunk with dialogue, called independently and in parallel. No chunk is told
  // what any other chunk decided (see prompts/placement.ts); each option that passes its own content
  // checks becomes a schedulable ScheduleItem. Not order-dependent, so nothing here is skipped for
  // being "too close" to another chunk — that is a scheduling question, answered in phase 2.
  const logs: SlotLog[] = windows.map((w) => ({ slot: w.chunk, window: [w.from, w.to] as [number, number], currentLines: 0, options: [] }));
  const itemsByChunk: ScheduleItem[][] = windows.map(() => []);
  // Where each ScheduleItem's SlotLog entry lives, so phase 2/3 can update outcome/problems on it later.
  const entryFor = new Map<ScheduleItem, SlotLog["options"][number]>();

  await mapLimit(windows, cfg.openrouter.concurrency, async (w, i) => {
    const log = logs[i];
    if (w.from >= w.to) {
      log.error = `in the last ${cfg.placement.noAdLastSec}s of the episode, where no ad plays`;
      return;
    }
    const current = lines.filter((l) => l.end >= w.from && l.end <= w.to);
    const prev = lines.filter((l) => l.end < w.from && l.end >= w.from - cfg.placement.contextSec);
    const next = lines.filter((l) => l.start > w.to && l.start <= w.to + cfg.placement.contextSec);
    log.currentLines = current.length;
    if (!current.length) {
      log.error = "no dialogue in this chunk";
      return;
    }
    const sig = { silences, shotCuts };
    const show = cfg.placement.showSilenceMinSec;
    const system = placementSystemPrompt({ blockAll, storySoFar: programme?.summary ?? "" });
    const user = placementUserPrompt({
      brands: brands.map(toPlacementBrand),
      lineCount: current.length,
      previousLines: renderLines(prev, "P", sig, { from: prev[0]?.start ?? w.from, to: current[0].start, showSilenceMinSec: show }),
      currentLines: renderLines(current, "", sig, {
        from: current[0].start,
        to: next[0]?.start ?? current.at(-1)!.end + 10,
        showSilenceMinSec: show,
      }),
      nextLines: renderLines(next, "N", sig, { from: next[0]?.start ?? w.to, to: (next.at(-1)?.end ?? w.to) + 1, showSilenceMinSec: show }),
    });
    log.prompt = user;

    let answer: PlacementAnswer;
    try {
      answer = PlacementResponse.parse(
        await chatJson({
          label: `placement chunk ${w.chunk}`,
          system,
          user,
          schemaName: "ad_slot_plan",
          schema: placementJsonSchema({ lineCount: current.length, brandIds: brands.map((b) => b.id), contexts: ctx.catalogue.negativeVocab }),
          // Every chunk of every episode sends the same system prompt and brand catalogue, so they
          // all share one key; it carries the prompt version so a prompt edit starts a fresh cache.
          cacheKey: `placement-v${PLACEMENT_PROMPT_VERSION}-${ctx.catalogue.hash.slice(0, 8)}`,
          logFile: llmLog,
        }),
      );
    } catch (err) {
      // When unsure, don't place: a failed call leaves the chunk empty.
      log.error = `placement call failed: ${(err as Error).message.slice(0, 200)}`;
      return;
    }
    log.answer = answer;

    for (const o of [answer.placement, ...answer.alternatives].filter((x): x is NonNullable<typeof x> => !!x)) {
      const entry: SlotLog["options"][number] = {
        lineId: o.line_id,
        brandId: o.brand_id,
        fit: o.fit,
        reason: o.reason,
        contextsNearby: o.contexts_nearby,
        outcome: "rejected",
        problems: [],
      };
      log.options.push(entry);
      const line = current[o.line_id - 1];
      if (!line) {
        entry.problems.push(`line ${o.line_id} is not one of this chunk's lines`);
        continue;
      }
      const following = current[o.line_id] ?? next[0];
      entry.dialogue = { after: lineRef(line), ...(following && { before: lineRef(following) }) };
      const cut = cutAfterLine(line, following, { silences, shotCuts, speech }, {
        minSpeechFreeSec: cfg.thresholds.minSpeechFreeSec,
        padSec: cfg.thresholds.cutPaddingMs / 1000,
        durationSec: duration,
      });
      if (cut.cutTime === undefined) {
        entry.problems.push(`no safe pause after this line: ${cut.reason}`);
        continue;
      }
      entry.cutTime = cut.cutTime;
      entry.basis = cut.basis;
      if (cut.cutTime > lastAdSec) {
        entry.problems.push(`in the last ${cfg.placement.noAdLastSec}s of the episode, where no ad plays`);
        continue;
      }
      entry.problems.push(
        ...checkOption({ brandId: o.brand_id, fit: o.fit }, { brands, blockAll, contextsNearby: o.contexts_nearby, minBrandFit: cfg.placement.minBrandFit }),
      );
      if (entry.problems.length) continue;

      const item: ScheduleItem = { chunk: w.chunk, lineId: o.line_id, brandId: o.brand_id, fit: o.fit, reason: o.reason, cutTime: cut.cutTime, basis: cut.basis!, pauseSec: cut.pauseSec, dialogue: entry.dialogue };
      itemsByChunk[i].push(item);
      entryFor.set(item, entry);
    }
  });

  // ---- Phase 2/3: schedule the best combination, then verify each chosen cut is clear of speech.
  // A cut that fails is dropped from its chunk's pool and the schedule is redrawn without it — bounded,
  // and each item is only ever listen-checked once, so cost stays close to one check per final ad.
  const verified = new Set<ScheduleItem>();
  let picks: ScheduledPick[] = [];
  let reasonUnpicked: (item: ScheduleItem) => string = () => "";
  for (let round = 0; round < MAX_RESCHEDULE_ROUNDS; round++) {
    ({ picks, reasonUnpicked } = scheduleBreaks({
      itemsByChunk,
      brands,
      durationSec: duration,
      maxAdLoadPct: cfg.placement.maxAdLoadPct,
      weights: cfg.scoring,
      language: cfg.contentLanguage,
      repeatPenalty: cfg.placement.brandRepeatPenalty,
      maxBrandRepeats: maxBrandRepeats(duration),
    }));
    if (!cfg.thresholds.listenCheckCuts) break;
    let anyDropped = false;
    for (const p of picks) {
      if (verified.has(p.item)) continue;
      const target = { id: `chunk${p.item.chunk}-line${p.item.lineId}`, cutTime: p.item.cutTime };
      const heard = await listenCheck(ctx, target, ingest.fullAudio, duration, speech);
      if (heard.rejected) {
        entryFor.get(p.item)!.problems.push(heard.rejected);
        itemsByChunk[p.item.chunk - 1] = itemsByChunk[p.item.chunk - 1].filter((it) => it !== p.item);
        anyDropped = true;
      } else {
        verified.add(p.item);
      }
    }
    if (!anyDropped) break;
  }

  // Every item the schedule didn't use gets a reason; the picks get their creative and outcome.
  for (const items of itemsByChunk) {
    for (const item of items) {
      if (!picks.some((p) => p.item === item)) entryFor.get(item)!.problems.push(reasonUnpicked(item));
    }
  }
  const breaks: Break[] = picks.map((p) => {
    entryFor.get(p.item)!.outcome = "accepted";
    logs[p.item.chunk - 1].accepted = { lineId: p.item.lineId, brandId: p.item.brandId, cutTime: p.item.cutTime, creativeId: p.creative.id };
    return {
      candidateId: `slot-${p.item.chunk}`,
      timeSec: p.item.cutTime,
      brandId: p.item.brandId,
      creativeId: p.creative.id,
      adDurationSec: p.creative.durationSec,
      whereScore: Math.min(1, p.item.pauseSec / 3),
      fit: p.item.fit,
      combinedScore: p.combinedScore,
      reason: p.item.reason,
      dialogue: p.item.dialogue,
    };
  });

  const log: SelectionLog[] = logs.map((l) =>
    l.accepted
      ? { candidateId: `slot-${l.slot}`, outcome: "selected", reason: `${brandName(l.accepted.brandId)} after line ${l.accepted.lineId}` }
      : {
          candidateId: `slot-${l.slot}`,
          outcome: "rejected",
          reason:
            l.error ??
            (l.options.length
              ? l.options.map((o) => `line ${o.lineId} ${brandName(o.brandId)}: ${o.problems.join("; ")}`).join(" | ")
              : `model placed no ad: ${l.answer?.why_not_others ?? ""}`),
        },
  );
  const result = { breaks, log, slots: logs };
  await writeKeyed(out, key, result);
  ctx.log(`placement: ${windows.length} chunks, ${breaks.length} ads placed (${breaks.map((b) => `${Math.round(b.timeSec)}s ${b.brandId}`).join(", ") || "none"})`);
  return result;
}
