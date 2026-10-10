"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { STAGES, type GetJobResponse, type Job, type JobAuditResponse } from "shared";
import { fmtTime, getJob, getJobAudit, retryJob, subscribeJobs } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { STAGE_LABELS } from "@/lib/stages";

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GetJobResponse | null>(null);
  const [audit, setAudit] = useState<JobAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  async function onRetry() {
    setRetrying(true);
    try {
      await retryJob(id); // the new status arrives over the live stream
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  // Status and stage progress are pushed live (SSE). Results (breaks) are fetched once the job is done.
  useEffect(() => {
    let stop = false;
    const loadResults = () =>
      getJob(id)
        .then((r) => !stop && setData((d) => (d && d.job.status === "done" ? { ...d, results: r.results } : d)))
        .catch((e: Error) => !stop && setError(e.message));
    // Cost accrues as calls happen, so it's worth refreshing on every update, not just once done —
    // this makes the cost panel update live while the job is still running.
    const loadAudit = () => getJobAudit(id).then((a) => !stop && setAudit(a)).catch(() => {});
    const apply = (job: Job) => {
      setError(null);
      setData((d) => ({ job, results: job.status === "done" ? d?.results : undefined }));
      if (job.status === "done") loadResults();
      loadAudit();
    };
    const close = subscribeJobs(
      { jobId: id },
      {
        snapshot: (jobs) => (jobs[0] ? apply(jobs[0]) : setError("Job not found.")),
        job: apply,
        deleted: () => {
          setData(null);
          setAudit(null);
          setError("This video was deleted.");
        },
      },
    );
    return () => {
      stop = true;
      close();
    };
  }, [id]);

  if (error && !data) return <p className="text-accent-strong">{error}</p>;
  if (!data) return <p className="text-muted">Loading...</p>;
  const { job, results } = data;

  return (
    <div className="space-y-8">
      <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        All videos
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-accent-strong">Processing</p>
          <h1 className="text-2xl font-semibold tracking-tight">{job.originalName}</h1>
          <p className="font-mono text-xs text-muted">job {job.id}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          {job.status === "error" && (
            <button
              onClick={onRetry}
              disabled={retrying}
              className="rounded-xl border border-accent/40 px-4 py-2 text-sm font-semibold text-accent-strong transition hover:bg-accent/10 disabled:opacity-40"
            >
              {retrying ? "Retrying..." : "Retry"}
            </button>
          )}
          {results && (
            <Link
              href={`/jobs/${job.id}/player`}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-strong"
            >
              Open player
            </Link>
          )}
        </div>
      </div>

      <section className="rounded-2xl border border-border bg-surface/90 p-5 shadow-[0_18px_42px_rgba(0,0,0,0.3)]">
        <h2 className="mb-3 font-semibold">Pipeline</h2>
        <ol className="space-y-2">
          {STAGES.map((s, i) => {
            const st = job.stages[s];
            const secs =
              st.startedAt && st.finishedAt ? ((Date.parse(st.finishedAt) - Date.parse(st.startedAt)) / 1000).toFixed(1) : null;
            return (
              <li key={s} className="flex items-center gap-3 rounded-xl border border-border bg-surface-elevated/60 px-3 py-3 text-sm">
                <span className="w-5 font-mono text-right text-muted">{i + 1}</span>
                <span className="flex-1">{STAGE_LABELS[s]}</span>
                {secs && <span className="font-mono text-xs text-muted">{secs}s</span>}
                <StatusBadge status={st.state} />
              </li>
            );
          })}
        </ol>
        {job.status === "retrying" && job.nextRunAt && (
          <p className="mt-3 text-sm text-orange-300">
            Attempt {job.attempts} failed. Retrying automatically at {new Date(job.nextRunAt).toLocaleTimeString()}; cached
            stages are reused.
          </p>
        )}
        {job.error && <p className="mt-3 wrap-break-word text-sm text-accent-strong">{job.error}</p>}
      </section>

      {results && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">
              Ad breaks <span className="font-normal text-muted">({results.breaks.length} in {fmtTime(results.durationSec)})</span>
            </h2>
            <div className="flex gap-3 text-sm">
              <a className="text-accent-strong hover:text-white" href={results.vmapUrl} target="_blank">
                vmap.xml
              </a>
              <a className="text-accent-strong hover:text-white" href={results.breaksUrl} target="_blank">
                breaks.json
              </a>
              <a className="text-accent-strong hover:text-white" href={results.debugUrl} target="_blank">
                debug.json
              </a>
            </div>
          </div>
          {results.breaks.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border bg-surface/70 px-4 py-8 text-sm text-muted">
              No break was safe to place. Every candidate was rejected by the hard rules; see debug.json for the reasons.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-surface/90">
              <table className="w-full text-sm">
                <thead className="bg-surface-elevated text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Brand</th>
                    <th className="px-3 py-2 font-medium">Ad</th>
                    <th className="px-3 py-2 font-medium">Where</th>
                    <th className="px-3 py-2 font-medium">Fit</th>
                    <th className="px-3 py-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {results.breaks.map((b) => (
                    <tr key={b.candidateId} className="align-top transition hover:bg-surface-elevated/60">
                      <td className="px-3 py-2 font-mono whitespace-nowrap">{fmtTime(b.timeSec)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.brandName}</td>
                      <td className="px-3 py-2 font-mono">{b.adDurationSec}s</td>
                      <td className="px-3 py-2 font-mono">{b.whereScore.toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono">{b.fit.toFixed(2)}</td>
                      <td className="px-3 py-2 text-muted">{b.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Scoped to this attempt: a run served entirely from cache calls nothing, and then there is no
          cost to show, so the whole section stays hidden rather than reporting an earlier run's bill. */}
      {audit && audit.totals.calls > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">
            API cost{" "}
            <span className="font-normal text-muted">
              (${audit.totals.costUsd.toFixed(4)} · {audit.totals.calls} call{audit.totals.calls === 1 ? "" : "s"}
              {audit.totals.errors ? `, ${audit.totals.errors} failed` : ""})
            </span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="overflow-x-auto rounded-2xl border border-border bg-surface/90">
              <table className="w-full text-sm">
                <thead className="bg-surface-elevated text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Pipeline stage</th>
                    <th className="px-3 py-2 font-medium">Calls</th>
                    <th className="px-3 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audit.byStage.map((s) => (
                    <tr key={s.stage}>
                      <td className="px-3 py-2">{STAGE_LABELS[s.stage as keyof typeof STAGE_LABELS] ?? s.stage}</td>
                      <td className="px-3 py-2 font-mono">
                        {s.calls}
                        {s.errors ? <span className="text-accent-strong"> ({s.errors} failed)</span> : ""}
                      </td>
                      <td className="px-3 py-2 font-mono">${s.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-border bg-surface/90">
              <table className="w-full text-sm">
                <thead className="bg-surface-elevated text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Call</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Calls</th>
                    <th className="px-3 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audit.byKind.map((k) => (
                    <tr key={`${k.kind}\0${k.provider}\0${k.model}`}>
                      <td className="px-3 py-2">{k.kind}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted">{k.model}</td>
                      <td className="px-3 py-2 font-mono">
                        {k.calls}
                        {k.errors ? <span className="text-accent-strong"> ({k.errors} failed)</span> : ""}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {k.costUsd > 0 ? `$${k.costUsd.toFixed(4)}` : k.audioSec > 0 ? `${k.audioSec.toFixed(0)}s audio` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-muted">
            Cost is the amount the provider reported for each call; Deepgram bills by audio duration instead of reporting a
            price per call, so its rows show seconds transcribed.
          </p>
        </section>
      )}
    </div>
  );
}
