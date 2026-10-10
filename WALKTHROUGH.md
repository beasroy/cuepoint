# Ad Break Planner — how the whole thing works

A walkthrough of the platform, from adding a brand to a viewer watching an ad.
Written to be followed without reading the code, but every step names the file that does the work.

---

## What it does, in one paragraph

You give it a Bengali TV episode. It listens to the episode, works out what each scene is about,
decides where an ad break would feel natural rather than jarring, picks a brand whose product suits
that moment, and produces a standard ad schedule file that any video player can read. A fruit-juice
ad lands after a meal scene, not in the middle of a funeral. Nothing is hard-coded per episode: the
system reads the dialogue and the picture and decides for itself.

**The hard part is not finding *a* gap. It is finding a gap that is a genuine ending.** A pause
between two sentences is a gap. A pause while a mother spoons dessert into her son's mouth is also a
gap. Only one of them is a place to put an advertisement. Most of the design below exists to tell
those apart.

---

## The shape of the system

Three pieces and one folder:

| Piece | Where | What it is |
|---|---|---|
| **Web app** | `web/` | Next.js. Upload page, brand manager, job progress, video player. |
| **Server** | `server/` | Express + a background worker. Does all the real work. |
| **Database** | `data/app.db` | SQLite — a single file. Jobs, attempts, brands, audit trail, API costs. |
| **Artifacts** | `data/<hash>/` | Per episode: the video, the audio, and every intermediate result as JSON. |

There is no Redis, no message broker, no second service. The job queue is rows in a SQLite table
and a loop that reads them. That is a deliberate choice, explained in Part 3.

---

# Part 1 — Adding a brand

**Before any episode can be processed, the catalogue needs brands with ads.** The upload page checks
this and refuses with *"Please add ads first"* — otherwise the pipeline would do all its expensive
work and then have nothing to place. Note this guard lives in `web/app/page.tsx`, not on the server,
so a direct `POST /api/jobs` still gets through. See Appendix C.

### What you fill in

`web/app/brands/page.tsx` — the form.

| Field | Example | Why it exists |
|---|---|---|
| Name | "Mithai Sweets" | Shown in the ad. |
| Category | `food/spices/cooking` | Human-readable grouping. |
| **Target contexts** | cooking, kitchen, family meal, festival food | **The matching key.** Scenes this brand suits. |
| **Negative contexts** | funeral, hospital, violence, grief | **The safety key.** Scenes it must never sit next to. |
| Language | bn / en | Bengali creatives are preferred for Bengali content. |
| Ad videos | up to 3 files | Your real ads. |
| Or: generate | 15s / 30s | Makes placeholder title-card ads so you can demo without real assets. |

**Why two lists instead of one.** A single "relevance" score would let a brand creep next to
anything loosely related. Splitting it means *fits* and *must-not-sit-beside* are judged separately —
a food brand can match a dinner scene and still be blocked because someone dies two lines later. The
negative list is a veto, not a penalty.

### What happens on submit

`server/src/routes/brands.ts` — `POST /api/brands`, multipart upload.

1. **Validation.** Name 2–60 characters, at least one target context, at least one video *or* the
   generate option. Rejected with a clear message otherwise.
2. **`assertSyntheticName`** — refuses names that look like real companies. This is a demo system;
   generating fake ads for real brands is not something it should make easy.
3. **Uploaded videos are normalised** — `server/src/catalogue/creatives.ts` re-encodes every upload to
   1280×720 H.264/AAC mp4, letterboxed, with a silent audio track added if it has none.
   **Why:** a player switching from episode to ad and back should not have to renegotiate codecs or
   resolution. One shape in, one shape out, no surprises mid-playback.
4. **Generated ads, if asked** — also `creatives.ts`. It draws an SVG title card (brand name,
   category, context chips, a colour derived from the name), renders it to PNG with `resvg`, then
   makes a video with a slow Ken Burns zoom and a very quiet tone bed.
   **Why the tone:** some players stall on a completely silent track. **Why "veryfast" preset and
   capped threads:** the first version peaked at ~310 MB and 26 CPU-seconds for a 30-second clip and
   got killed by the kernel in a small container. This version uses ~120 MB and a third of the CPU.
