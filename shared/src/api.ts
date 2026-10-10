// PROVISIONAL: endpoint contracts until API_SPEC.md lands.
import type { AuditEvent, CallKindUsage, Job, JobAttempt, ModelCall, ModelUsage, StageUsage } from "./job";
import type { Break } from "./pipeline";

/** POST /api/jobs  (multipart, field "video") */
export interface CreateJobResponse {
  job: Job;
}

/** GET /api/jobs */
export interface ListJobsResponse {
  jobs: Job[];
}

/** GET /api/jobs/:id */
export interface GetJobResponse {
  job: Job;
  /** Present once the outputs stage is done. */
  results?: JobResults;
}

export interface JobResults {
  videoUrl: string;
  vmapUrl: string;
  debugUrl: string;
  breaksUrl: string;
  durationSec: number;
  breaks: (Break & { brandName: string })[];
}

/** GET /api/jobs/:id/breaks.json — the structured slot list (VMAP alternative the organisers accept). */
export interface BreaksResponse {
  jobId: string;
  durationSec: number;
  breaks: (Break & { brandName: string; timeOffset: string; vastUrl: string; creativeUrl: string })[];
}

/** GET /api/jobs/:id/audit */
export interface JobAuditResponse {
  jobId: string;
  attempts: JobAttempt[];
  events: AuditEvent[];
  /** The attempt that usage/byStage/byKind/totals describe. Undefined before the first attempt. */
  attempt?: number;
  /** The calls that attempt made, by provider+model. */
  usage: ModelUsage[];
  /** The same calls, by pipeline stage (ingest, transcribe, match, ...). */
  byStage: StageUsage[];
  /** The same calls again, by what each call was for (e.g. "placement chunk N", "story", "listen ..."). */
  byKind: CallKindUsage[];
  /** That one attempt, not the job's lifetime — a retry or re-upload keeps the job id. Zero calls
   *  means this attempt ran entirely from cache, and there is no cost to show for it. */
  totals: { calls: number; errors: number; costUsd: number };
  /** Most recent calls first. */
  modelCalls: ModelCall[];
}

/**
 * GET /api/events[?jobId=]  (Server-Sent Events). On connect: `snapshot` with the current
 * jobs (or the one job), then `job` whenever a job changes and `deleted` when one is removed.
 * A reconnect gets a fresh snapshot, so nothing missed while offline is lost.
 */
export type JobStreamEvent =
  | { type: "snapshot"; jobs: Job[] }
  | { type: "job"; job: Job }
  | { type: "deleted"; id: string };

/** GET /api/brands */
export interface BrandSummary {
  id: string;
  name: string;
  category: string;
  targetContexts: string[];
  negativeContexts: string[];
  headline?: string;
  tagline?: string;
  creatives: { id: string; durationSec: number; language: string; url: string }[];
}

export interface ListBrandsResponse {
  brands: BrandSummary[];
  /** Hash of the current catalogue; a job processed with a different one is stale. */
  catalogueHash: string;
}

/** POST /api/brands, DELETE /api/brands/:id: the catalogue change and the jobs re-queued because of it. */
export interface BrandChangeResponse {
  brand?: BrandSummary;
  requeuedJobs: string[];
}

/** POST /api/brands/import: the import runs in the background; poll GET /api/brands/import/:importId. */
export interface ImportStartedResponse {
  importId: string;
}

/** GET /api/brands/import/:importId */
export interface ImportProgress {
  status: "running" | "done" | "error";
  /** "checking": names are checked to be synthetic. "brands": ads are made brand by brand. "saving": the catalogue is written. */
  phase: "checking" | "brands" | "saving";
  /** Brands in the file that are new or changed. */
  total: number;
  /** Names of the brands finished so far, in order. */
  ready: string[];
  /** The brand being worked on now. */
  working?: string;
  /** Set when status is "done". */
  result?: ImportCatalogueResponse;
  /** Set when status is "error". */
  error?: string;
}

/** The result of an import. */
export interface ImportCatalogueResponse {
  added: string[];
  updated: string[];
  removed: string[];
  /** Creatives whose files were missing and got a title-card ad. */
  generatedCreatives: number;
  requeuedJobs: string[];
}
