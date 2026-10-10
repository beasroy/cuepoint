// Placement experiment: does a prompt change fix a placement we know is wrong?
//
// The case it was built for: money_honey (6e29736c) chunk 3. The model put an ad after
// "ফির্নি আনছি খা। খা।" ("I've brought firni. Eat. Eat.") — an imperative that starts an action.
// On screen the mother then feeds her son, so the ad lands in the middle of the act the line began.
// The 2.0s silence there is real and the camera does not cut for 92 seconds either side, so neither
// detector is at fault: the prompt let an invitation count as the end of a conversation.
//
// The rule fix won that experiment and SHIPPED (prompts/placement.ts, PLACEMENT_PROMPT_VERSION 5):
// rule 2 now covers imperatives whose action follows ("eat", "sit", "open it") and says a change of
// topic between the same people in the same place is not the end of a scene. So arm A is the live
// prompt, and the two arms now on offer are:
//   -rule       puts the OLD rule 2 back, to confirm the bug returns without it (a regression guard)
//   CONTINUITY  a "· no shot change from X to Y" marker, still unshipped: a shot cut only appears
//               WHEN it fires, so a stretch the camera never cuts in is invisible today — and that
//               absence is the evidence the scene did not change. It did not fix the case alone.
//
// Everything else is held fixed: same dialogue, silences, brands, story, schema, chunk.
//
//   npx tsx server/placement-experiment.js 6e29736c --chunk 3
//   npx tsx server/placement-experiment.js 6e29736c --chunk 3 --expect-line 7
//   npx tsx server/placement-experiment.js 6e29736c --all-chunks --arms D
//
// Run from the repo root. --expect-line marks the known-bad line so each arm is scored against it.
import fs from "node:fs";
import path from "node:path";
import { config } from "./src/config.ts";
import { loadCatalogueFile } from "./src/catalogue/loader.ts";
import { placementJsonSchema, placementSystemPrompt, placementUserPrompt } from "./src/prompts/placement.ts";
import { cutAfterLine, mergeSilences, renderLines } from "./src/stages/placement.ts";

/** Models to put each arm through. The first is the one the pipeline runs today. */
const MODELS = (process.env.EXPERIMENT_MODELS ?? `${config.openrouter.reasonModel},anthropic/claude-haiku-5.5`).split(",");

/** A stretch the camera never cuts in, at least this long, is worth telling the model about. */
const CONTINUITY_MIN_SEC = 15;