5. **Saved.** The brand goes into SQLite (`brands` + `brand_creatives`); the video files go to
   `catalogue/ads/<brandId>/`.

> **The catalogue lives in the database, not in a file.** `catalogue/brands.json` is only the
> import/export format — see `server/src/catalogue/store.ts`, which says so in its first line. The
> file matters for one other reason: `catalogue/ads/` sits next to it, so when you deploy, that
> folder needs to be on the persistent disk too. Easy to miss.

---

# Part 2 — Uploading an episode

`web/app/page.tsx` → `web/lib/api.ts` → `server/src/routes/jobs.ts`

### The client

`uploadVideo()` in `web/lib/api.ts` uses `XMLHttpRequest` rather than `fetch`.
**Why:** `fetch` gives no upload progress events. These files are hundreds of megabytes, and a
progress bar is not optional at that size.

Before uploading, the page checks the catalogue has at least one brand with a creative, and refuses
otherwise — see Part 1. This is a UI guard only.

### The server

`POST /api/jobs` (`server/src/routes/jobs.ts`), 4 GB cap, multipart field `video`.

1. **Hash the file** — SHA-256 of the bytes. `server/src/lib/hash.ts`
2. **The hash is the identity.** Files go to `data/<full-hash>/source.mp4`; the job id is the first
   16 characters.
   **Why hash instead of a random id:** uploading the same episode twice is then free. The folder
   already exists, every cached stage is reused, and you get a cheap re-run rather than paying for
   transcription again. It also makes the system idempotent against double-clicks and retries.
3. **Enqueue** — `server/src/db/repo.ts` → `enqueueUpload`. New file → new job. Same file again →
   re-run. Already running → nothing happens.
4. **Write `job.json`** next to the video, holding the original filename and creation time.
   **Why:** so the folder can be re-imported if the database is ever lost. The artifacts are the
   source of truth; the database is an index over them.
5. **Wake the worker** so it starts now rather than at the next poll.

### Multipart staging

`server/src/lib/uploads.ts` holds the multer config. It re-creates `data/_uploads` on **every**
file, not once at boot.
**Why:** deleting `data/` while the server runs is something you do constantly in development.
Without this, the next upload fails with a confusing ENOENT.

---

# Part 3 — The durable job queue

`server/src/jobs/queue.ts` · `server/src/db/repo.ts` · `server/src/db/schema.ts`

A pipeline run takes minutes and spends real money. If the process dies halfway, nothing should be
lost and nothing should be paid for twice. That is what "durable" means here.

### Jobs are rows

`schema.ts` defines the `jobs` table: status, attempt count, `next_run_at`, `locked_by`,
`heartbeat_at`. A worker loop polls for due jobs every second.

### Claiming without double-running

`claimNext` in `repo.ts` is the most important function in the file. It reads the next due job and
marks it running — and those two steps happen inside **`BEGIN IMMEDIATE`**.

**Why that matters.** A plain `BEGIN` in SQLite is *deferred*: it does not take the write lock until
the first write. Two workers could both run the SELECT, both see job X as queued, and both claim it.
`BEGIN IMMEDIATE` takes the lock up front, so the second worker blocks, and by the time it reads,
the job is already `running`. The race is lost on the lock instead of on the data.

In the same transaction it also opens an attempt record, resets the stage list, and writes an audit
event. Either all of that happened or none of it did.

### Staying alive, and dying honestly

- **Heartbeat** every 10 seconds while a job runs.
- A job whose heartbeat is older than 60 seconds belongs to a dead process. `recoverStale` hands it
  back to the queue.
- On `SIGINT`/`SIGTERM`, the worker releases its jobs immediately rather than waiting to be
  declared stale. A clean restart resumes in seconds.
- An attempt running longer than an hour is failed at the next stage boundary.

### Retries that mean something

`classifyError` splits failures in two:

- **`PermanentError`** — "this is not a video file", "no audio stream". Retrying cannot help. Fail
  now and say why.
- **Everything else** — network blip, rate limit, provider hiccup. Retry.

