// Pure state transitions for an AlbumJob. Every function mutates the job it is
// given and is meant to run inside Repository.mutateJob, which makes each call
// atomic. No Chrome APIs here, so all of it is unit-testable.

import { MAX_SONGS, MIN_SONGS, SCHEMA_VERSION, TIMING } from "../shared/constants";
import type {
  ActionResult, AlbumJob, AlbumPlan, BatchRecord, BatchStatus, GenerationEvidence,
  JobPhase, SongRecord, TrackRecord, WorkerCount, WorkerState,
} from "../shared/types";
import { chunk, clampBatchSize } from "./batcher";

export interface JobConfig {
  description: string;
  workerCount: WorkerCount;
  playlistMode: "existing" | "new";
  playlistIdentity?: string;
  playlistName?: string;
  downloadBatchSize: number;
}

export interface StartInput {
  description: string;
  songCount: number;
  workerCount?: number;
  playlistMode: "existing" | "new";
  playlist?: { identity: string; name: string };
  newPlaylistName?: string;
}

/**
 * Start-time validation; returns an error code or null. The playlist is one
 * destination for the whole album (never one per track): an existing playlist
 * or a single new name. It is only required while playlist placement is
 * enabled, so a generation-only run may leave it empty.
 */
export function validateStart(input: StartInput, playlistEnabled: boolean, maxWorkers = Infinity): string | null {
  if (!input.description.trim()) return "empty_description";
  if (!Number.isInteger(input.songCount) || input.songCount < MIN_SONGS || input.songCount > MAX_SONGS) {
    return "invalid_song_count";
  }
  // Untested capacity is never enabled: only verified worker counts may run.
  if (input.workerCount !== undefined && input.workerCount > maxWorkers) return "workers_unverified";
  if (!playlistEnabled) return null;
  if (input.playlistMode === "existing" && !input.playlist) return "playlist_required";
  if (input.playlistMode === "new" && !input.newPlaylistName?.trim()) return "playlist_name_required";
  return null;
}

export function createJob(plan: AlbumPlan, cfg: JobConfig, now = Date.now()): AlbumJob {
  return {
    schemaVersion: SCHEMA_VERSION,
    albumId: plan.albumId,
    albumTitle: plan.albumTitle,
    createdAt: now,
    updatedAt: now,
    inputDescription: cfg.description,
    songCount: plan.tracks.length,
    workerCount: cfg.workerCount,
    playlistMode: cfg.playlistMode,
    playlistIdentity: cfg.playlistIdentity,
    playlistName: cfg.playlistName,
    phase: "draft",
    tracks: plan.tracks.map<TrackRecord>((t) => ({
      trackId: t.trackId,
      albumId: plan.albumId,
      index: t.index,
      plannedTitle: t.title,
      prompt: t.prompt,
      variationAxes: { ...t.variationAxes },
      design: structuredClone(t.design),
      trackStatus: "draft",
      attempts: 0,
      updatedAt: now,
    })),
    songs: [],
    workerStates: [],
    downloadBatchSize: clampBatchSize(cfg.downloadBatchSize),
    downloadBatches: [],
    playlistBatches: [],
  };
}

const ACTIVE_PHASES: JobPhase[] = ["generating", "downloads", "playlist"];
export const isActivePhase = (p: JobPhase) => ACTIVE_PHASES.includes(p);

export function track(job: AlbumJob, trackId: string): TrackRecord {
  const t = job.tracks.find((x) => x.trackId === trackId);
  if (!t) throw new Error(`unknown_track:${trackId}`);
  return t;
}

export function worker(job: AlbumJob, workerId: string): WorkerState {
  const w = job.workerStates.find((x) => x.workerId === workerId);
  if (!w) throw new Error(`unknown_worker:${workerId}`);
  return w;
}

export function workerByTab(job: AlbumJob, tabId: number): WorkerState | undefined {
  return job.workerStates.find((w) => w.tabId === tabId);
}

function touch(t: TrackRecord, now: number) {
  t.updatedAt = now;
}

// ------------------------------------------------------------------ titles

/** Flow's title field holds at most 100 characters. */
export function expectedFlowTitle(planned: string): string {
  return planned.slice(0, 100);
}

const normTitle = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** Exact title match (whitespace and Unicode form normalized only). */
export function titleMatches(planned: string, seen: string | undefined): boolean {
  return seen !== undefined && normTitle(seen) === normTitle(expectedFlowTitle(planned));
}

// ---------------------------------------------------------------- generation

export function startGeneration(job: AlbumJob): void {
  if (job.phase !== "draft") throw new Error(`cannot_start_from:${job.phase}`);
  for (const t of job.tracks) if (t.trackStatus === "draft") t.trackStatus = "queued";
  job.phase = "generating";
}

