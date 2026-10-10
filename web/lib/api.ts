// Typed client for the server API. Endpoint shapes are PROVISIONAL (see shared/src/api.ts)
// until API_SPEC.md exists.
import type {
  BrandChangeResponse,
  CreateJobResponse,
  GetJobResponse,
  ImportCatalogueResponse,
  ImportProgress,
  ImportStartedResponse,
  Job,
  JobAuditResponse,
  JobStreamEvent,
  ListBrandsResponse,
  ListJobsResponse,
} from "shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listJobs = () => getJson<ListJobsResponse>("/api/jobs");
export const getJob = (id: string) => getJson<GetJobResponse>(`/api/jobs/${encodeURIComponent(id)}`);

/** Every API call this job made: cost and count by provider/model, by pipeline stage, and by what
 *  the call was for (e.g. "placement chunk N"). */
export const getJobAudit = (id: string) => getJson<JobAuditResponse>(`/api/jobs/${encodeURIComponent(id)}/audit`);

/**
 * Live job updates over Server-Sent Events. The browser reconnects by itself after a drop, and
 * every (re)connect starts with a fresh snapshot, so the caller's state is always complete.
 * Returns a function that closes the stream.
 */
export function subscribeJobs(
  opts: { jobId?: string },
  on: {
    snapshot: (jobs: Job[]) => void;
    job: (job: Job) => void;
    deleted: (id: string) => void;
    connection?: (connected: boolean) => void;
  },
): () => void {
  const qs = opts.jobId ? `?jobId=${encodeURIComponent(opts.jobId)}` : "";
  const es = new EventSource(`${API_URL}/api/events${qs}`);
  const parse = (e: MessageEvent) => JSON.parse(e.data) as JobStreamEvent;
  es.addEventListener("snapshot", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "snapshot") on.snapshot(ev.jobs);
    on.connection?.(true);
  });
  es.addEventListener("job", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "job") on.job(ev.job);
  });
  es.addEventListener("deleted", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "deleted") on.deleted(ev.id);
  });
  es.onerror = () => on.connection?.(false);
  return () => es.close();
}

export async function retryJob(id: string): Promise<CreateJobResponse> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `retry failed: HTTP ${res.status}`);
  return body as CreateJobResponse;
}

export const listBrands = () => getJson<ListBrandsResponse>("/api/brands");

async function sendJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${path}: HTTP ${res.status}`);
  return body as T;
}

/** Creates a brand (multipart: fields + optional ad videos). Takes up to a minute when generating creatives. */
export const createBrand = (form: FormData) => sendJson<BrandChangeResponse>("/api/brands", { method: "POST", body: form });

/**
 * Imports a brands.json-format file (multipart: catalogue, mode). The server imports in the
 * background; this polls it and reports progress until it is done. Rejects with the server's message.
 */
export async function importCatalogue(form: FormData, onProgress: (p: ImportProgress) => void): Promise<ImportCatalogueResponse> {
  const { importId } = await sendJson<ImportStartedResponse>("/api/brands/import", { method: "POST", body: form });
  let failedPolls = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    let p: ImportProgress;
    try {
      p = await getJson<ImportProgress>(`/api/brands/import/${encodeURIComponent(importId)}`);
      failedPolls = 0;
    } catch (err) {
      // One dropped request must not abandon an import that is still running on the server.
      if (++failedPolls >= 5) throw new Error(`Lost contact with the server while importing: ${(err as Error).message}`);
      continue;
    }
    onProgress(p);
    if (p.status === "error") throw new Error(p.error ?? "Import failed");
    if (p.status === "done" && p.result) return p.result;
  }
}

export const deleteBrand = (id: string) =>
  sendJson<BrandChangeResponse>(`/api/brands/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Re-processes every video against the current catalogue (cached stages are reused). */
export const rerunAllJobs = () => sendJson<{ requeuedJobs: string[] }>("/api/jobs/rerun-all", { method: "POST" });

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `delete failed: HTTP ${res.status}`);
  }
}

/** Multipart upload with progress (fetch has no upload progress, so XHR). */
export function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<CreateJobResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/jobs`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    // The last progress event is not guaranteed to land on exactly 1, and the request is not over
    // when the bytes are: the server still hashes the file and creates the job. Reporting 1 here
    // lets the page say so rather than leaving a full bar that looks stuck.
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as CreateJobResponse);
        else reject(new Error(body?.error ?? `upload failed: HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`upload failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed: network error (is the server running?)"));
    const form = new FormData();
    form.append("video", file);
    xhr.send(form);
  });
}

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