Backoff is `30s × 4^(n-1)`, capped at 10 minutes: 30s, 2m, 8m. Three attempts by default.
**And crucially, a retry resumes from cached stages** — so attempt 2 of a job that failed during
placement does not re-transcribe the episode. It costs cents, not dollars.

### Three PRAGMAs that carry weight

`repo.ts` opens the database with:

```sql
PRAGMA journal_mode = WAL;    -- readers and writers no longer block each other
PRAGMA foreign_keys = ON;     -- SQLite ships with these OFF, per-connection
PRAGMA busy_timeout = 5000;   -- wait 5s for a lock instead of erroring instantly
```

WAL is needed because the progress stream reads `jobs` constantly while the worker writes to it.

### Migrations without a framework

SQLite gives each database a free integer called `user_version`. `openDb` reads it, runs any
`MIGRATIONS[]` entries past that index inside a transaction, and bumps it. **The array is
append-only** — never edit a shipped entry, because databases that already ran it will not re-run it.

### An audit trail that cannot be rewritten

`audit_events` has triggers that `RAISE(ABORT)` on UPDATE and DELETE. The append-only rule is
enforced by the database, not by discipline.

---

# Part 4 — The pipeline

`server/src/jobs/runner.ts` runs five stages in order. **Every stage caches its result** keyed by a
hash of its inputs, so a re-run only redoes what actually changed.

```
1 Ingest  →  2 Transcribe  →  (merge)  →  4 Placement  →  5 Outputs
              3 Signals  ──────┘
```

Stages 2 and 3 run in parallel — one reads the audio, the other reads the picture.

---

## Stage 1 — Ingest

`server/src/stages/ingest.ts` · `server/src/lib/ffmpeg.ts`

- **`ffprobe`** the file: duration, resolution, frame rate, codecs. No video stream or no audio
  stream is a `PermanentError` — retrying will not grow one.
- **Extract `full.wav`** — 16 kHz mono PCM. **Why uncompressed:** everything downstream that needs
  sample-accurate timing (silence detection, the speech check) reads this file. Compression artefacts
  would blur exactly the boundaries we care about.
- **Split into `chunk_000.mp3` …** — 2-minute pieces at 32 kbps, each tagged with its offset in the
  episode.
  **Why 2 minutes:** short enough that the transcriber's timestamps stay tight and every request
  finishes well inside its timeout; long enough that a conversation usually fits in one piece.
  **Why 32 kbps mono:** it is speech. Higher bitrates cost upload time and buy nothing.

---

## Stage 2 — Transcribe

`server/src/stages/transcribe.ts` · ElevenLabs Scribe v2

Each chunk goes to Scribe in parallel, asking for Bengali, **word-level timestamps**, speaker
diarization, and **audio-event tags**.

**Raw responses are cached per chunk** in `data/<hash>/transcribe/scribe-scribe_v2/`. This matters
more than it sounds: changing how the transcript is *assembled* then costs nothing, because the
expensive part — the API call — is already on disk.

### Three things come out, and they are used differently

**1. Dialogue lines.** Words grouped into utterances, split wherever there is a pause of 0.5s or
more. This is what the AI reads.

**2. Speech walls.** Every word becomes a "do not cut here" interval, each capped at 2 seconds.
**Why the cap:** Scribe's timings are usually tight (median error 0.22s) but a rare span runs to
tens of seconds, and one bad span would wall off a whole minute of the episode.

**3. Audio events** — `[music]`, `[crying]`, `[screaming]`, `[laughter]`.

### The music exception

Audio events become speech walls too — **except music**. `isMusicEvent()` in `transcribe.ts`
matches music tags loosely, because Scribe's labels are inconsistent and sometimes garbled
(`[music]`, `[outro jingle]`, `[মিউজিক]`, `[বাদ্যসঙ্গীত]`, and mangled forms like `[বাদ্যসদ]`).

**Why this carve-out exists.** Originally all audio events blocked cuts. But a music bed is exactly
where television puts its breaks — the system's own `minSpeechFreeSec` setting exists to allow
cutting over music. So the code was simultaneously saying "music is a great ad point" and "never cut
in music", with the outcome decided by whether Scribe happened to emit a tag.