export function editPrompt(job: AlbumJob, trackId: string, prompt: string, now = Date.now()): void {
  const t = track(job, trackId);
  if (t.trackStatus !== "draft" && t.trackStatus !== "queued") throw new Error("prompt_locked");
  if (!prompt.trim()) throw new Error("empty_prompt");
  t.prompt = prompt.trim();
  touch(t, now);
}

export function addWorker(job: AlbumJob, tabId: number): WorkerState {
  const existing = workerByTab(job, tabId);
  if (existing) return existing;
  const w: WorkerState = { workerId: `w${job.workerStates.length + 1}`, tabId, status: "loading" };
  job.workerStates.push(w);
  return w;
}

/** Workers beyond the current concurrency limit finish their song, then idle. */
export function withinConcurrency(job: AlbumJob, workerId: string): boolean {
  const live = job.workerStates.filter((w) => w.status !== "error" && w.tabId !== undefined);
  return live.findIndex((w) => w.workerId === workerId) < job.workerCount;
}

export function markWorkerReady(job: AlbumJob, workerId: string, now = Date.now()): void {
  const w = worker(job, workerId);
  w.lastHeartbeatAt = now;
  if (w.status === "loading" || w.status === "idle") w.status = "ready";
}

/**
 * Atomically assigns the lowest queued track to a ready worker. Returns null
 * if the job/worker cannot take work. A track is only ever handed out once,
 * because the claim happens inside one serialized storage transaction.
 */
// ------------------------------------------------------------ gradual start

