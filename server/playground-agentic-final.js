// Agentic-final-layer playground: reuse saved per-chunk placement outputs from data/*/placement.json,
// then make one extra LLM call per episode to choose the final schedule across viable options.
// This keeps shot cuts / silence / per-chunk reasoning tool-based and agentizes only the last layer.
// Usage:
//   node server/playground-agentic-final.js            # all saved episodes under data/
//   node server/playground-agentic-final.js <hash>     # one saved episode folder
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env", import.meta.url).pathname, quiet: true });

const MODEL = process.env.MODEL_REASON ?? "openai/gpt-5.6-luna";
const REASONING_EFFORT = "medium";
const DATA_DIR = new URL("../data/", import.meta.url);
const DB_PATH = new URL("../data/app.db", import.meta.url);

const schedulableOnly = [
  /higher-scoring schedule exists without it/i,
  /same brand as the adjacent accepted break/i,
  /already plays .* the most allowed/i,
  /would exceed the .* ad-load budget/i,
];

const maxBrandRepeats = (durationSec) => Math.min(3, Math.max(2, Math.round(durationSec / 1800)));

function isSchedulableOption(option) {
  if (typeof option.cutTime !== "number") return false;
  return option.problems.every((p) => schedulableOnly.some((rx) => rx.test(p)));
}

function shortestCreativeSeconds(catalogue, brandId) {
  const brand = catalogue.find((b) => b.brand_id === brandId);
  return brand ? Math.min(...brand.creatives.map((c) => c.duration_sec)) : 15;
}

function fitTotal(selected, byId) {
  return selected.reduce((sum, id) => sum + (byId.get(id)?.fit ?? 0), 0);
}

function brandDiversity(selected, byId) {
  return new Set(selected.map((id) => byId.get(id)?.brandId).filter(Boolean)).size;
}

function validateSelection(selectedIds, optionsById, durationSec, maxAdLoadPct) {
  const selected = selectedIds.map((id) => optionsById.get(id)).filter(Boolean).sort((a, b) => a.cutTime - b.cutTime);
  const problems = [];
  const seenSlots = new Set();
  let adSeconds = 0;
  const brandUses = new Map();
  for (const item of selected) {
    if (seenSlots.has(item.slot)) problems.push(`multiple picks from slot ${item.slot}`);
    seenSlots.add(item.slot);
    adSeconds += item.minCreativeSec;
    const uses = (brandUses.get(item.brandId) ?? 0) + 1;
    brandUses.set(item.brandId, uses);
  }
  for (let i = 1; i < selected.length; i++) {
    if (selected[i - 1].brandId === selected[i].brandId) {
      problems.push(`adjacent repeated brand ${selected[i].brandId} at slots ${selected[i - 1].slot} and ${selected[i].slot}`);
    }
  }
  const brandCap = maxBrandRepeats(durationSec);
  for (const [brandId, uses] of brandUses) {
    if (uses > brandCap) problems.push(`${brandId} used ${uses} times > cap ${brandCap}`);
  }
  const budgetSec = durationSec * maxAdLoadPct;
  if (adSeconds > budgetSec + 1e-9) {
    problems.push(`minimum creative durations total ${adSeconds}s > budget ${budgetSec.toFixed(1)}s`);
  }
  return { selected, problems, adSeconds, budgetSec };
}

function extractBaseline(slotLogs) {
  const baseline = [];
  for (const slot of slotLogs) {
    if (!slot.accepted) continue;
    const match = slot.options.find(
      (o) => o.lineId === slot.accepted.lineId && o.brandId === slot.accepted.brandId && typeof o.cutTime === "number",
    );
    if (match) baseline.push(`slot${slot.slot}-line${match.lineId}-${match.brandId}`);
  }
  return baseline;
}

function buildSystemPrompt() {
  return `
You are the final-layer ad scheduler for one full episode.

You do NOT need to detect cuts from raw media. The tool layer already did that and already rejected unsafe options.
Your job is only to choose the best overall schedule from the viable options you are given.

Rules:
- Select at most one option per slot.
- Selected breaks must not repeat the same brand in adjacent chosen breaks.
- No brand may appear more than the allowed cap.
- Respect the total ad-load budget using the min_creative_sec values provided for each option.
- It is allowed to skip weak options entirely.
- Prefer schedules that keep strong semantic fit, good spread, brand diversity, and natural-feeling interruption points.
- Do not invent new slots or brands.

Return JSON only.
  `.trim();
}