Measured across six episodes, tagged music was **0.2% to 18.6% of each episode** — on one, over seven
minutes including three separate two-minute beds. Releasing it turned 1 placed ad into 3 on that
episode. Anything the matcher does **not** recognise stays a wall, so the change can only add
inventory, never remove safety.

### Hallucination filter

Any line that is more than 60% inside a measured silence is dropped. Transcribers invent plausible
dialogue over quiet audio; if ffmpeg says nothing was audible, nobody spoke.

---

## Stage 3 — Signals (the picture)

`server/src/stages/signals.ts` · `server/src/lib/ffmpeg.ts`

Two ffmpeg passes, no AI, no cost.

**Silences** — `silencedetect` at −35 dB for 0.3s or longer. "Nothing at all is audible here."

**Shot cuts** — `select='gt(scene,0.3)'`. Each frame is shrunk to 320px wide and compared to the one
before it, scoring 0 (identical) to 1 (nothing in common). Anything over 0.3 is flagged as a cut.

**What this actually measures, in plain terms:** it is a difference meter, not eyes. Within one shot,
consecutive frames are nearly identical — a mouth moves, score ≈ 0.001. When the camera cuts, the
whole frame changes at once and the score leaps. A real example from one episode:

```
197.96  0.0015
198.00  0.3710   ← over 0.30, flagged as a cut
198.04  0.0007
```

**It knows nothing about content.** Not faces, not rooms, not people. Which produces two predictable
failures: a fast camera pan scores high and gets called a scene change, and a *fade* to black is
missed entirely, because the change is spread across thirty frames and no single step is large
enough to trip the threshold. Measured on one fade: the largest frame-to-frame difference across the
whole transition was 0.08.

**Why keep it anyway.** The AI cannot see the video. These markers are its only evidence that the
picture changed — and it cites them in over half its reasoning.

---

## Stage 4 — Placement

`server/src/stages/placement.ts` · `server/src/prompts/placement.ts`

This is where the decisions happen. Five sub-steps.

### 4a. The story so far

`server/src/prompts/programme.ts` — **one call per episode, cached.**

The whole dialogue goes in as `[mm:ss] text`. Out comes a one-sentence summary, a genre, and up to
8 recurring contexts.

```
"A multigenerational drama follows Indubala and her family running a Bengali eatery
 as food, memories of displacement, old loves, friendship and grief resurface."
```

**Why:** background only, so each chunk's decision is informed by the episode as a whole. Placement
runs fine without it.

### 4b. One call per chunk, all independent

Every 2-minute chunk that contains dialogue gets its own call. **They run in parallel and none is
told what any other decided.**

**Why independence matters.** If calls were sequential and aware of each other, the first chunk's
choice would constrain every later one, and the model would start reasoning about pacing instead of
about the scene in front of it. Independence keeps each judgement honest. Spacing, variety and brand
repetition are decided afterwards, by code, which is better at arithmetic than a language model is.

### What the model is shown

```
STORY SO FAR         one sentence of background
BRANDS               every brand, with fits_scenes_about and never_next_to
PREVIOUS LINES       90s of dialogue before this chunk — context only, no ads here
CURRENT LINES        the chunk itself, numbered 1, 2, 3… — ads may only go after these
NEXT LINES           90s after — context only
```

Measured markers are woven in between the dialogue lines, unnumbered:

```
3. [414.3–416.8] Finally, our seats. Wake me up at Howrah.
    · silence 5.9s [417.0–422.9]
    · shot cut [421.4]
4. [423.5–425.9] Doctor, how is my father now?
```

**Why interleave rather than list separately.** A list of timestamps at the bottom would force the
model to do time arithmetic to find out which pause follows which line. Putting each marker where it
happens makes the relationship visual.

**Why 90 seconds either side.** A conversation that looks finished at the end of a chunk may carry
straight on into the next one. Without the look-ahead the model would cut into it.

### The rules it is given

**Placement**
1. The ad goes after a line, at a point backed by a measured silence.
2. That line must be the **last** line of a finished conversation. Never mid-conversation, never
   between a question and its answer, never after a line that starts something.
3. Never interrupt suspense, an argument, a threat or a cliffhanger.

**Suitability**

