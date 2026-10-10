// Every read and write of the SQLite store. Synchronous (node:sqlite); state changes that span
// rows run in one IMMEDIATE transaction, so a job can never be claimed by two workers.
import { DatabaseSync } from "node:sqlite";
import {
  STAGES,
  type AuditActor,
  type AuditEvent,
  type CallKindUsage,
  type Job,
  type JobAttempt,
  type JobAuditResponse,
  type JobStatus,
  type ModelCall,
  type StageName,
  type StageStatus,
} from "shared";
import type { RawBrandData } from "../catalogue/loader";
import { MIGRATIONS } from "./schema";

type Row = Record<string, any>;
type Clock = () => Date;
export type Repo = ReturnType<typeof createRepo>;
export type BrandSource = "seed" | "ui" | "import";

export interface CatalogueEvent {
  id: number;
  at: string;
  actor: "api" | "system";
  type: string;
  brandId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

/** Who asked for an API action, for the audit trail. */
export interface Requester {
  ip?: string;
  userAgent?: string;
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/**
 * @param onChange called with the ids of jobs whose visible state changed, after the write
 *   commits (drives the live-update stream). Heartbeats and audit-only writes do not count.
 */
export function createRepo(db: DatabaseSync, clock: Clock = () => new Date(), onChange?: (jobIds: string[]) => void) {
  const now = () => clock().toISOString();
  const later = (sec: number) => new Date(clock().getTime() + sec * 1000).toISOString();

  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const q = {
    job: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    jobByHash: db.prepare("SELECT * FROM jobs WHERE file_hash = ?"),
    stages: db.prepare("SELECT * FROM job_stages WHERE job_id = ?"),
    audit: db.prepare(
      `INSERT INTO audit_events (job_id, at, actor, type, attempt, ip, user_agent, detail)
       VALUES (@jobId, @at, @actor, @type, @attempt, @ip, @userAgent, @detail)`,
    ),
  };

  function audit(e: {
    jobId: string;
    actor: AuditActor;
    type: string;
    attempt?: number;
    requester?: Requester;
    detail?: Record<string, unknown>;
  }) {
    q.audit.run({
      jobId: e.jobId,
      at: now(),
      actor: e.actor,
      type: e.type,
      attempt: nul(e.attempt),
      ip: nul(e.requester?.ip),
      userAgent: nul(e.requester?.userAgent),
      detail: e.detail ? JSON.stringify(e.detail) : null,
    });
  }

  function toJob(r: Row): Job {
    const stages = Object.fromEntries(STAGES.map((s) => [s, { state: "pending" }])) as Record<StageName, StageStatus>;
    for (const s of q.stages.all(r.id) as Row[]) {
      if (!(STAGES as readonly string[]).includes(s.stage)) continue;
      stages[s.stage as StageName] = {
        state: s.state,
        startedAt: opt(s.started_at),
        finishedAt: opt(s.finished_at),
        note: opt(s.note),
      };
    }
    return {
      id: r.id,
      fileHash: r.file_hash,
      originalName: r.original_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      status: r.status as JobStatus,
      stages,
      error: opt(r.last_error),
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      nextRunAt: opt(r.next_run_at),
      startedAt: opt(r.started_at),
      finishedAt: opt(r.finished_at),
      sizeBytes: opt(r.size_bytes),
      durationSec: opt(r.duration_sec),
      breakCount: opt(r.break_count),
      catalogueHash: opt(r.catalogue_hash),
    };
  }

  const resetStages = (jobId: string) => db.prepare("DELETE FROM job_stages WHERE job_id = ?").run(jobId);

  /** Puts a job (back) in the queue with a fresh retry budget. */
  function requeue(r: Row, maxAttempts: number, extra: Record<string, unknown> = {}) {
    db.prepare(
      `UPDATE jobs SET status = 'queued', max_attempts = @max, next_run_at = @now, last_error = NULL,
         locked_by = NULL, heartbeat_at = NULL, finished_at = NULL, deleted_at = NULL,
         original_name = COALESCE(@name, original_name), size_bytes = COALESCE(@size, size_bytes),
         mime_type = COALESCE(@mime, mime_type), updated_at = @now
       WHERE id = @id`,
    ).run({
      id: r.id,
      max: r.attempts + maxAttempts,
      now: now(),
      name: nul(extra.originalName as string | undefined),
      size: nul(extra.sizeBytes as number | undefined),
      mime: nul(extra.mimeType as string | undefined),
    });
    resetStages(r.id);
  }

  const api = {
    audit,

    getJob(id: string): Job | undefined {
      const r = q.job.get(id) as Row | undefined;
      return r && r.status !== "deleted" ? toJob(r) : undefined;
    },

    listJobs(): Job[] {
      return (db.prepare("SELECT * FROM jobs WHERE status != 'deleted' ORDER BY created_at DESC").all() as Row[]).map(toJob);
    },

    /**
     * An upload. New file → new job. Same file again → re-run (cheap: stages are cached),
     * or restore it if it was deleted. Already queued/running → left alone.
     */
    enqueueUpload(u: {
      fileHash: string;
      originalName: string;
      sizeBytes?: number;
      mimeType?: string;
      maxAttempts: number;
      requester?: Requester;
    }): { job: Job; outcome: "created" | "requeued" | "restored" | "already-active" } {
      return tx(() => {
        const existing = q.jobByHash.get(u.fileHash) as Row | undefined;
        const detail = { originalName: u.originalName, sizeBytes: u.sizeBytes, mimeType: u.mimeType };
        if (!existing) {
          const t = now();
          db.prepare(
            `INSERT INTO jobs (id, file_hash, original_name, size_bytes, mime_type, status, attempts, max_attempts,
               next_run_at, created_at, updated_at)
             VALUES (@id, @hash, @name, @size, @mime, 'queued', 0, @max, @t, @t, @t)`,
          ).run({
            id: u.fileHash.slice(0, 16),
            hash: u.fileHash,
            name: u.originalName,
            size: nul(u.sizeBytes),
            mime: nul(u.mimeType),
            max: u.maxAttempts,
            t,
          });
          const id = u.fileHash.slice(0, 16);
          audit({ jobId: id, actor: "api", type: "job.created", requester: u.requester, detail });
          audit({ jobId: id, actor: "api", type: "job.queued", requester: u.requester });
          return { job: toJob(q.job.get(id) as Row), outcome: "created" };
        }
        if (["queued", "running", "retrying"].includes(existing.status)) {
          audit({ jobId: existing.id, actor: "api", type: "upload.duplicate", requester: u.requester, detail: { status: existing.status } });
          return { job: toJob(existing), outcome: "already-active" };
        }
        const restored = existing.status === "deleted";
        requeue(existing, u.maxAttempts, detail);
        audit({
          jobId: existing.id,
          actor: "api",
          type: restored ? "job.restored" : "job.requeued",
          requester: u.requester,
          detail: { ...detail, previousStatus: existing.status, reason: "re-upload" },
        });
        return { job: toJob(q.job.get(existing.id) as Row), outcome: restored ? "restored" : "requeued" };
      });
    },

    /** Registers an artifact folder from before the database existed. Never queues work by itself. */
    importLegacy(l: { fileHash: string; originalName: string; createdAt: string; finished: boolean; maxAttempts: number }) {
      return tx(() => {
        if (q.jobByHash.get(l.fileHash)) return false;
        const id = l.fileHash.slice(0, 16);
        db.prepare(
          `INSERT INTO jobs (id, file_hash, original_name, status, attempts, max_attempts, last_error, created_at, updated_at)
           VALUES (@id, @hash, @name, @status, 0, @max, @err, @created, @t)`,
        ).run({
          id,
          hash: l.fileHash,
          name: l.originalName,
          status: l.finished ? "done" : "error",
          max: l.maxAttempts,
          err: l.finished ? null : "Found unfinished from before the job queue existed. Retry to process it.",
          created: l.createdAt,
          t: now(),
        });
        if (l.finished) {
          const ins = db.prepare("INSERT INTO job_stages (job_id, stage, state) VALUES (?, ?, 'cached')");
          for (const s of STAGES) ins.run(id, s);
        }
        audit({ jobId: id, actor: "system", type: "job.imported", detail: { finished: l.finished } });
        return true;
      });
    },

    /** Takes the next due job, if any, for this worker and opens a new attempt. */
    claimNext(workerId: string): { id: string; fileHash: string; attempt: number } | undefined {
      return tx(() => {
        const r = db
          .prepare(
            `SELECT * FROM jobs WHERE status IN ('queued','retrying') AND (next_run_at IS NULL OR next_run_at <= ?)
             ORDER BY next_run_at, created_at LIMIT 1`,
          )
          .get(now()) as Row | undefined;
        if (!r) return undefined;
        const attempt = r.attempts + 1;
        const t = now();
        db.prepare(
          `UPDATE jobs SET status = 'running', attempts = @attempt, locked_by = @worker, heartbeat_at = @t,
             started_at = @t, finished_at = NULL, next_run_at = NULL, updated_at = @t WHERE id = @id`,
        ).run({ id: r.id, attempt, worker: workerId, t });
        db.prepare(
          `INSERT INTO job_attempts (job_id, attempt, worker_id, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
        ).run(r.id, attempt, workerId, t);
        resetStages(r.id);
        audit({ jobId: r.id, actor: "worker", type: "attempt.started", attempt, detail: { workerId, maxAttempts: r.max_attempts } });
        return { id: r.id, fileHash: r.file_hash, attempt };
      });
    },

    heartbeat(jobId: string, workerId: string) {
      db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running' AND locked_by = ?").run(
        now(),
        jobId,
        workerId,
      );
    },

    setStage(jobId: string, attempt: number, stage: StageName, s: StageStatus) {
      const duration = s.startedAt && s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : null;
      db.prepare(
        `INSERT INTO job_stages (job_id, stage, state, attempt, started_at, finished_at, duration_ms, note)
         VALUES (@job, @stage, @state, @attempt, @started, @finished, @duration, @note)
         ON CONFLICT (job_id, stage) DO UPDATE SET state = excluded.state, attempt = excluded.attempt,
           started_at = excluded.started_at, finished_at = excluded.finished_at,
           duration_ms = excluded.duration_ms, note = excluded.note`,
      ).run({
        job: jobId,
        stage,
        state: s.state,
        attempt,
        started: nul(s.startedAt),
        finished: nul(s.finishedAt),
        duration,
        note: nul(s.note),
      });
      if (s.state === "error") {
        audit({ jobId, actor: "worker", type: "stage.failed", attempt, detail: { stage, error: s.note } });
      }
    },

    /** Closes a successful attempt. Ignored if this worker no longer holds the job. */
    succeed(
      jobId: string,
      workerId: string,
      attempt: number,
      result: { durationSec?: number; breakCount?: number; catalogueHash?: string },
    ) {
      return tx(() => {
        const t = now();
        const changed = db
          .prepare(
            `UPDATE jobs SET status = 'done', locked_by = NULL, heartbeat_at = NULL, last_error = NULL,
               finished_at = @t, updated_at = @t, duration_sec = @dur, break_count = @breaks,
               catalogue_hash = COALESCE(@cat, catalogue_hash)
             WHERE id = @id AND status = 'running' AND locked_by = @worker`,
          )
          .run({
            id: jobId,
            worker: workerId,
            t,
            dur: nul(result.durationSec),
            breaks: nul(result.breakCount),
            cat: nul(result.catalogueHash),
          }).changes;
        if (!changed) return false;
        db.prepare(
          "UPDATE job_attempts SET status = 'succeeded', finished_at = ? WHERE job_id = ? AND attempt = ?",
        ).run(t, jobId, attempt);
        audit({ jobId, actor: "worker", type: "attempt.succeeded", attempt, detail: result });
        return true;
      });
    },

    /**
     * Closes a failed attempt, then schedules a retry after `retryDelaySec` if the error is
     * retryable and attempts remain; otherwise the job fails for good.
     */
    fail(
      jobId: string,
      workerId: string,
      attempt: number,
      f: { error: string; stage?: string; retryable: boolean; retryDelaySec: number },
    ): "retrying" | "error" | "ignored" {
      return tx(() => {
        const r = q.job.get(jobId) as Row | undefined;
        if (!r || r.status !== "running" || r.locked_by !== workerId) return "ignored";
        const t = now();
        const retry = f.retryable && r.attempts < r.max_attempts;
        db.prepare(
          `UPDATE jobs SET status = @status, next_run_at = @next, last_error = @err, locked_by = NULL,
             heartbeat_at = NULL, finished_at = @finished, updated_at = @t WHERE id = @id`,
        ).run({
          id: jobId,
          status: retry ? "retrying" : "error",
          next: retry ? later(f.retryDelaySec) : null,
          err: f.error.slice(0, 2000),
          finished: retry ? null : t,
          t,
        });
        db.prepare(
          `UPDATE job_attempts SET status = 'failed', finished_at = ?, error = ?, error_stage = ?, retryable = ?
           WHERE job_id = ? AND attempt = ?`,
        ).run(t, f.error.slice(0, 2000), nul(f.stage), f.retryable ? 1 : 0, jobId, attempt);
        audit({
          jobId,
          actor: "worker",
          type: "attempt.failed",
          attempt,
          detail: { error: f.error.slice(0, 500), stage: f.stage, retryable: f.retryable },
        });
        audit(
          retry
            ? { jobId, actor: "worker", type: "job.retry_scheduled", attempt, detail: { inSec: f.retryDelaySec, attemptsLeft: r.max_attempts - r.attempts } }
            : { jobId, actor: "worker", type: "job.failed", attempt, detail: { reason: f.retryable ? "no attempts left" : "error is not retryable" } },
        );
        return retry ? "retrying" : "error";
      });
    },

    /**
     * Running jobs whose worker stopped sending heartbeats (process crashed or was restarted)
     * are interrupted and rescheduled, or failed if they have no attempts left.
     */
    recoverStale(staleAfterSec: number, retryDelaySec: (attempt: number) => number, ownedBy?: string): string[] {
      return tx(() => {
        // ownedBy: a worker shutting down hands back its own jobs at once, heartbeat or not.
        const stale = (
          ownedBy
            ? db.prepare("SELECT * FROM jobs WHERE status = 'running' AND locked_by = ?").all(ownedBy)
            : db
                .prepare("SELECT * FROM jobs WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)")
                .all(later(-staleAfterSec))
        ) as Row[];
        const t = now();
        for (const r of stale) {
          const retry = r.attempts < r.max_attempts;
          const err = ownedBy
            ? `interrupted: worker ${ownedBy} shut down`
            : `interrupted: worker ${r.locked_by ?? "?"} stopped responding`;
          db.prepare(
            `UPDATE jobs SET status = @status, next_run_at = @next, last_error = @err, locked_by = NULL,
               heartbeat_at = NULL, finished_at = @finished, updated_at = @t WHERE id = @id`,
          ).run({
            id: r.id,
            status: retry ? "retrying" : "error",
            next: retry ? later(retryDelaySec(r.attempts)) : null,
            err,
            finished: retry ? null : t,
            t,
          });
          db.prepare(
            "UPDATE job_attempts SET status = 'interrupted', finished_at = ?, error = ?, retryable = 1 WHERE job_id = ? AND attempt = ?",
          ).run(t, err, r.id, r.attempts);
          audit({ jobId: r.id, actor: "system", type: "attempt.interrupted", attempt: r.attempts, detail: { workerId: r.locked_by } });
          audit({ jobId: r.id, actor: "system", type: retry ? "job.retry_scheduled" : "job.failed", attempt: r.attempts });
        }
        return stale.map((r) => r.id);
      });
    },

    /** Manual retry of a failed job, with a fresh attempt budget. */
    retry(jobId: string, maxAttempts: number, requester?: Requester): { job?: Job; error?: string } {
      return tx(() => {
        const r = q.job.get(jobId) as Row | undefined;
        if (!r || r.status === "deleted") return { error: "not-found" };
        if (r.status !== "error") return { error: `job is ${r.status}; only failed jobs can be retried` };
        requeue(r, maxAttempts);
        audit({ jobId, actor: "api", type: "job.requeued", requester, detail: { reason: "manual retry" } });
        return { job: toJob(q.job.get(jobId) as Row) };
      });
    },

    /**
     * Re-run a finished or failed job (e.g. after the brand catalogue changed). Cached stages make
     * it cheap; only what depends on the change re-runs. Queued/running jobs are left alone.
     */
    rerun(jobId: string, maxAttempts: number, reason: string, requester?: Requester): boolean {
      return tx(() => {
        const r = q.job.get(jobId) as Row | undefined;
        if (!r || !["done", "error"].includes(r.status)) return false;
        requeue(r, maxAttempts);
        audit({ jobId, actor: "api", type: "job.requeued", requester, detail: { reason, previousStatus: r.status } });
        return true;
      });
    },

    /** Backfill for jobs finished before catalogue hashes were stored. */
    setCatalogueHash(jobId: string, hash: string) {
      db.prepare("UPDATE jobs SET catalogue_hash = ? WHERE id = ? AND catalogue_hash IS NULL").run(hash, jobId);
    },

    /** Soft delete: the row and its audit trail stay; the job disappears from the API. */
    markDeleted(jobId: string, requester?: Requester): { fileHash?: string; error?: string } {
      return tx(() => {
        const r = q.job.get(jobId) as Row | undefined;
        if (!r || r.status === "deleted") return { error: "not-found" };
        if (r.status === "running") return { error: "running" };
        const t = now();
        db.prepare(
          "UPDATE jobs SET status = 'deleted', deleted_at = @t, updated_at = @t, next_run_at = NULL WHERE id = @id",
        ).run({ id: jobId, t });
        audit({ jobId, actor: "api", type: "job.deleted", requester, detail: { previousStatus: r.status, originalName: r.original_name } });
        return { fileHash: r.file_hash };
      });
    },

    // ---- Brand catalogue

    /** The catalogue in JSON shape, in catalogue order. */
    listBrandsRaw(): RawBrandData[] {
      const creatives = db.prepare("SELECT * FROM brand_creatives ORDER BY brand_id, position").all() as Row[];
      return (db.prepare("SELECT * FROM brands ORDER BY position").all() as Row[]).map((b) => ({
        brand_id: b.id,
        display_name: b.name,
        category: b.category,
        target_contexts: JSON.parse(b.target_contexts),
        negative_contexts: JSON.parse(b.negative_contexts),
        ...(b.headline !== null && { headline: b.headline }),
        ...(b.tagline !== null && { tagline: b.tagline }),
        creatives: creatives
          .filter((c) => c.brand_id === b.id)
          .map((c) => ({ id: c.id, duration_sec: c.duration_sec, language: c.language, url: c.url })),
      }));
    },

    brandSources(): Record<string, { source: BrandSource; createdAt: string; updatedAt: string }> {
      return Object.fromEntries(
        (db.prepare("SELECT id, source, created_at, updated_at FROM brands").all() as Row[]).map((r) => [
          r.id,
          { source: r.source, createdAt: r.created_at, updatedAt: r.updated_at },
        ]),
      );
    },

    /**
     * Writes the whole catalogue in one transaction (the caller has validated it). Brands keep
     * their created_at and source; updated_at moves only for brands whose content changed.
     */
    replaceCatalogue(list: RawBrandData[], sourceForNew: BrandSource) {
      tx(() => {
        const before = new Map(
          (db.prepare("SELECT * FROM brands").all() as Row[]).map((r) => [r.id as string, r]),
        );
        const oldRaw = new Map(api.listBrandsRaw().map((b) => [b.brand_id, JSON.stringify(b)]));
        const t = now();
        db.exec("DELETE FROM brand_creatives; DELETE FROM brands;");
        const insB = db.prepare(
          `INSERT INTO brands (id, position, name, category, target_contexts, negative_contexts, headline, tagline, source, created_at, updated_at)
           VALUES (@id, @pos, @name, @cat, @tc, @nc, @hl, @tl, @src, @created, @updated)`,
        );
        const insC = db.prepare(
          "INSERT INTO brand_creatives (brand_id, id, position, duration_sec, language, url) VALUES (?, ?, ?, ?, ?, ?)",
        );
        list.forEach((b, pos) => {
          const prev = before.get(b.brand_id);
          const changed = oldRaw.get(b.brand_id) !== JSON.stringify(b);
          insB.run({
            id: b.brand_id,
            pos,
            name: b.display_name,
            cat: b.category ?? "",
            tc: JSON.stringify(b.target_contexts ?? []),
            nc: JSON.stringify(b.negative_contexts ?? []),
            hl: nul(b.headline),
            tl: nul(b.tagline),
            src: prev?.source ?? sourceForNew,
            created: prev?.created_at ?? t,
            updated: prev && !changed ? prev.updated_at : t,
          });
          b.creatives.forEach((c, i) => insC.run(b.brand_id, c.id, i, c.duration_sec, c.language ?? "", c.url));
        });
      });
    },

    catalogueEvent(e: { actor: "api" | "system"; type: string; brandId?: string; requester?: Requester; detail?: Record<string, unknown> }) {
      db.prepare(
        `INSERT INTO catalogue_events (at, actor, type, brand_id, ip, user_agent, detail)
         VALUES (@at, @actor, @type, @brand, @ip, @ua, @detail)`,
      ).run({
        at: now(),
        actor: e.actor,
        type: e.type,
        brand: nul(e.brandId),
        ip: nul(e.requester?.ip),
        ua: nul(e.requester?.userAgent),
        detail: e.detail ? JSON.stringify(e.detail) : null,
      });
    },

    listCatalogueEvents(limit = 100): CatalogueEvent[] {
      return (db.prepare("SELECT * FROM catalogue_events ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        type: e.type,
        brandId: opt(e.brand_id),
        ip: opt(e.ip),
        detail: e.detail ? JSON.parse(e.detail) : undefined,
      }));
    },

    recordModelCall(c: Omit<ModelCall, "id">) {
      db.prepare(
        `INSERT INTO model_calls (job_id, attempt, stage, provider, model, label, started_at, latency_ms, ok,
           http_status, error, input_tokens, output_tokens, audio_sec, cost_usd)
         VALUES (@job, @attempt, @stage, @provider, @model, @label, @started, @latency, @ok,
           @http, @error, @inTok, @outTok, @audio, @cost)`,
      ).run({
        job: nul(c.jobId),
        attempt: nul(c.attempt),
        stage: nul(c.stage),
        provider: c.provider,
        model: c.model,
        label: nul(c.label),
        started: c.startedAt,
        latency: Math.round(c.latencyMs),
        ok: c.ok ? 1 : 0,
        http: nul(c.httpStatus),
        error: c.error ? c.error.slice(0, 1000) : null,
        inTok: nul(c.inputTokens),
        outTok: nul(c.outputTokens),
        audio: nul(c.audioSec),
        cost: nul(c.costUsd),
      });
    },

    getAudit(jobId: string, recentCalls = 200): JobAuditResponse | undefined {
      const r = q.job.get(jobId) as Row | undefined;
      if (!r || r.status === "deleted") return undefined;
      const attempts = (db.prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt").all(jobId) as Row[]).map(
        (a): JobAttempt => ({
          attempt: a.attempt,
          workerId: a.worker_id,
          status: a.status,
          startedAt: a.started_at,
          finishedAt: opt(a.finished_at),
          error: opt(a.error),
          errorStage: opt(a.error_stage),
          retryable: a.retryable === null ? undefined : !!a.retryable,
        }),
      );
      const events = (db.prepare("SELECT * FROM audit_events WHERE job_id = ? ORDER BY id").all(jobId) as Row[]).map(
        (e): AuditEvent => ({
          id: e.id,
          jobId: e.job_id,
          at: e.at,
          actor: e.actor,
          type: e.type,
          attempt: opt(e.attempt),
          ip: opt(e.ip),
          userAgent: opt(e.user_agent),
          detail: e.detail ? JSON.parse(e.detail) : undefined,
        }),
      );
      // Cost is reported for THIS attempt only, never the job's lifetime. A job id is the video's
      // hash, so a re-upload or a retry reuses it and model_calls keeps accumulating: summing the
      // whole table answers "what has this video ever cost", when the panel is asked "what did this
      // run cost". An attempt that called nothing — every stage served from cache — therefore reports
      // nothing, and the UI hides the section rather than showing an earlier attempt's bill.
      // jobs.attempts is the attempt the worker is on (or finished on). The fallback covers a job
      // whose calls were recorded without the counter moving — nothing the queue does, but it keeps
      // a bookkeeping mismatch from silently hiding calls that exist.
      const latestAttempt = (r.attempts ||
        ((db.prepare("SELECT MAX(attempt) AS a FROM model_calls WHERE job_id = ?").get(jobId) as Row | undefined)?.a ?? null)) as
        | number
        | null;
      const usage = (
        db
          .prepare(
            `SELECT provider, model, COUNT(*) AS calls, SUM(1 - ok) AS errors, SUM(latency_ms) AS latency,
               COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(audio_sec), 0) AS audio
             FROM model_calls WHERE job_id = ? AND attempt IS ? GROUP BY provider, model ORDER BY cost DESC`,
          )
          .all(jobId, latestAttempt) as Row[]
      ).map((u) => ({
        provider: u.provider,
        model: u.model,
        calls: u.calls,
        errors: u.errors,
        totalLatencyMs: u.latency,
        costUsd: u.cost,
        audioSec: u.audio,
      }));
      const byStage = (
        db
          .prepare(
            `SELECT COALESCE(stage, '(none)') AS stage, COUNT(*) AS calls, SUM(1 - ok) AS errors, SUM(latency_ms) AS latency,
               COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(audio_sec), 0) AS audio
             FROM model_calls WHERE job_id = ? AND attempt IS ? GROUP BY stage ORDER BY cost DESC`,
          )
          .all(jobId, latestAttempt) as Row[]
      ).map((s) => ({
        stage: s.stage,
        calls: s.calls,
        errors: s.errors,
        totalLatencyMs: s.latency,
        costUsd: s.cost,
        audioSec: s.audio,
      }));
      // Grouped in JS, not SQL: a call's label (e.g. "placement chunk 4") identifies WHAT it was for,
      // but each chunk/candidate/attempt gets its own number, so calls of the same kind never share an
      // exact label. Blanking digits merges "placement chunk 4" and "placement chunk 11" into one row
      // without a hand-kept list of label patterns to keep in sync as labels change.
      const byKindMap = new Map<string, CallKindUsage>();
      for (const c of db
        .prepare("SELECT label, provider, model, ok, cost_usd, audio_sec FROM model_calls WHERE job_id = ? AND attempt IS ?")
        .all(jobId, latestAttempt) as Row[]) {
        const kind = (c.label ?? "(unlabeled)").replace(/\d+/g, "N");
        const key = `${kind}\0${c.provider}\0${c.model}`;
        const row = byKindMap.get(key) ?? { kind, provider: c.provider, model: c.model, calls: 0, errors: 0, costUsd: 0, audioSec: 0 };
        row.calls++;
        if (!c.ok) row.errors++;
        row.costUsd += c.cost_usd ?? 0;
        row.audioSec += c.audio_sec ?? 0;
        byKindMap.set(key, row);
      }
      const byKind = [...byKindMap.values()].sort((a, b) => b.costUsd - a.costUsd);
      const modelCalls = (
        db.prepare("SELECT * FROM model_calls WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, recentCalls) as Row[]
      ).map(
        (c): ModelCall => ({
          id: c.id,
          jobId: c.job_id,
          attempt: opt(c.attempt),
          stage: opt(c.stage),
          provider: c.provider,
          model: c.model,
          label: opt(c.label),
          startedAt: c.started_at,
          latencyMs: c.latency_ms,
          ok: !!c.ok,
          httpStatus: opt(c.http_status),
          error: opt(c.error),
          inputTokens: opt(c.input_tokens),
          outputTokens: opt(c.output_tokens),
          audioSec: opt(c.audio_sec),
          costUsd: opt(c.cost_usd),
        }),
      );
      return {
        jobId,
        attempts,
        events,
        usage,
        byStage,
        byKind,
        attempt: latestAttempt ?? undefined,
        totals: {
          calls: usage.reduce((s, u) => s + u.calls, 0),
          errors: usage.reduce((s, u) => s + u.errors, 0),
          costUsd: usage.reduce((s, u) => s + u.costUsd, 0),
        },
        modelCalls,
      };
    },
  };

  if (!onChange) return api;
  const changed = <T>(r: T, ids: string[]): T => {
    if (ids.length) {
      try {
        onChange(ids);
      } catch (err) {
        console.warn(`[repo] change listener failed: ${(err as Error).message}`);
      }
    }
    return r;
  };
  return {
    ...api,
    enqueueUpload: (u: Parameters<typeof api.enqueueUpload>[0]) => {
      const r = api.enqueueUpload(u);
      return changed(r, r.outcome === "already-active" ? [] : [r.job.id]);
    },
    importLegacy: (l: Parameters<typeof api.importLegacy>[0]) => {
      const r = api.importLegacy(l);
      return changed(r, r ? [l.fileHash.slice(0, 16)] : []);
    },
    claimNext: (workerId: string) => {
      const r = api.claimNext(workerId);
      return changed(r, r ? [r.id] : []);
    },
    setStage: (...a: Parameters<typeof api.setStage>) => changed(api.setStage(...a), [a[0]]),
    succeed: (...a: Parameters<typeof api.succeed>) => {
      const r = api.succeed(...a);
      return changed(r, r ? [a[0]] : []);
    },
    fail: (...a: Parameters<typeof api.fail>) => {
      const r = api.fail(...a);
      return changed(r, r === "ignored" ? [] : [a[0]]);
    },
    recoverStale: (...a: Parameters<typeof api.recoverStale>) => {
      const ids = api.recoverStale(...a);
      return changed(ids, ids);
    },
    retry: (...a: Parameters<typeof api.retry>) => {
      const r = api.retry(...a);
      return changed(r, r.job ? [a[0]] : []);
    },
    rerun: (...a: Parameters<typeof api.rerun>) => {
      const r = api.rerun(...a);
      return changed(r, r ? [a[0]] : []);
    },
    markDeleted: (...a: Parameters<typeof api.markDeleted>) => {
      const r = api.markDeleted(...a);
      return changed(r, r.fileHash ? [a[0]] : []);
    },
  };
}