/** Deterministic 15–30 s gap per worker, so first submissions never line up. */
export function staggerGapMs(workerId: string): number {
  let h = 0;
  for (const c of workerId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const span = TIMING.staggerMaxMs - TIMING.staggerMinMs;
  return TIMING.staggerMinMs + (h % (span + 1));
}

/**
 * How long this worker must still wait before its first submission of the
 * current run. Later submissions (after a completed song) never wait.
 */
export function rampWait(job: AlbumJob, workerId: string, now: number, gap: (id: string) => number = staggerGapMs): number {
  const w = worker(job, workerId);
  if (w.rampedAt !== undefined || job.lastRampAt === undefined) return 0;
  return Math.max(0, job.lastRampAt + gap(workerId) - now);
}

export interface ClaimOptions {
  /** Enforce gradual start with this gap function (orchestrator); off by default. */
  stagger?: (workerId: string) => number;
  /**
   * Hard ceiling on prompts handed to Flow in this job (the build's song
   * limit). Counts submissions that may have happened, so a requeue can
   * never push the job past it.
   */
  maxSubmissions?: number;
}

/** Prompts that reached (or may have reached) Flow, plus claims in progress. */
export function submissionsUsed(job: AlbumJob): number {
  return (job.submittedCount ?? 0) + job.tracks.filter((t) => t.trackStatus === "assigned").length;
}

export function claimNextTrack(job: AlbumJob, workerId: string, now = Date.now(), opts: ClaimOptions = {}): TrackRecord | null {
  if (job.phase !== "generating") return null;
  const w = worker(job, workerId);
  if (w.status !== "ready" || w.currentTrackId) return null;
  if (!withinConcurrency(job, workerId)) return null;
  const next = job.tracks
    .filter((t) => t.trackStatus === "queued")
    .sort((a, b) => a.index - b.index)[0];
  if (!next) return null;
  if (opts.maxSubmissions !== undefined && submissionsUsed(job) >= opts.maxSubmissions) return null;
  if (opts.stagger) {
    const wait = rampWait(job, workerId, now, opts.stagger);
    if (wait > 0) {
      w.startAfter = now + wait;
      return null;
    }
    if (w.rampedAt === undefined) {
      w.rampedAt = now;
      job.lastRampAt = now;
    }
    w.startAfter = undefined;
  }
  next.trackStatus = "assigned";
  next.workerId = workerId;
  next.sessionTabId = w.tabId;
  next.attempts += 1;
  touch(next, now);
  w.status = "submitting";
  w.currentTrackId = next.trackId;
  w.lastHeartbeatAt = now;
  return next;
}

function ownsTrack(job: AlbumJob, workerId: string, trackId: string): boolean {
  const w = job.workerStates.find((x) => x.workerId === workerId);
  return !!w && w.currentTrackId === trackId && track(job, trackId).workerId === workerId;
}

export function markSubmitted(job: AlbumJob, workerId: string, trackId: string, now = Date.now()): boolean {
  if (!ownsTrack(job, workerId, trackId)) return false;
  const t = track(job, trackId);
  if (t.trackStatus !== "assigned") return false;
  t.trackStatus = "generating";
  t.submittedAt = now;
  job.submittedCount = (job.submittedCount ?? 0) + 1;
  touch(t, now);
  const w = worker(job, workerId);
  w.status = "generating";
  w.lastHeartbeatAt = now;
  return true;
}

export interface Outcome {
  /** Worker may receive the next prompt right away. */
  workerFree: boolean;
  /** Global pause requested (pause-on-error). */
  pauseJob: boolean;
}

/**
 * Submission did not go through. `notSubmitted` must only be true when the
 * adapter verified the prompt never reached the site (e.g. the Generate
 * button was never clicked); then the track can safely go back to the queue.
 */
export function recordSubmitFailure(
  job: AlbumJob, workerId: string, trackId: string,
  result: Exclude<ActionResult, { kind: "success" }>, notSubmitted: boolean,
  pauseOnError: boolean, now = Date.now(),
): Outcome {
  if (!ownsTrack(job, workerId, trackId)) return { workerFree: false, pauseJob: false };
  const t = track(job, trackId);
  const w = worker(job, workerId);
  t.lastErrorCode = result.code;
  t.lastErrorMessage = result.detail;
  w.currentTrackId = undefined;
  w.lastError = result.code;
  touch(t, now);
  if (notSubmitted && result.code === "busy") {
    // The page is still running an earlier generation. The prompt was not
    // sent and is not at fault: give it back without spending an attempt, and
    // let the worker wait (idle) until the periodic check finds the page free.
    t.trackStatus = "queued";
    t.workerId = undefined;
    t.attempts = Math.max(0, t.attempts - 1);
    w.status = "idle";
    return { workerFree: false, pauseJob: false };
  }
  if (notSubmitted) {
    // Verifiably never sent: the song itself is fine, back to the queue
    // (bounded, so a broken page cannot cycle a track forever).
    t.trackStatus = t.attempts < 3 ? "queued" : "generation_failed";
    t.workerId = undefined;
    if (result.kind === "retryable_failure") {
      w.status = "ready";
      return { workerFree: true, pauseJob: false };
    }
    // Unsupported UI or a login/CAPTCHA wall: stop feeding this page.
    w.status = "paused";
    return { workerFree: false, pauseJob: pauseOnError || result.kind === "unsupported" };
  }
  // Prompt may or may not have been sent: never resend into an uncertain page,
  // and count it against the submission ceiling.
  job.submittedCount = (job.submittedCount ?? 0) + 1;
  t.trackStatus = "needs_attention";
  w.status = "paused";
  return { workerFree: false, pauseJob: pauseOnError };
}

export function recordGenerationResult(
  job: AlbumJob, workerId: string, trackId: string,
  result: ActionResult<GenerationEvidence>, pauseOnError: boolean, now = Date.now(),
): Outcome {
  if (!ownsTrack(job, workerId, trackId)) return { workerFree: false, pauseJob: false };
  const t = track(job, trackId);
  if (t.trackStatus !== "generating") return { workerFree: false, pauseJob: false };
  const w = worker(job, workerId);
  w.lastHeartbeatAt = now;
  w.currentTrackId = undefined;
  touch(t, now);

  if (result.kind === "success" && !titleMatches(t.plannedTitle, result.data.flowTitle)) {
    // We set the title in Compose: a different title means this is not
    // (provably) our song.
    t.trackStatus = "needs_attention";
    t.lastErrorCode = "title_mismatch";
    t.lastErrorMessage = `expected "${expectedFlowTitle(t.plannedTitle)}", saw "${result.data.flowTitle ?? ""}"`;
    w.status = "paused";
    w.lastError = "title_mismatch";
    return { workerFree: false, pauseJob: pauseOnError };
  }
  if (result.kind === "success") {
    const ids = songIdsOf(result.data);
    const foreign = ids.filter((id) => job.songs.some((s) => s.songId === id && s.trackId !== trackId));
    if (ids.length === 0 || foreign.length > 0) {
      // Without a UUID a song cannot be downloaded or placed safely, and an id
      // already owned by another prompt means attribution went wrong.
      t.trackStatus = "needs_attention";
      t.lastErrorCode = ids.length === 0 ? "result_unidentified" : "song_already_claimed";
      w.status = "paused";
      w.lastError = t.lastErrorCode;
      return { workerFree: false, pauseJob: pauseOnError };
    }
    t.trackStatus = "generated";
    t.generatedAt = now;
    t.flowSongId = ids[0];
    t.flowSongIds = ids;
    t.flowTitle = result.data.flowTitle;
    t.flowCreatedAt = result.data.flowCreatedAt;
    t.identityConfidence = "high";
    t.lastErrorCode = undefined;
    t.lastErrorMessage = undefined;
    registerSongs(job, t, ids, now);
    w.status = "ready";
    w.lastError = undefined;
    return { workerFree: true, pauseJob: false };
  }

  t.lastErrorCode = result.code;
  t.lastErrorMessage = result.detail;
  w.lastError = result.code;
  // The site explicitly reported a failed generation: page state is known,
  // so the worker can continue with the next song.
  if (result.kind === "retryable_failure" && result.code === "generation_failed_on_site") {
    t.trackStatus = "generation_failed";
    w.status = "ready";
    return { workerFree: true, pauseJob: pauseOnError };
  }
  // Anything else (timeout, unknown UI, quota, captcha) is uncertain.
  t.trackStatus = "needs_attention";
  w.status = "paused";
  return { workerFree: false, pauseJob: pauseOnError || result.code === "quota" };
}

/** The worker's tab disappeared or became unusable. */
export function recordWorkerLost(job: AlbumJob, workerId: string, reason: string, now = Date.now()): void {
  const w = worker(job, workerId);
  const current = w.currentTrackId ? track(job, w.currentTrackId) : undefined;
  if (current) {
    touch(current, now);
    current.lastErrorCode = reason;
    // "assigned" means the submit request was already sent: the Generate
    // click may have happened even though no acceptance was recorded. Only a
    // verified pre-click failure (recordSubmitFailure) may requeue a prompt.
    if (current.trackStatus === "assigned" || current.trackStatus === "generating") {
      current.trackStatus = "needs_attention";
    }
  }
  w.status = "error";
  w.lastError = reason;
  w.currentTrackId = undefined;
  w.tabId = undefined;
}

const OPEN_TRACK = new Set(["draft", "queued", "assigned", "generating"]);

export function generationSettled(job: AlbumJob): boolean {
  return job.tracks.every((t) => !OPEN_TRACK.has(t.trackStatus));
}

export function retryGeneration(job: AlbumJob, now = Date.now()): number {
  if (openBatch(job, "download") || openBatch(job, "playlist")) throw new Error("batch_in_progress");
  let n = 0;
  for (const t of job.tracks) {
    if (t.trackStatus === "generation_failed" || t.trackStatus === "needs_attention") {
      t.trackStatus = "queued";
      t.workerId = undefined;
      touch(t, now);
      n++;
    }
  }
  if (n > 0 && job.phase !== "generating") {
    job.resumePhase = undefined;
    job.phase = "generating";
  }
  return n;
}

// ------------------------------------------------------- pause / stop / resume

export function pauseJob(job: AlbumJob, code?: string): void {
  if (!isActivePhase(job.phase)) return;
  job.resumePhase = job.phase;
  job.phase = code ? "needs_attention" : "paused";
  job.attentionCode = code;
}

export function resumeJob(job: AlbumJob): void {
  if (job.phase !== "paused" && job.phase !== "needs_attention" && job.phase !== "stopped") return;
  job.phase = job.resumePhase ?? "generating";
  job.resumePhase = undefined;
  job.attentionCode = undefined;
  // User resume releases paused workers. Their uncertain tracks stay
  // needs_attention until the user explicitly retries them.
  for (const w of job.workerStates) {
    if (w.status === "paused" && !w.currentTrackId) w.status = "ready";
    // Idle workers start gradually again; in-flight ones keep running.
    if (!w.currentTrackId) {
      w.rampedAt = undefined;
      w.startAfter = undefined;
    }
  }
  job.lastRampAt = job.workerStates.some((w) => w.currentTrackId) ? Date.now() : undefined;
  job.recentOutcomes = [];
}

// --------------------------------------------------------------- credits

export type CreditAssessment =
  | { status: "ok"; delta: number }
  | { status: "unreadable"; delta: null }
  | { status: "unexpected_spend"; delta: number }
  | { status: "below_floor"; delta: number };

/**
 * Judges one generation's balance change. The balance's meaning is not
 * verified, so an unreadable value is never treated as "fine": it stops new
 * generations until a person looks.
 */
export function assessCredits(
  before: number | null | undefined, after: number | null | undefined,
  policy: { maxSpendPerSong: number; minBalance: number },
): CreditAssessment {
  if (typeof before !== "number" || typeof after !== "number") return { status: "unreadable", delta: null };
  const delta = after - before;
  if (-delta > policy.maxSpendPerSong) return { status: "unexpected_spend", delta };
  if (after < policy.minBalance) return { status: "below_floor", delta };
  return { status: "ok", delta };
}

export function recordCredits(job: AlbumJob, trackId: string, when: "before" | "after", value: number | null): void {
  const t = track(job, trackId);
  if (when === "before") t.creditsBefore = value;
  else t.creditsAfter = value;
}

// -------------------------------------------------------------- backoff

/** Codes that mean "something on the page/account blocks work": stop assigning at once. */
export const BLOCKER_RESULT_CODES = new Set([
  "blocked", "blocked_after_submit", "quota", "rate_limit", "login", "captcha", "modal", "alert", "left_flow",
  // Automatic mode: the on-page form check failed, or credits look wrong.
  "form_check_failed", "credits_unreadable", "credits_unexpected_spend", "credits_below_floor",
  // The song may already exist outside the ledger.
  "title_already_on_page",
]);

/** Codes that count towards the suspicious-failure-rate check. */
export const FAILURE_RESULT_CODES = new Set([
  "generation_failed_on_site", "generation_timeout", "indicator_cleared_without_result",
  "result_unidentified", "result_ambiguous", "title_mismatch", "accept_unconfirmed", "submit_no_response",
  "result_unknown",
]);

const LOWER_OPTION: Record<WorkerCount, WorkerCount> = { 10: 8, 8: 6, 6: 4, 4: 2, 2: 1, 1: 1 };

export interface Backoff {
  /** Pause new assignments with this attention code. */
  pauseCode?: string;
  /** Concurrency was lowered to this (never interrupts running work). */
  reducedTo?: WorkerCount;
}

/**
 * Records a generation outcome and decides whether to stop assigning work.
 * A blocker pauses immediately. Two failures among the last three outcomes
 * pause and lower concurrency one step. Nothing here resubmits anything.
 */
export function applyBackoff(job: AlbumJob, ok: boolean, code: string | undefined, now = Date.now()): Backoff {
  if (!ok && code && BLOCKER_RESULT_CODES.has(code)) {
    pauseJob(job, code);
    return { pauseCode: code };
  }
  if (!ok && code && !FAILURE_RESULT_CODES.has(code)) return {};
  const recent = [...(job.recentOutcomes ?? []), { at: now, ok, code }].slice(-6);
  job.recentOutcomes = recent;
  const lastThree = recent.slice(-3);
  if (!ok && lastThree.filter((o) => !o.ok).length >= 2) {
    const reducedTo = LOWER_OPTION[job.workerCount];
    const changed = reducedTo !== job.workerCount;
    job.workerCount = reducedTo;
    pauseJob(job, "failure_rate");
    job.recentOutcomes = [];
    return changed ? { pauseCode: "failure_rate", reducedTo } : { pauseCode: "failure_rate" };
  }
  return {};
}

// ------------------------------------------------------- worker recovery

/** Whether one more replacement tab may be opened (bounded per job). */
export function canReplaceWorker(job: AlbumJob): boolean {
  return job.phase === "generating" &&
    (job.workerReplacements ?? 0) < TIMING.maxWorkerReplacements &&
    job.tracks.some((t) => t.trackStatus === "queued");
}

export function noteReplacement(job: AlbumJob): void {
  job.workerReplacements = (job.workerReplacements ?? 0) + 1;
}

export function stopJob(job: AlbumJob): void {
  if (job.phase === "completed" || job.phase === "draft") return;
  job.resumePhase = isActivePhase(job.phase) ? job.phase : job.resumePhase;
  job.phase = "stopped";
  // In-flight prompts (submit sent, generating, or being verified) keep their
  // worker so the pending submit/watch can still record the real outcome.
  // Requeuing them here could send the same prompt to Flow twice.
  const inFlight = new Set<WorkerState["status"]>(["submitting", "generating", "verifying", "error"]);
  for (const w of job.workerStates) {
    if (!inFlight.has(w.status) && !w.currentTrackId) w.status = "idle";
  }
}

/** True while some prompt may currently be generating on Flow. */
export function hasInFlightPrompt(job: AlbumJob): boolean {
  return job.tracks.some((t) => t.trackStatus === "assigned" || t.trackStatus === "generating");
}

export function setWorkerCount(job: AlbumJob, count: WorkerCount): void {
  job.workerCount = count;
}

// ------------------------------------------------------------------- songs

/** All song UUIDs of one generation, de-duplicated, page order kept. */
export function songIdsOf(evidence: GenerationEvidence): string[] {
  const ids = evidence.flowSongIds?.length ? evidence.flowSongIds : evidence.flowSongId ? [evidence.flowSongId] : [];
  return [...new Set(ids.filter(Boolean))];
}

/** Adds one SongRecord per UUID. Idempotent: a known UUID is never added twice. */
export function registerSongs(job: AlbumJob, t: TrackRecord, ids: string[], now = Date.now()): SongRecord[] {
  const added: SongRecord[] = [];
  ids.forEach((songId, version) => {
    if (job.songs.some((s) => s.songId === songId)) return;
    const s: SongRecord = {
      songId,
      trackId: t.trackId,
      version,
      title: t.flowTitle ?? t.plannedTitle,
      generatedAt: t.generatedAt ?? now,
      downloadStatus: "not_started",
      playlistStatus: "not_started",
      updatedAt: now,
    };
    job.songs.push(s);
    added.push(s);
  });
  return added;
}

export function song(job: AlbumJob, songId: string): SongRecord {
  const s = job.songs.find((x) => x.songId === songId);
  if (!s) throw new Error(`unknown_song:${songId}`);
  return s;
}

export function songsOfTrack(job: AlbumJob, trackId: string): SongRecord[] {
  return job.songs.filter((s) => s.trackId === trackId).sort((a, b) => a.version - b.version);
}

function touchSong(s: SongRecord, now: number) {
  s.updatedAt = now;
}

export interface JobCounts {
  promptsTotal: number;
  promptsDone: number;
  songsFound: number;
  songsDownloaded: number;
  songsAdded: number;
}

export function jobCounts(job: AlbumJob): JobCounts {
  return {
    promptsTotal: job.tracks.length,
    promptsDone: job.tracks.filter((t) => t.trackStatus === "generated").length,
    songsFound: job.songs.length,
    songsDownloaded: job.songs.filter((s) => s.downloadStatus === "downloaded").length,
    songsAdded: job.songs.filter((s) => s.playlistStatus === "added").length,
  };
}

// ------------------------------------------------------- downloads / playlist

export type BatchKind = BatchRecord["kind"];

function batches(job: AlbumJob, kind: BatchKind): BatchRecord[] {
  return kind === "download" ? job.downloadBatches : job.playlistBatches;
}

const OPEN_BATCH: BatchStatus[] = ["pending", "selecting", "downloading", "adding", "verifying"];

export function openBatch(job: AlbumJob, kind: BatchKind): BatchRecord | undefined {
  return batches(job, kind)
    .filter((b) => OPEN_BATCH.includes(b.status))
    .sort((a, b) => a.index - b.index)[0];
}

function inOpenBatch(job: AlbumJob, kind: BatchKind): Set<string> {
  return new Set(batches(job, kind).filter((b) => OPEN_BATCH.includes(b.status)).flatMap((b) => b.songIds));
}

/**
 * Songs that may be downloaded. `includeRetry` adds songs whose download
 * definitely failed. Songs in `verification_needed` are never included: a
 * file may already exist, so they wait for the user to verify.
 */
export function eligibleForDownload(job: AlbumJob, includeRetry = false): SongRecord[] {
  const ok = includeRetry ? ["not_started", "download_failed"] : ["not_started"];
  const queued = inOpenBatch(job, "download");
  return job.songs.filter((s) => ok.includes(s.downloadStatus) && !queued.has(s.songId));
}

/** Downloaded songs not yet in the playlist. Unverified adds are never repeated. */
export function eligibleForPlaylist(job: AlbumJob, includeRetry = false): SongRecord[] {
  const ok = includeRetry ? ["not_started", "add_failed"] : ["not_started"];
  const queued = inOpenBatch(job, "playlist");
  // Downloads always precede playlist placement.
  return job.songs.filter(
    (s) => s.downloadStatus === "downloaded" && ok.includes(s.playlistStatus) && !queued.has(s.songId),
  );
}

/**
 * Appends batches for the given song UUIDs, which must already be
 * oldest-first. Batches are sized by songs (max 100), not by prompts. Unknown,
 * duplicate, already-done or already-queued UUIDs are dropped, so a song can
 * never end up in two live batches.
 */
export function planBatches(job: AlbumJob, kind: BatchKind, orderedSongIds: string[]): BatchRecord[] {
  const list = batches(job, kind);
  const queued = inOpenBatch(job, kind);
  const allowed = new Set(
    (kind === "download" ? eligibleForDownload(job, true) : eligibleForPlaylist(job, true)).map((s) => s.songId),
  );
  const ids = [...new Set(orderedSongIds)].filter((id) => allowed.has(id) && !queued.has(id));
  const created = chunk(ids, job.downloadBatchSize).map<BatchRecord>((songIds, i) => ({
    kind,
    index: list.length + i,
    songIds,
    status: "pending",
    attempts: 0,
  }));
  list.push(...created);
  return created;
}

export function batch(job: AlbumJob, kind: BatchKind, index: number): BatchRecord {
  const b = batches(job, kind).find((x) => x.index === index);
  if (!b) throw new Error(`unknown_batch:${kind}:${index}`);
  return b;
}

export function setBatchStatus(
  job: AlbumJob, kind: BatchKind, index: number, status: BatchStatus, now = Date.now(),
): BatchRecord {
  const b = batch(job, kind, index);
  b.status = status;
  if (status === "selecting") {
    b.attempts += 1;
    b.startedAt = now;
  }
  for (const id of b.songIds) {
    const s = song(job, id);
    if (kind === "download" && (status === "selecting" || status === "downloading")) s.downloadStatus = status;
    if (kind === "playlist" && (status === "selecting" || status === "adding")) s.playlistStatus = status;
    touchSong(s, now);
  }
  return b;
}

/** Puts a batch that never reached its side-effecting click back to pending. */
export function resetUnclickedBatch(job: AlbumJob, kind: BatchKind, index: number, now = Date.now()): void {
  const b = batch(job, kind, index);
  b.status = "pending";
  for (const id of b.songIds) {
    const s = song(job, id);
    if (kind === "download") s.downloadStatus = "not_started";
    else s.playlistStatus = "not_started";
    touchSong(s, now);
  }
}

export type DownloadOutcome =
  /** Per-song association (preferred): each song gets its own status. */
  | {
      kind: "per_song";
      batchStatus: "completed" | "failed" | "partial";
      downloadIds: number[];
      files: string[];
      perSong: Record<string, { status: "downloaded" | "download_failed" | "verification_needed"; files?: string[]; code?: string }>;
    }
  | { kind: "verified"; downloadIds: number[]; files: string[]; perSong?: Record<string, string[]> }
  | { kind: "failed"; code: string; downloadIds?: number[] }
  | { kind: "ambiguous"; code: string; downloadIds?: number[]; files?: string[] };

/** Applies a reconciled download result. Never touches generation status. */
export function applyDownloadOutcome(
  job: AlbumJob, index: number, outcome: DownloadOutcome, now = Date.now(),
): void {
  const b = batch(job, "download", index);
  b.finishedAt = now;
  b.downloadIds = outcome.downloadIds;
  if (outcome.kind === "per_song") {
    b.files = outcome.files;
    b.status = outcome.batchStatus;
    b.errorCode = outcome.batchStatus === "completed" ? undefined : "per_song_issues";
    for (const id of b.songIds) {
      const s = song(job, id);
      // A song the reconciliation knows nothing about stays uncertain.
      const r = outcome.perSong[id] ?? { status: "verification_needed" as const, code: "no_result" };
      s.downloadStatus = r.status;
      s.downloadIds = outcome.downloadIds;
      if (r.files) s.downloadedFiles = r.files;
      s.lastErrorCode = r.status === "downloaded" ? undefined : r.code;
      touchSong(s, now);
    }
    job.lastProcessedDownloadBatch = Math.max(job.lastProcessedDownloadBatch ?? -1, index);
    return;
  }
  if (outcome.kind !== "failed") b.files = outcome.files;
  b.status = outcome.kind === "verified" ? "completed" : outcome.kind === "failed" ? "failed" : "partial";
  if (outcome.kind !== "verified") b.errorCode = outcome.code;
  for (const id of b.songIds) {
    const s = song(job, id);
    touchSong(s, now);
    if (outcome.kind === "verified") {
      s.downloadStatus = "downloaded";
      s.downloadIds = outcome.downloadIds;
      s.downloadedFiles = outcome.perSong?.[id] ?? outcome.files;
      s.lastErrorCode = undefined;
    } else if (outcome.kind === "failed") {
      s.downloadStatus = "download_failed";
      s.lastErrorCode = outcome.code;
    } else {
      s.downloadStatus = "verification_needed";
      s.lastErrorCode = outcome.code;
    }
  }
  job.lastProcessedDownloadBatch = Math.max(job.lastProcessedDownloadBatch ?? -1, index);
}

export type PlaylistOutcome =
  | { kind: "added"; playlistIdentity: string }
  | { kind: "failed"; code: string }
  | { kind: "ambiguous"; code: string };

/** Applies a playlist result. Never touches download status. */
export function applyPlaylistOutcome(
  job: AlbumJob, index: number, outcome: PlaylistOutcome, now = Date.now(),
): void {
  const b = batch(job, "playlist", index);
  b.finishedAt = now;
  b.status = outcome.kind === "added" ? "completed" : outcome.kind === "failed" ? "failed" : "partial";
  if (outcome.kind !== "added") b.errorCode = outcome.code;
  for (const id of b.songIds) {
    const s = song(job, id);
    touchSong(s, now);
    if (outcome.kind === "added") {
      s.playlistStatus = "added";
      s.playlistIdentity = outcome.playlistIdentity;
      s.lastErrorCode = undefined;
    } else {
      s.playlistStatus = outcome.kind === "failed" ? "add_failed" : "verification_needed";
      s.lastErrorCode = outcome.code;
    }
  }
  job.lastProcessedPlaylistBatch = Math.max(job.lastProcessedPlaylistBatch ?? -1, index);
}

/** Album order: original track number, then version within the track. */
export function orderByAlbum<T extends { songId: string }>(items: T[], job: AlbumJob): T[] {
  const trackIndex = new Map(job.tracks.map((t) => [t.trackId, t.index]));
  const key = (id: string) => {
    const s = job.songs.find((x) => x.songId === id);
    return s ? [trackIndex.get(s.trackId) ?? 1e9, s.version] : [1e9, 0];
  };
  return [...items].sort((a, b) => {
    const [ta, va] = key(a.songId);
    const [tb, vb] = key(b.songId);
    return ta! - tb! || va! - vb!;
  });
}

/** Marks songs that cannot be found on My Songs without inventing a match. */
export function markUnmatched(job: AlbumJob, kind: BatchKind, songIds: string[], code: string, now = Date.now()): void {
  for (const id of songIds) {
    const s = song(job, id);
    if (kind === "download") s.downloadStatus = "verification_needed";
    else s.playlistStatus = "verification_needed";
    s.lastErrorCode = code;
    touchSong(s, now);
  }
}

/** Moves to the next phase when the current one has nothing left to do. */
export function advancePhase(job: AlbumJob): JobPhase {
  if (job.phase === "generating" && generationSettled(job)) {
    job.phase = "downloads";
  }
  if (job.phase === "downloads" && !openBatch(job, "download") && eligibleForDownload(job).length === 0) {
    job.phase = "playlist";
  }
  if (job.phase === "playlist" && !openBatch(job, "playlist") && eligibleForPlaylist(job).length === 0) {
    job.phase = "completed";
  }
  return job.phase;
}

/**
 * Explicit "process completed songs now": run downloads for songs generated
 * so far, without waiting for the rest of the album. Generation is paused
 * and resumes afterwards from the stored queue.
 */
export function processCompletedNow(job: AlbumJob): boolean {
  if (job.phase !== "generating" && job.phase !== "paused" && job.phase !== "stopped") return false;
  if (eligibleForDownload(job).length === 0) return false;
  job.resumePhase = undefined;
  job.phase = "downloads";
  return true;
}

// ------------------------------------------------------------------- recovery

export interface RecoveryReport {
  lostWorkers: string[];
  probeWorkers: string[];
  resetBatches: { kind: BatchKind; index: number }[];
  verifyDownloadBatches: number[];
  ambiguousPlaylistBatches: number[];
}

/**
 * Reconciles persisted state after a service-worker restart or browser
 * restart. Nothing is resubmitted, redownloaded or re-added here; uncertain
 * work is flagged for probing/verification instead.
 */
export function recoverJob(job: AlbumJob, liveTabIds: Set<number>, now = Date.now()): RecoveryReport {
  const report: RecoveryReport = {
    lostWorkers: [], probeWorkers: [], resetBatches: [], verifyDownloadBatches: [], ambiguousPlaylistBatches: [],
  };
  for (const w of job.workerStates) {
    if (w.status === "error") continue;
    if (w.tabId === undefined || !liveTabIds.has(w.tabId)) {
      recordWorkerLost(job, w.workerId, "tab_closed", now);
      report.lostWorkers.push(w.workerId);
    } else if (w.status === "submitting" || w.status === "generating" || w.status === "verifying") {
      // Submission or completion unknown: ask the page before doing anything.
      w.status = "verifying";
      report.probeWorkers.push(w.workerId);
    } else if (w.status === "loading") {
      w.status = "idle";
    }
  }
  for (const b of job.downloadBatches) {
    if (b.status === "selecting") {
      resetUnclickedBatch(job, "download", b.index, now);
      report.resetBatches.push({ kind: "download", index: b.index });
    } else if (b.status === "downloading" || b.status === "verifying") {
      b.status = "verifying";
      report.verifyDownloadBatches.push(b.index);
    }
  }
  for (const b of job.playlistBatches) {
    if (b.status === "selecting") {
      resetUnclickedBatch(job, "playlist", b.index, now);
      report.resetBatches.push({ kind: "playlist", index: b.index });
    } else if (b.status === "adding" || b.status === "verifying") {
      // Membership unknown: do not blindly add again.
      applyPlaylistOutcome(job, b.index, { kind: "ambiguous", code: "interrupted_during_add" }, now);
      report.ambiguousPlaylistBatches.push(b.index);
    }
  }
  return report;
}

/** Probe answer for a worker whose submission/generation state was unknown. */
export function applyProbe(
  job: AlbumJob, workerId: string, evidence: GenerationEvidence | null | "still_generating", now = Date.now(),
): Outcome {
  const w = worker(job, workerId);
  const t = w.currentTrackId ? track(job, w.currentTrackId) : undefined;
  if (!t) {
    w.status = "ready";
    return { workerFree: true, pauseJob: false };
  }
  if (evidence === "still_generating") {
    if (t.trackStatus === "assigned") {
      t.trackStatus = "generating";
      t.submittedAt ??= now;
    }
    w.status = "generating";
    w.lastHeartbeatAt = now;
    return { workerFree: false, pauseJob: false };
  }
  if (t.trackStatus === "assigned") t.trackStatus = "generating";
  if (evidence) return recordGenerationResult(job, workerId, t.trackId, { kind: "success", data: evidence }, false, now);
  return recordGenerationResult(job, workerId, t.trackId, { kind: "needs_attention", code: "result_unknown" }, false, now);
}