4. The brand must fit what the viewer just watched, using its target contexts.
5. Never pick a brand when a scene nearby involves anything on its never-next-to list.
6. If a context is listed by **more than half of all brands** as negative, no ad plays at all. This
   list is computed from the catalogue at runtime, so it adapts as brands are added — nobody
   maintains a blocklist.

**Honesty**

8. *"You only have dialogue and the measurements described above, not the picture itself. Judge the
   scene from what is said and measured. Do not assume things that are not there."*
9. If nothing passes, place no ad. **A missing ad is better than a bad one.**

### A rule learned the hard way

Rule 2 originally ended at *"a line that calls someone over or starts something ('come here',
'listen', 'wait')"*. An episode then produced this break:

```
[324.6–327.2] ফির্নি আনছি খা। খা।        "I've brought firni. Eat. Eat."
         ↓ ad, in a real 2.0s silence
[329.6–331.8] এই কয় বছরে আকবররে...       "How much money have you sent Akbar…"
```

On screen, the mother is spooning dessert into her son's mouth. The ad lands in the middle of it.

Everything measurable said yes: a genuine 2-second silence, and brand fit 0.95 because the word
*firni* is literally in the line. The model's own explanation gave it away — it called the line *"an
invitation to eat"* and then treated an invitation as an ending.

Rule 2 now covers it:

> *This includes a line telling someone to do something that then happens on screen ("eat", "drink",
> "sit down", "open it", "take it", "look"): the action follows the line, so the scene is still
> running even though nobody speaks during it. An offer or an invitation is the start of something,
> never the end of it. A change of subject between the same people in the same place is also not the
> end of a conversation — the scene itself has to end, not just the topic.*

Tested on the failing chunk: the original prompt reproduced the bad placement on two different
models; the fixed prompt declined on both. On a full re-run it independently caught a *second*
instance elsewhere in the same episode — a tea offer followed by money talk — that the old prompt had
also accepted.

### What it must return

A strict JSON schema (`placementJsonSchema`) pins `line_id` to this chunk's actual line numbers,
`brand_id` to real brands, and reported contexts to known vocabulary. The model cannot invent an id.

```json
{"placement": {"line_id": 3, "brand_id": "brand_x", "fit": 0.9,
                "reason": "...", "contexts_nearby": ["hospital"]},
 "alternatives": [...], "why_not_others": "..."}
```

**`contexts_nearby` is the clever bit.** Rather than asking "is this safe?", which invites a
reassuring yes, it asks the model to *report what it saw* near each option. Code then checks that
report against the brand's veto list. The model is used for observation; the decision stays in code.

**Alternatives exist** so that when the main pick fails a check, or when code needs a different
brand to avoid a repeat, there is somewhere to go without another API call.

### 4c. Finding the exact moment — `cutAfterLine`

The model picks a *line*. Code picks the *millisecond*, in the gap after it:

1. **Inside a measured silence** — on a shot cut if one falls in it, otherwise the midpoint.
2. **Otherwise**, the first stretch with no transcribed word for 1.5s or more — music may be
   playing. This is the path that unlocks music-only transitions.
3. **Otherwise** the option is rejected.

In practice **6 of 8 shipped breaks** came from path 2, not path 1. The dominant mechanism is not
silence — it is *"music is playing and nobody is speaking."*

### 4d. Content checks — `checkOption`

The line belongs to this chunk · the cut is not in the last 90 seconds · no reported context is on
the brand's veto list · none is on the blocks-everything list · **fit ≥ 0.7**.

That last one is the main gate on what airs at all. Most candidates die there, not on safety.

### 4e. Scheduling — `scheduleBreaks`

Only now does anything compare chunks. An exhaustive search over at most one pick per chunk,
maximising total quality:

```
score = 0.6 × how good the pause is  +  0.4 × brand fit
        (pause capped at 3 seconds — beyond that, longer is not better)
```

Subject to: total ad time ≤ 15% of the episode · never the same brand on two adjacent ads · a brand
capped at 2 airings (3 past ~75 minutes) · a 0.15 penalty per earlier use of that brand.

**Why a penalty *and* a cap.** The penalty is a tie-break — with 8 brands and a long episode, some
repetition is unavoidable, so a repeat still wins when it is clearly the better fit. The cap stops
it becoming a pattern.

