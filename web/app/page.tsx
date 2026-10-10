"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoaderCircle, Play, Trash2 } from "lucide-react";
import type { Job } from "shared";
import { deleteJob, listBrands, subscribeJobs, uploadVideo } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { currentStage } from "@/lib/stages";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  // Live statuses pushed by the server (SSE); no polling.
  useEffect(
    () =>
      subscribeJobs(
        {},
        {
          snapshot: (all) => {
            setJobs(all);
            setError(null);
          },
          job: (job) =>
            setJobs((js) => (js.some((j) => j.id === job.id) ? js.map((j) => (j.id === job.id ? job : j)) : [job, ...js])),
          deleted: (id) => setJobs((js) => js.filter((j) => j.id !== id)),
          connection: (ok) => setLive(ok),
        },
      ),
    [],
  );

  async function onDelete(job: Job) {
    if (!confirm(`Delete "${job.originalName}"? This removes the video and all its results.`)) return;
    setError(null);
    setDeletingId(job.id);
    try {
      await deleteJob(job.id);
      setJobs((js) => js.filter((j) => j.id !== job.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function onUpload() {
    if (!file) return;
    setError(null);
    try {
      const { brands } = await listBrands();
      const hasAds = brands.some((brand) => brand.creatives.length > 0);
      if (!hasAds) {
        setError("Please add ads first.");
        return;
      }
      setProgress(0);
      const { job } = await uploadVideo(file, setProgress);
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-6 rounded-3xl border border-border bg-surface/95 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_64px_rgba(0,0,0,0.45)]">
        <div className="space-y-3">
          <span className="inline-flex rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-accent-strong">
            Bengali streaming inspired
          </span>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Upload an episode</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            The pipeline finds safe, natural ad breaks and matches brands from the catalogue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">Scene-aware cuts</span>
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">Brand matching</span>
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">VMAP output</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={progress !== null}
            className="w-full max-w-lg rounded-xl border border-border bg-surface-elevated px-3 py-3 text-sm text-foreground outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:font-medium file:text-white md:w-auto"
          />
          <button
            onClick={onUpload}
            disabled={!file || progress !== null}
            className="rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(215,25,32,0.3)] transition hover:bg-accent-strong disabled:opacity-40"
          >
            Upload & process
          </button>
        </div>
        {progress !== null && (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-surface-elevated">
              <div
                className={`h-full bg-accent transition-all ${progress >= 1 ? "animate-pulse" : ""}`}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            {/* Once the bytes are sent the server is still hashing the file and creating the job,
                which on a slow disk takes a while — say so instead of showing a stalled 100%. */}
            <p className="text-xs text-muted">
              {progress < 1 ? `Uploading... ${Math.round(progress * 100)}%` : "Upload complete — preparing the episode..."}
            </p>
          </div>
        )}
        {error && <p className="text-sm text-accent-strong">{error}</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Processed videos</h2>
          <span className="text-xs uppercase tracking-[0.24em] text-muted">
            {!live && <span className="mr-3 normal-case tracking-normal text-orange-300">reconnecting…</span>}
            {jobs.length} jobs
          </span>
        </div>
        {jobs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
            None yet.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/90">
            {jobs.map((j) => {
              const isDeleting = deletingId === j.id;
              const deleteTitle =
                j.status === "running" ? "Wait for processing to finish" : isDeleting ? "Deleting..." : "Delete video and results";

              return (
                <li
                  key={j.id}
                  aria-busy={isDeleting}
                  className={`flex items-center justify-between gap-3 px-4 py-4 transition hover:bg-surface-elevated/80 ${isDeleting ? "pointer-events-none" : ""}`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <Link
                      href={`/jobs/${j.id}`}
                      className={`block truncate font-medium hover:text-accent-strong ${isDeleting ? "text-muted line-through" : ""}`}
                    >
                      {j.originalName}
                    </Link>
                    <JobProgress job={j} />
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {j.catalogueStale && (
                      <span
                        title="Brands changed since this video was processed. Re-run it from the Brands page."
                        className="rounded-full border border-orange-500/20 bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-300"
                      >
                        catalogue changed
                      </span>
                    )}
                    <StatusBadge status={j.status} />
                    {j.status === "done" && (
                      <Link
                        href={`/jobs/${j.id}/player`}
                        aria-label={`Play ${j.originalName}`}
                        title="Play"
                        className="rounded-full bg-accent p-2 text-white transition hover:bg-accent-strong"
                      >
                        <Play className="h-4 w-4 fill-current" />
                      </Link>
                    )}
                    <button
                      onClick={() => onDelete(j)}
                      disabled={j.status === "running" || deletingId !== null}
                      aria-label={isDeleting ? `Deleting ${j.originalName}` : `Delete ${j.originalName}`}
                      title={deleteTitle}
                      className={`rounded-full p-2 text-muted transition hover:bg-accent/10 hover:text-accent-strong disabled:hover:bg-transparent disabled:hover:text-muted ${isDeleting ? "" : "disabled:opacity-40"}`}
                    >
                      {isDeleting ? <LoaderCircle className="h-4 w-4 animate-spin text-accent-strong" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One muted line under a job: the stage it is on, or when it will retry. */
function JobProgress({ job }: Readonly<{ job: Job }>) {
  const stage = job.status === "running" ? currentStage(job) : undefined;
  if (stage) {
    return (
      <p className="flex items-center gap-2 truncate text-xs text-muted">
        <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-amber-200" />
        <span className="truncate">{stage.label}</span>
        <span className="shrink-0 font-mono">
          {stage.step}/{stage.total}
        </span>
      </p>
    );
  }
  if (job.status === "retrying" && job.nextRunAt) {
    return <p className="truncate text-xs text-orange-300">Retrying at {new Date(job.nextRunAt).toLocaleTimeString()}</p>;
  }
  if (job.status === "error" && job.error) {
    return <p className="truncate text-xs text-accent-strong">{job.error}</p>;
  }
  return null;
}