const CONCURRENCY = 2;
const MIN_CALL_GAP_MS = Math.ceil(60_000 / config.openrouter.rpmPerModel);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const rel = (p) => path.relative(repoRoot, p);
const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t - Math.floor(t / 60) * 60).toFixed(1).padStart(4, "0")}`;

// ---- Rule 2. The fix SHIPPED in prompts/placement.ts (PLACEMENT_PROMPT_VERSION 5), so the rule arm
// is now a revert: it puts the old wording back, to check the bug returns when the rule is removed.
// Both strings are anchored to the live file, so a later prompt edit breaks this loudly.
const RULE_2 = `2. That line must be the LAST line of a finished conversation. Never place an ad in the middle of a conversation, between a question and its answer, or after a line that calls someone over or starts something ("come here", "listen", "wait"). This includes a line telling someone to do something that then happens on screen ("eat", "drink", "sit down", "open it", "take it", "look"): the action follows the line, so the scene is still running even though nobody speaks during it. An offer or an invitation is the start of something, never the end of it. A change of subject between the same people in the same place is also not the end of a conversation — the scene itself has to end, not just the topic.`;
const RULE_2_REVERTED = `2. That line must be the LAST line of a finished conversation. Never place an ad in the middle of a conversation, between a question and its answer, or after a line that calls someone over or starts something ("come here", "listen", "wait").`;

// ---- Fix 2: the continuity marker's legend, spliced in beside the shot-cut legend.
const SHOT_CUT_LEGEND = `  "· shot cut [1141.0]": the picture changes to a new shot at that moment.`;
const CONTINUITY_LEGEND = `  "· no shot change from 1084.5 to 1141.0 (one continuous shot)": the camera did not cut once in that whole stretch. Nothing in the picture changed scene anywhere inside it, so any line in there is in the middle of a scene that is still running, however the dialogue reads.`;

function systemPrompt(o, arm) {
  let s = placementSystemPrompt(o);
  if (arm.rule) {
    if (!s.includes(RULE_2)) throw new Error("Rule 2 in prompts/placement.ts has changed; update RULE_2 in placement-experiment.js.");
    s = s.replace(RULE_2, RULE_2_REVERTED);
  }
  if (arm.continuity) {
    if (!s.includes(SHOT_CUT_LEGEND)) throw new Error("The shot-cut legend has changed; update SHOT_CUT_LEGEND in placement-experiment.js.");
    s = s.replace(SHOT_CUT_LEGEND, `${SHOT_CUT_LEGEND}\n${CONTINUITY_LEGEND}`);
  }
  return s;
}

/**
 * The real renderLines output, with "no shot change" markers added for every stretch of the span
 * the camera never cuts in. Dialogue, silences and shot cuts are untouched — this only fills in the
 * gaps between them, which is information the prompt currently has no way to express.
 */
function withContinuity(rendered, shotCuts, o) {
  const inside = shotCuts.filter((c) => c >= o.from && c < o.to).sort((a, b) => a - b);
  const edges = [o.from, ...inside, o.to];
  const gaps = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] >= CONTINUITY_MIN_SEC)
      gaps.push({ t: edges[i], text: `    · no shot change from ${edges[i].toFixed(1)} to ${edges[i + 1].toFixed(1)} (one continuous shot)` });
  }
  if (!gaps.length) return rendered;
  // Splice each marker in at the right place by start time, reading the times the real renderer wrote.
  const lines = rendered.split("\n").map((text) => {
    const m = text.match(/\[(\d+\.\d)[–\-]/);
    return { t: m ? Number(m[1]) : 0, text };
  });
  return [...lines, ...gaps].sort((a, b) => a.t - b.t).map((x) => x.text).join("\n");
}

// ---- Model call: the body chatJson sends, with the model swapped per arm.
let lastCallAt = 0;
/** Reasoning effort, passed through to OpenRouter. Claude Haiku 5.5 thinks by default, which
 *  dominates its bill on a prompt this size; the pipeline's own calls set no effort at all. */
const EFFORT = (process.argv.includes("--effort") ? process.argv[process.argv.indexOf("--effort") + 1] : undefined);

async function callModel(model, system, user, schema) {
  const wait = Math.max(0, lastCallAt + MIN_CALL_GAP_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openrouter.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "ad_slot_plan", strict: true, schema } },
      ...(EFFORT ? { reasoning: { effort: EFFORT } } : {}),
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(config.openrouter.requestTimeoutMs),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return {
    answer: JSON.parse(body.choices[0].message.content),
    cost: body.usage?.cost ?? 0,
    tokens: {
      in: body.usage?.prompt_tokens ?? 0,
      out: body.usage?.completion_tokens ?? 0,
      cached: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

async function pool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]().catch((err) => ({ error: err.message }));
      }
    }),
  );
  return out;
}

// ---- Arguments
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--all-chunks"));
const hash = positional[0];
if (!hash) {
  console.error("usage: npx tsx server/placement-experiment.js <data-hash> [--chunk N | --all-chunks] [--expect-line N] [--arms ABCD]");
  process.exit(1);
}
const onlyChunk = value("--chunk") ? Number(value("--chunk")) : undefined;
const allChunks = flag("--all-chunks");
const expectLine = value("--expect-line") ? Number(value("--expect-line")) : undefined;
const armFilter = (value("--arms") ?? "ABCD").toUpperCase();

const root = path.join(repoRoot, "data");
const hit = fs.existsSync(root) && fs.readdirSync(root).find((d) => d.startsWith(hash));
if (!hit) {
  console.error(`No data directory matching '${hash}'.`);
  process.exit(1);
}
const dataDir = path.join(root, hit);

// ---- Load the processed run
const readJson = (f) => {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
  return raw.data ?? raw;
};
const transcript = readJson("transcript.json");
const ingest = readJson("ingest.json");
const storedSignals = readJson("signals.json");
const programme = fs.existsSync(path.join(dataDir, "programme.json")) ? readJson("programme.json") : null;
const catalogue = await loadCatalogueFile(config.cataloguePath);

const lines = transcript.segments.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
const silences = mergeSilences(storedSignals.silences);
const shotCuts = storedSignals.shotCuts;
const speech = transcript.speech ?? [];
const cfg = config.placement;
const duration = ingest.meta.durationSec;
const lastAdSec = duration - cfg.noAdLastSec;

const brands = catalogue.brands.map((b) => ({
  brand_id: b.id,
  name: b.name,
  category: b.category,
  fits_scenes_about: b.targetContexts,
  never_next_to: b.negativeContexts,
}));
const blockAll = catalogue.negativeVocab.filter(
  (c) => catalogue.brands.filter((b) => b.negativeContexts.includes(c)).length / catalogue.brands.length > config.thresholds.consensusNegativeShare,
);
const brandName = (id) => brands.find((b) => b.brand_id === id)?.name ?? id;

const ARMS = [
  { key: "A", label: "shipped", rule: false, continuity: false },
  { key: "B", label: "+continuity", rule: false, continuity: true },
  { key: "C", label: "-rule (revert)", rule: true, continuity: false },
  { key: "D", label: "-rule +cont.", rule: true, continuity: true },
].filter((a) => armFilter.includes(a.key));

let windows = ingest.chunks.map((c) => ({ chunk: c.index + 1, from: c.offsetSec, to: Math.min(c.offsetSec + c.durationSec, lastAdSec) }));
if (!allChunks && onlyChunk !== undefined) windows = windows.filter((w) => w.chunk === onlyChunk);
if (!allChunks && onlyChunk === undefined) windows = windows.slice(0, 1);

console.log("==================== PLACEMENT EXPERIMENT ====================");
console.log(`${rel(dataDir)} · ${windows.length} chunk(s) · arms ${ARMS.map((a) => a.key).join("")} · models: ${MODELS.join(", ")}`);
if (expectLine !== undefined) console.log(`Scoring against the known-bad line ${expectLine}: an arm that still picks it has not fixed anything.\n`);

const jobs = [];
for (const w of windows) {
  const current = lines.filter((l) => l.end >= w.from && l.end <= w.to);
  if (w.from >= w.to || !current.length) continue;
  const prev = lines.filter((l) => l.end < w.from && l.end >= w.from - cfg.contextSec);
  const next = lines.filter((l) => l.start > w.to && l.start <= w.to + cfg.contextSec);
  const spans = {
    prev: { from: prev[0]?.start ?? w.from, to: current[0].start },
    current: { from: current[0].start, to: next[0]?.start ?? current.at(-1).end + 10 },
    next: { from: next[0]?.start ?? w.to, to: (next.at(-1)?.end ?? w.to) + 1 },
  };
  const sig = { silences, shotCuts };
  const show = cfg.showSilenceMinSec;
  const schema = placementJsonSchema({ lineCount: current.length, brandIds: catalogue.brands.map((b) => b.id), contexts: catalogue.negativeVocab });
  const base = {
    P: renderLines(prev, "P", sig, { ...spans.prev, showSilenceMinSec: show }),
    C: renderLines(current, "", sig, { ...spans.current, showSilenceMinSec: show }),
    N: renderLines(next, "N", sig, { ...spans.next, showSilenceMinSec: show }),
  };

  for (const arm of ARMS) {
    const user = placementUserPrompt({
      brands,
      lineCount: current.length,
      previousLines: arm.continuity ? withContinuity(base.P, shotCuts, spans.prev) : base.P,
      currentLines: arm.continuity ? withContinuity(base.C, shotCuts, spans.current) : base.C,
      nextLines: arm.continuity ? withContinuity(base.N, shotCuts, spans.next) : base.N,
    });
    const system = systemPrompt({ blockAll, storySoFar: programme?.summary ?? "" }, arm);
    for (const model of MODELS)
      jobs.push(() => callModel(model, system, user, schema).then((r) => ({ w, current, next, arm, model, ...r })));
  }
}

const results = await pool(jobs, CONCURRENCY);

/** Resolve an answer the way the pipeline does, with the real cutAfterLine and content checks. */
function resolve(choice, current, next) {
  if (!choice) return { verdict: "no ad" };
  const line = current[choice.line_id - 1];
  if (!line) return { verdict: `line ${choice.line_id} not in chunk` };
  const cut = cutAfterLine(line, current[choice.line_id] ?? next[0], { silences, shotCuts, speech }, {
    minSpeechFreeSec: config.thresholds.minSpeechFreeSec,
    padSec: config.thresholds.cutPaddingMs / 1000,
    durationSec: duration,
  });
  const brand = brands.find((b) => b.brand_id === choice.brand_id);
  const nearby = new Set(choice.contexts_nearby ?? []);
  const problems = [
    ...(brand?.never_next_to.filter((c) => nearby.has(c)) ?? []).map((c) => `'${c}' blocks this brand`),
    ...blockAll.filter((c) => nearby.has(c)).map((c) => `'${c}' blocks every brand`),
    ...(choice.fit < cfg.minBrandFit ? [`fit ${choice.fit} < ${cfg.minBrandFit}`] : []),
    ...(cut.cutTime === undefined ? [`no safe pause: ${cut.reason}`] : []),
  ];
  return { line, choice, cut, problems, verdict: problems.length ? "rejected by code" : "ACCEPTED" };
}

let totalCost = 0;
const tally = new Map();
/** Cost per model, so a cheaper model's saving is visible next to its answers. */
const costByModel = new Map();
for (const r of results) {
  if (!r || r.error) {
    console.log(`  call failed: ${r?.error}`);
    continue;
  }
  totalCost += r.cost;
  costByModel.set(r.model, (costByModel.get(r.model) ?? 0) + r.cost);
  const res = resolve(r.answer.placement, r.current, r.next);
  const key = `${r.arm.key}\0${r.model}`;
  const stillBad = expectLine !== undefined && res.choice?.line_id === expectLine;
  tally.set(key, (tally.get(key) ?? 0) + (stillBad ? 1 : 0));
  const head = `chunk ${r.w.chunk}  ${r.arm.key} ${r.arm.label.padEnd(12)} ${r.model.split("/").pop().padEnd(18)}`;
  if (!res.choice) {
    console.log(`${head} no ad`);
    console.log(`${" ".repeat(10)}why: ${r.answer.why_not_others?.slice(0, 150) ?? ""}`);
    continue;
  }
  console.log(
    `${head} line ${String(res.choice.line_id).padStart(2)} · ${brandName(res.choice.brand_id).padEnd(8)} · fit ${res.choice.fit.toFixed(2)} · ` +
      `cut ${res.cut?.cutTime !== undefined ? fmt(res.cut.cutTime) : "none"} · ${res.verdict}${stillBad ? "   <-- STILL THE BAD LINE" : ""}`,
  );
  console.log(`${" ".repeat(10)}after: ${res.line.text.slice(0, 70)}`);
  console.log(`${" ".repeat(10)}why:   ${res.choice.reason.slice(0, 170)}`);
}

console.log("\n==================== SUMMARY ====================");
if (expectLine !== undefined) {
  for (const [key, bad] of tally) {
    const [k, model] = key.split("\0");
    const arm = ARMS.find((a) => a.key === k);
    console.log(`${k} ${arm.label.padEnd(12)} ${model.split("/").pop().padEnd(18)} still picks line ${expectLine}: ${bad ? "YES" : "no"}`);
  }
}
console.log();
for (const [model, cost] of [...costByModel].sort((a, b) => b[1] - a[1])) {
  const rs = results.filter((r) => r && !r.error && r.model === model);
  const out = rs.reduce((t, r) => t + (r.tokens?.out ?? 0), 0) / rs.length;
  const pin = rs.reduce((t, r) => t + (r.tokens?.in ?? 0), 0);
  const cached = rs.reduce((t, r) => t + (r.tokens?.cached ?? 0), 0);
  console.log(`${model.padEnd(28)} $${cost.toFixed(4)} over ${rs.length} calls · $${(cost / rs.length).toFixed(5)} each · ${Math.round(out)} output tokens each`);
  console.log(`${" ".repeat(28)} input ${pin} tokens, ${cached} served from cache (${pin ? (100 * cached / pin).toFixed(1) : 0}%)`);
}
console.log(`\ntotal $${totalCost.toFixed(4)} over ${results.filter((r) => r && !r.error).length} calls`);