**No minimum gap and no target count.** Two good moments close together are both good moments; a
chunk with no eligible candidate is simply left empty. The fit floor alone decides what exists.

### 4f. The speech check — the last gate

`server/src/stages/listen/` · `server/src/lib/vad.ts`

The transcript can be wrong. Before any ad ships, the audio itself is checked around the cut.

**Silero VAD** (a small local neural net, free, no API) scores voice activity:

```
≥ 0.9                         → speech  → no ad
< 0.1 and nothing transcribed → quiet   → accept
in between                    → unsure  → ask an audio LLM, twice
```

**Why a second opinion at all, when Scribe already transcribed everything.** Because Scribe tells
you where words *are*; it cannot reliably tell you where words *aren't*. One cut sat in a 3.08-second
hole in the transcript — Scribe processed the audio and returned nothing for those three seconds.

**The window is clamped to the pause.** This was a real bug. The window is ±1 second (2 seconds
wide), but the minimum acceptable pause is 1.5 seconds — so for the most common gap size the window
physically could not fit inside the pause. It spilled into the dialogue on either side, the VAD heard
those words, and reported speech *at the cut*:

| pause length | share rejected |
|---|---|
| 1.5–2s | **91%** |
| 2–2.5s | 22% |
| 4s+ | **0%** |

The gate was rejecting cuts for containing the very dialogue they were placed between. `listenHalfWindow()`
in `listen/rules.ts` now clamps the window so it never reaches past the pause. On one cut that moved
the reading from 1.00 ("speech") to 0.35 ("unclear") — an honest answer instead of a reflex.

**The LLM half is the weakest link, and it is documented as such.** The code comment says it plainly:
on quiet audio it invents plausible Bengali dialogue, measured at 6–7 of 9 confirmed-quiet clips. It
has also returned **opposite verdicts on identical audio** across two runs of the same episode. It is
only ever a tie-breaker, never allowed to decide a clear case, and it can be turned off entirely with
`LISTEN_LLM_RECHECK=false`.

A cut that fails is dropped and **the schedule is redrawn without it** — up to 20 rounds, with each
candidate checked at most once, so cost stays near one check per ad that actually airs.

---

## Stage 5 — Outputs

`server/src/stages/outputs.ts` · `server/src/xml/vmap.ts` · `server/src/xml/vast.ts`

**`vmap.xml`** — the industry-standard "when" file. One `<AdBreak>` per cut, at `HH:MM:SS.mmm`,
each pointing at a VAST URL.

**VAST, served live** — the "what" file, per break: ad title, duration, the mp4 URL, an impression
tracking pixel. Generated on request rather than baked in, so a brand's creative can change without
regenerating anything.

**Why these formats.** They are what real ad servers speak. The output drops into an existing player
with no custom integration.

**`debug.json`** — the receipts. A plain-language explanation of the run with this run's actual
numbers filled in, every setting used, every chunk's exact prompt and answer, every option with its
cut time and why it was accepted or rejected (including ones that passed every check but lost to a
better schedule), and the full API cost broken down. API keys are stripped.

---

# Part 5 — The player

`web/components/Player.tsx` · `web/lib/vmap.ts`

Reads the VMAP, and as playback approaches a break, pauses the episode, **sets `currentTime` back to
exactly the cut point**, plays the ad, fades, and resumes.

**Why re-seek to the cut.** Browser timers are not frame-accurate; by the time the pause fires you
may be 200ms past the mark. Without the seek, the viewer loses a fraction of a second of dialogue on
return — small, but exactly the kind of thing that makes an ad break feel broken.

A broken or missing ad skips the fade and resumes immediately. The episode never gets stuck behind a
failed advertisement.

---

# Part 6 — Watching what it costs

`server/src/db/repo.ts` → `getAudit` · `web/app/jobs/[id]/page.tsx`

Every API call is recorded: provider, model, label, latency, tokens, cost. The job page shows cost by
pipeline stage and by what each call was for.

**Scoped to the current attempt.** A job id is the video's hash, so a re-upload or retry keeps it and
calls accumulate forever. Summing the whole table answers *"what has this video ever cost"* when the
question is *"what did this run cost"* — one job showed $0.7634 across 10 attempts where the actual
run was $0.1227. If an attempt ran entirely from cache, there is no cost and the panel hides itself.

