import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type {
  BreaksResponse,
  CreateJobResponse,
  GetJobResponse,
  Job,
  JobAuditResponse,
  JobStreamEvent,
  ListJobsResponse,
} from "shared";
import { config } from "../config";
import { loadCatalogue, withStaleFlag } from "../catalogue/store";
import { getRepo, type Requester } from "../db";
import { ARTIFACTS, exists, readJson, writeJson } from "../lib/artifacts";
import { hashFile } from "../lib/hash";
import { uploadDir, uploadStorage, type HashedFile } from "../lib/uploads";
import { subscribeJobEvents } from "../jobs/events";
import { findSourceVideo, jobDir } from "../jobs/runner";
import type { Break, DebugReport } from "shared";
import { toTimeOffset, vastUrl } from "../xml/vmap";
import { creativeUrl } from "../xml/vast";

const upload = multer({ storage: uploadStorage, limits: { fileSize: config.maxUploadBytes } });

export const jobsRouter = Router();

/** Set at startup: wakes the queue worker as soon as there is new work. */
export const queueSignal = { notify: () => {} };

const requester = (req: Request): Requester => ({ ip: req.ip, userAgent: req.get("user-agent") });

/**
 * Registers artifact folders from before the database existed (one-off, idempotent).
 * Finished ones come back as done; unfinished ones as failed, so they never spend API
 * calls until someone presses Retry.
 */
export async function importLegacyJobs() {
  await fs.mkdir(uploadDir, { recursive: true });
  const repo = getRepo();
  let imported = 0;
  for (const name of await fs.readdir(config.dataDir)) {
    const dir = path.join(config.dataDir, name);
    const metaPath = path.join(dir, "job.json");
    if (!(await exists(metaPath))) continue;
    const meta = await readJson<{ originalName: string; createdAt: string }>(metaPath);
    const finished = await exists(path.join(dir, ARTIFACTS.debug));
    if (repo.importLegacy({ fileHash: name, originalName: meta.originalName, createdAt: meta.createdAt, finished, maxAttempts: config.queue.maxAttempts })) {
      imported++;
    }
  }
  if (imported) console.log(`Imported ${imported} job(s) from data/ into the database`);
  // Jobs finished before catalogue hashes were stored: take it from their debug.json.
  for (const job of repo.listJobs()) {
    if (job.status !== "done" || job.catalogueHash) continue;
    const debugPath = path.join(jobDir(job.fileHash), ARTIFACTS.debug);
    if (!(await exists(debugPath))) continue;
    const hash = ((await readJson<DebugReport>(debugPath)).config as { catalogueHash?: unknown } | undefined)?.catalogueHash;
    if (typeof hash === "string") repo.setCatalogueHash(job.id, hash);
  }
}

// PROVISIONAL
jobsRouter.post("/api/jobs", upload.single("video"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "multipart field 'video' is required" });
    // Hashed while it streamed in (see lib/uploads.ts); the fallback covers any other storage engine.
    const hash = (req.file as HashedFile).sha256 ?? (await hashFile(req.file.path));
    const dir = jobDir(hash);
    await fs.mkdir(dir, { recursive: true });
    if (await findSourceVideo(dir)) {
      await fs.rm(req.file.path, { force: true });
    } else {
      const ext = path.extname(req.file.originalname).toLowerCase() || ".mp4";
      await fs.rename(req.file.path, path.join(dir, `source${ext}`));
    }

    const { job, outcome } = getRepo().enqueueUpload({
      fileHash: hash,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
      maxAttempts: config.queue.maxAttempts,
      requester: requester(req),
    });
    // Kept so the folder can be re-imported if the database is ever lost.
    await writeJson(path.join(dir, "job.json"), { originalName: job.originalName, createdAt: job.createdAt });
    if (outcome !== "already-active") queueSignal.notify();
    res.json({ job } satisfies CreateJobResponse);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL
jobsRouter.get("/api/jobs", (_req, res) => {
  res.json({ jobs: getRepo().listJobs().map(withStaleFlag) } satisfies ListJobsResponse);
});

/** Keeps idle connections open through proxies that close silent streams. */
const SSE_PING_MS = 25_000;