function buildUserMessage(input) {
  return JSON.stringify(input, null, 2);
}

async function callScheduler(input, optionIds) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["selected_option_ids", "why"],
    properties: {
      selected_option_ids: {
        type: "array",
        items: { type: "string", enum: optionIds },
      },
      why: { type: "string" },
    },
  };

  const req = {
    model: MODEL,
    reasoning: { effort: REASONING_EFFORT },
    response_format: { type: "json_schema", json_schema: { name: "final_schedule", strict: true, schema } },
    usage: { include: true },
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage(input) },
    ],
  };

  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return {
    seconds: (Date.now() - t0) / 1000,
    costUsd: body.usage?.cost ?? null,
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    answer: JSON.parse(body.choices?.[0]?.message?.content ?? "{}"),
  };
}

function loadPlacementCost(jobId) {
  const db = new DatabaseSync(DB_PATH.pathname);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM model_calls
       WHERE job_id = ? AND stage = 'placement'`,
    )
    .get(jobId);
  db.close();
  return {
    calls: Number(row.calls ?? 0),
    costUsd: Number(row.cost ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  };
}

async function loadEpisode(dirName) {
  const dir = new URL(`../data/${dirName}/`, import.meta.url);
  const [debug, placement] = await Promise.all([
    fs.readFile(new URL("debug.json", dir), "utf8").then(JSON.parse),
    fs.readFile(new URL("placement.json", dir), "utf8").then(JSON.parse),
  ]);

  const cataloguePath = debug.config?.cataloguePath ?? new URL("../catalogue/brands.json", import.meta.url).pathname;
  const catalogue = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  const slots = placement.data.slots;
  const viableBySlot = [];
  const byId = new Map();

  for (const slot of slots) {
    const viable = slot.options
      .filter(isSchedulableOption)
      .map((o) => {
        const id = `slot${slot.slot}-line${o.lineId}-${o.brandId}`;
        const item = {
          id,
          slot: slot.slot,
          lineId: o.lineId,
          brandId: o.brandId,
          fit: o.fit,
          cutTime: o.cutTime,
          basis: o.basis,
          minCreativeSec: shortestCreativeSeconds(catalogue, o.brandId),
          reason: o.reason,
          contextsNearby: o.contextsNearby,
          dialogue: o.dialogue,
        };
        byId.set(id, item);
        return item;
      })
      .sort((a, b) => (b.fit - a.fit) || (a.cutTime - b.cutTime));
    if (viable.length) viableBySlot.push({ slot: slot.slot, options: viable });
  }

  return {
    dirName,
    jobId: debug.jobId,
    summary: debug.programme.summary,
    durationSec: debug.meta.durationSec,
    maxAdLoadPct: debug.config?.pacing?.maxAdLoadPct ?? 0.15,
    brandCap: maxBrandRepeats(debug.meta.durationSec),
    viableBySlot,
    optionIds: [...byId.keys()],
    optionsById: byId,
    baselineIds: extractBaseline(slots),
  };
}

function compactForPrompt(episode) {
  return {
    episode_id: episode.dirName,
    story_summary: episode.summary,
    duration_sec: Math.round(episode.durationSec),
    max_ad_load_pct: episode.maxAdLoadPct,
    max_brand_repeats: episode.brandCap,
    slots: episode.viableBySlot.map((slot) => ({
      slot: slot.slot,
      options: slot.options.map((o) => ({
        option_id: o.id,
        brand_id: o.brandId,
        line_id: o.lineId,
        cut_time_sec: Number(o.cutTime.toFixed(1)),
        fit: o.fit,
        basis: o.basis,
        min_creative_sec: o.minCreativeSec,
        reason: o.reason,
        dialogue_after: o.dialogue?.after?.text ?? "",
        dialogue_before: o.dialogue?.before?.text ?? "",
        contexts_nearby: o.contextsNearby,
      })),
    })),
  };
}

function compare(episode, agentIds) {
  const baseline = validateSelection(episode.baselineIds, episode.optionsById, episode.durationSec, episode.maxAdLoadPct);
  const agent = validateSelection(agentIds, episode.optionsById, episode.durationSec, episode.maxAdLoadPct);
  return {
    baseline,
    agent,
    sameSchedule:
      episode.baselineIds.length === agentIds.length &&
      [...episode.baselineIds].sort().join("|") === [...agentIds].sort().join("|"),
    baselineFitTotal: fitTotal(episode.baselineIds, episode.optionsById),
    agentFitTotal: fitTotal(agentIds, episode.optionsById),
    baselineBrandDiversity: brandDiversity(episode.baselineIds, episode.optionsById),
    agentBrandDiversity: brandDiversity(agentIds, episode.optionsById),
  };
}

async function episodeDirs(filter) {
  const dirs = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const names = dirs
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((name) => !filter || name === filter);
  const out = [];
  for (const name of names) {
    try {
      await fs.access(new URL(`../data/${name}/placement.json`, import.meta.url));
      await fs.access(new URL(`../data/${name}/debug.json`, import.meta.url));
      out.push(name);
    } catch {}
  }
  return out.sort();
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set.");
  process.exit(1);
}

const only = process.argv[2];
const dirs = await episodeDirs(only);
if (!dirs.length) {
  console.error(only ? `No saved episode found for ${only}` : "No saved episodes with placement.json/debug.json found.");
  process.exit(1);
}

const results = [];
for (const dirName of dirs) {
  const episode = await loadEpisode(dirName);
  const promptInput = compactForPrompt(episode);
  const scheduler = await callScheduler(promptInput, episode.optionIds);
  const chosenIds = [...new Set((scheduler.answer.selected_option_ids ?? []).filter((id) => episode.optionsById.has(id)))];
  const comparison = compare(episode, chosenIds);
  const baselinePlacementCost = loadPlacementCost(episode.jobId);
  results.push({
    dirName,
    jobId: episode.jobId,
    viableSlots: episode.viableBySlot.length,
    viableOptions: episode.optionIds.length,
    scheduler,
    chosenIds,
    comparison,
    baselinePlacementCost,
  });
}

console.log(JSON.stringify({
  model: MODEL,
  reasoningEffort: REASONING_EFFORT,
  episodes: results.map((r) => ({
    episode: r.dirName,
    jobId: r.jobId,
    viableSlots: r.viableSlots,
    viableOptions: r.viableOptions,
    baselineSelected: r.comparison.baseline.selected.map((x) => ({
      slot: x.slot,
      brandId: x.brandId,
      lineId: x.lineId,
      cutTime: Number(x.cutTime.toFixed(1)),
      fit: x.fit,
    })),
    agentSelected: r.comparison.agent.selected.map((x) => ({
      slot: x.slot,
      brandId: x.brandId,
      lineId: x.lineId,
      cutTime: Number(x.cutTime.toFixed(1)),
      fit: x.fit,
    })),
    sameSchedule: r.comparison.sameSchedule,
    baselineFitTotal: Number(r.comparison.baselineFitTotal.toFixed(3)),
    agentFitTotal: Number(r.comparison.agentFitTotal.toFixed(3)),
    baselineBrandDiversity: r.comparison.baselineBrandDiversity,
    agentBrandDiversity: r.comparison.agentBrandDiversity,
    baselineValidationProblems: r.comparison.baseline.problems,
    agentValidationProblems: r.comparison.agent.problems,
    baselinePlacementCostUsd: Number(r.baselinePlacementCost.costUsd.toFixed(6)),
    baselinePlacementCalls: r.baselinePlacementCost.calls,
    agentFinalLayerCostUsd: r.scheduler.costUsd === null ? null : Number(r.scheduler.costUsd.toFixed(6)),
    agentPromptTokens: r.scheduler.promptTokens,
    agentCompletionTokens: r.scheduler.completionTokens,
    why: r.scheduler.answer.why,
  })),
}, null, 2));