**Typical episode, roughly $0.13:** transcription ~$0.10 (75%), placement ~$0.02, the speech check
~$0.01. If you are hunting cost, it is the transcription.

---

# Appendix A — File map

| File | What it does |
|---|---|
| `server/src/config.ts` | Every tunable setting, in one place, each with a comment saying why. |
| `server/src/db/schema.ts` | Tables and the append-only audit triggers. |
| `server/src/db/repo.ts` | All database access. `claimNext` is the one to read first. |
| `server/src/jobs/queue.ts` | The worker loop: claim, run, heartbeat, retry, recover. |
| `server/src/jobs/runner.ts` | Runs the five stages in order. |
| `server/src/stages/ingest.ts` | Probe, extract wav, split into mp3 chunks. |
| `server/src/stages/transcribe.ts` | Scribe calls, merge, speech walls, `isMusicEvent`. |
| `server/src/stages/signals.ts` | Silences and shot cuts. |
| `server/src/stages/placement.ts` | Prompting, cut-finding, checks, scheduling. |
| `server/src/stages/listen/` | The speech gate: `rules.ts` is pure logic, `index.ts` does the I/O. |
| `server/src/stages/outputs.ts` | VMAP, VAST, debug report. |
| `server/src/prompts/placement.ts` | The main prompt. Versioned. |
| `server/src/prompts/programme.ts` | The story-so-far prompt. |
| `server/src/prompts/listen.ts` | The audio-check prompt. |
| `server/src/lib/ffmpeg.ts` | Every ffmpeg call. |
| `server/src/lib/vad.ts` | Silero voice detection. |
| `server/src/catalogue/creatives.ts` | Normalises uploads, generates title-card ads. |
| `server/src/routes/jobs.ts` | Upload, status, live progress stream, retry. |
| `server/src/routes/brands.ts` | Brand CRUD, catalogue import/export. |
| `web/components/Player.tsx` | The player that honours the ad schedule. |
| `server/playground.js` | Try the prompt on one hard-coded chunk. |
| `server/placement-experiment.js` | A/B a prompt change across arms and models, with the real prompt. |

## Appendix B — Knobs worth knowing

| Setting | Default | What moves if you change it |
|---|---|---|
| `placement.minBrandFit` | 0.7 | **The main gate.** Most candidates die here. |
| `placement.maxAdLoadPct` | 15% | Ceiling on total ad time. |
| `placement.noAdLastSec` | 90s | No ads in the run-out. |
| `thresholds.minSpeechFreeSec` | 1.5s | How short a pause may be and still host a cut. |
| `signals.sceneThreshold` | 0.30 | Shot-cut sensitivity. Varies wildly by content — measured 1.9 to 19.6 cuts/min across six episodes at this one value. |
| `listen.vadSpeechMin` | 0.9 | Voice activity that vetoes a cut outright. |
| `queue.concurrency` | 1 | Episodes at once. Model rate limits are shared across them. |
| `LISTEN_LLM_RECHECK` | on | Set `false` to drop the audio LLM; the unsure band then fails closed. |

## Appendix C — Known limits

- **The system cannot see the video.** It reasons from dialogue, silence and shot cuts. A silent
  visual scene — a funeral with no words — is invisible to brand safety. A vision model on keyframes
  around each candidate cut is the obvious next step.
- **Shot-cut detection is content-dependent.** One threshold produced 1.9 cuts/min on one episode
  and 19.6 on another. It also misses fades, which are the clearest scene endings there are.
- **The audio LLM is non-deterministic** and has a documented tendency to hallucinate speech over
  quiet audio. It is a tie-breaker, and it can be switched off.
- **Scribe's coverage varies.** Music tagging ranged from 0.2% to 18.6% of an episode — the low end is
  the transcriber missing music, not an episode without any.
- **The "add brands first" rule is enforced in the browser, not the API.** `POST /api/jobs` will
  happily accept a video with an empty catalogue and burn the transcription cost before discovering
  there is nothing to place. Worth moving into `server/src/routes/jobs.ts`.