// PROVISIONAL: live job updates (Server-Sent Events). ?jobId= limits the stream to one job.
jobsRouter.get("/api/events", (req, res) => {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: do not buffer the stream
  });
  const send = (e: JobStreamEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

  const repo = getRepo();
  const one = jobId ? repo.getJob(jobId) : undefined;
  send({ type: "snapshot", jobs: (jobId ? (one ? [one] : []) : repo.listJobs()).map(withStaleFlag) });

  const unsubscribe = subscribeJobEvents((e) => {
    if (!jobId || (e.type === "job" ? e.job.id : e.id) === jobId) send(e);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

const withJob = (id: string, res: Response): Job | undefined => {
  const job = getRepo().getJob(id);
  if (!job) res.status(404).json({ error: "job not found" });
  return job;
};

// PROVISIONAL: deletes the job's folder (source video, cached stages, outputs). The database row
// and its audit trail are kept, marked deleted.
jobsRouter.delete("/api/jobs/:id", async (req, res, next) => {
  try {
    // A running pipeline would keep writing into the folder we are removing.
    const r = getRepo().markDeleted(req.params.id, requester(req));
    if (r.error === "not-found") return res.status(404).json({ error: "job not found" });
    if (r.error === "running") return res.status(409).json({ error: "job is still processing" });
    await fs.rm(jobDir(r.fileHash!), { recursive: true, force: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL: manual retry of a failed job, with a fresh attempt budget.
jobsRouter.post("/api/jobs/:id/retry", (req, res) => {
  const r = getRepo().retry(req.params.id, config.queue.maxAttempts, requester(req));
  if (r.error === "not-found") return res.status(404).json({ error: "job not found" });
  if (r.error) return res.status(409).json({ error: r.error });
  queueSignal.notify();
  res.json({ job: r.job! } satisfies CreateJobResponse);
});

/** Re-queues every finished or failed job (after a catalogue change). Returns the re-queued ids. */
export function rerunAllJobs(reason: string, requester?: Requester): string[] {
  const repo = getRepo();
  const ids = repo.listJobs().filter((j) => repo.rerun(j.id, config.queue.maxAttempts, reason, requester)).map((j) => j.id);
  if (ids.length) queueSignal.notify();
  return ids;
}

// PROVISIONAL: re-run every processed video against the current brand catalogue.
jobsRouter.post("/api/jobs/rerun-all", (req, res) => {
  res.json({ requeuedJobs: rerunAllJobs("manual re-run with the current catalogue", requester(req)) });
});

// PROVISIONAL: attempts, the append-only event trail, and every model call with latency and cost.
jobsRouter.get("/api/jobs/:id/audit", (req, res) => {
  const audit = getRepo().getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: "job not found" });
  res.json(audit satisfies JobAuditResponse);
});

async function loadBreaks(job: Job): Promise<{ breaks: (Break & { brandName: string })[]; durationSec: number } | undefined> {
  const dir = jobDir(job.fileHash);
  const debugPath = path.join(dir, ARTIFACTS.debug);
  if (job.status !== "done" || !(await exists(debugPath))) return undefined;
  const debug = await readJson<DebugReport>(debugPath);
  const catalogue = await loadCatalogue();
  const nameOf = (id: string) => catalogue.brands.find((b) => b.id === id)?.name ?? id;
  return { durationSec: debug.meta.durationSec, breaks: debug.breaks.map((b) => ({ ...b, brandName: nameOf(b.brandId) })) };
}

// PROVISIONAL
jobsRouter.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const loaded = await loadBreaks(job);
    const base = `${config.publicBaseUrl}/api/jobs/${job.id}`;
    const body: GetJobResponse = {
      job: withStaleFlag(job),
      results: loaded && {
        videoUrl: `${base}/video`,
        vmapUrl: `${base}/vmap.xml`,
        debugUrl: `${base}/debug.json`,
        breaksUrl: `${base}/breaks.json`,
        ...loaded,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL: the structured slot list (organisers accept this in place of VMAP).
jobsRouter.get("/api/jobs/:id/breaks.json", async (req, res, next) => {
  try {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const loaded = await loadBreaks(job);
    if (!loaded) return res.status(409).json({ error: "job not finished" });
    const body: BreaksResponse = {
      jobId: job.id,
      durationSec: loaded.durationSec,
      breaks: loaded.breaks.map((b) => ({
        ...b,
        timeOffset: toTimeOffset(b.timeSec),
        vastUrl: vastUrl(config.publicBaseUrl, b),
        creativeUrl: creativeUrl(config.publicBaseUrl, b.brandId, b.creativeId),
      })),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL
for (const [route, file, type] of [
  ["vmap.xml", ARTIFACTS.vmap, "application/xml"],
  ["debug.json", ARTIFACTS.debug, "application/json"],
] as const) {
  jobsRouter.get(`/api/jobs/:id/${route}`, async (req, res) => {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const p = path.join(jobDir(job.fileHash), file);
    if (!(await exists(p))) return res.status(409).json({ error: "job not finished" });
    res.type(type).sendFile(p);
  });
}

// PROVISIONAL: range-capable video stream for the player.
jobsRouter.get("/api/jobs/:id/video", async (req, res) => {
  const job = withJob(req.params.id, res);
  if (!job) return;
  const video = await findSourceVideo(jobDir(job.fileHash));
  if (!video) return res.status(404).json({ error: "video missing" });
  res.sendFile(video, { acceptRanges: true });
});

