import { CREDIT_POLICY, FLOW_ORIGIN, FLOW_URLS, MAX_SONGS, MIN_SONGS, TIMING } from "../shared/constants";
import { FEATURES, VERIFIED_MAX_WORKERS } from "../shared/features";
import { createLogger } from "../shared/logger";
import {
  NOT_SUBMITTED_CODES, type Command, type CommandResponse, type PageEvent,
} from "../shared/messages";
import type {
  ActionResult, AlbumJob, FlowSong, PlaylistRef, SongRecord,
} from "../shared/types";
import { parseBrief } from "../prompt/brief-parser";
import { planAlbum } from "../prompt/local-planner";
import type { Repository } from "../storage/repository";
import * as downloads from "./download-manager";
import {
  addWorker, advancePhase, applyDownloadOutcome, applyPlaylistOutcome, applyProbe, claimNextTrack,
  applyBackoff, assessCredits, canReplaceWorker, createJob, recordCredits, orderByAlbum, editPrompt, expectedFlowTitle, noteReplacement, staggerGapMs, validateStart, eligibleForDownload, eligibleForPlaylist, generationSettled, hasInFlightPrompt, isActivePhase,
  markSubmitted, markUnmatched, markWorkerReady, openBatch, pauseJob, planBatches,
  processCompletedNow, recordGenerationResult, recordSubmitFailure, recordWorkerLost, recoverJob,
  resetUnclickedBatch, resumeJob, retryGeneration, setBatchStatus, setWorkerCount, song, startGeneration,
  stopJob, workerByTab, type Outcome,
} from "./job-logic";
import { matchSongs } from "./matcher";
import {
  ensurePageTab, keepAlive, liveFlowTabIds, openTab, pageStateOf, sendToTab, TransportError, waitForPage,
} from "./tab-manager";

const log = createLogger("orchestrator");

const BLOCKER_CODES = new Set(["login", "captcha", "quota", "modal"]);
// Failures that happen before the bulk action's side-effecting click.
const PRE_CLICK_CODES = new Set([
  "selector_unverified", "wrong_page", "blocked", "selection_count_mismatch", "selection_not_cleared",
  "target_missing", "target_ambiguous", "target_disabled", "batch_size_invalid", "song_not_found", "song_ambiguous",
]);
// Playlist chooser failures: chooser opened, nothing added.
const PICKER_CODES = new Set([
  "playlist_not_found", "playlist_ambiguous", "playlist_picker_missing", "playlist_name_input_missing",
]);

type Failure = Exclude<ActionResult, { kind: "success" }>;

// Rows are located by UUID; the title is carried for logs only.
function songOf(s: SongRecord): FlowSong {
  return { flowSongId: s.songId, title: s.title, listIndex: 0 };
}

export class Orchestrator {
  private readonly ready: Promise<void>;
  private pumping = false;
  private pumpAgain = false;
  private bulkBusy = false;
  private downloadChain: Promise<unknown> = Promise.resolve();
  private libraryTabId?: number;
  private starting = false;
  private readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pingMisses = new Map<string, number>();

  constructor(private readonly repo: Repository) {
    this.ready = this.recover().catch((err) => log.error("recovery failed", String(err)));
  }

  // ---------------------------------------------------------------- commands

  async handleCommand(cmd: Command): Promise<CommandResponse> {
    await this.ready;
    try {
      const data = await this.command(cmd);
      void this.pushDebug();
      return { ok: true, data };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("command failed", { type: cmd.type, error });
      return { ok: false, error };
    }
  }

  private async command(cmd: Command): Promise<unknown> {
    switch (cmd.type) {
      case "plan": {
        await this.assertNoActiveJob();
        const plan = planAlbum({ description: cmd.description }, cmd.songCount);
        const settings = await this.repo.updateSettings({ draftDescription: cmd.description, draftSongCount: cmd.songCount });
        await this.repo.replaceJob(createJob(plan, {
          description: cmd.description,
          workerCount: settings.workerCount,
          playlistMode: settings.playlistMode,
          downloadBatchSize: settings.downloadBatchSize,
        }));
        return { warnings: plan.warnings };
      }
      case "start":
        return this.start(cmd);
      case "pause":
        await this.repo.mutateJob((job) => pauseJob(job));
        return;
      case "resume":
        await this.repo.mutateJob((job) => resumeJob(job));
        await this.ensureWorkerTabs();
        // Workers idled by Stop re-check their page before taking new prompts.
        void this.bootWorkers();
        void this.pump();
        return;
      case "stop":
        await this.repo.mutateJob((job) => stopJob(job));
        return;
      case "processCompleted": {
        const ok = await this.repo.mutateJob((job) => processCompletedNow(job));
        if (!ok) throw new Error("nothing_to_process");
        void this.pump();
        return;
      }
      case "retry":
        await this.retry(cmd.phase);
        void this.pump();
        return;
      case "editPrompt":
        await this.repo.mutateJob((job) => editPrompt(job, cmd.trackId, cmd.prompt));
        return;
      case "setWorkerCount":
        if (FEATURES.submission && cmd.workerCount > VERIFIED_MAX_WORKERS) throw new Error("workers_unverified");
        await this.repo.updateSettings({ workerCount: cmd.workerCount });
        if (await this.repo.getJob()) {
          await this.repo.mutateJob((job) => setWorkerCount(job, cmd.workerCount));
          await this.ensureWorkerTabs();
          void this.pump();
        }
        return;
      case "selectPlaylist":
        await this.repo.updateSettings({ playlist: cmd.playlist, playlistMode: "existing" });
        if (await this.repo.getJob()) {
          await this.repo.mutateJob((job) => {
            job.playlistMode = "existing";
            job.playlistIdentity = cmd.playlist.identity;
            job.playlistName = cmd.playlist.name;
            if (job.phase === "needs_attention" && job.attentionCode?.startsWith("playlist")) resumeJob(job);
          });
          void this.pump();
        }
        return;
      case "listPlaylists":
        return this.listPlaylists();
      case "updateSettings": {
        const settings = await this.repo.updateSettings(cmd.patch);
        const job = await this.repo.getJob();
        // Batch size only applies to batches not yet planned.
        if (job && cmd.patch.downloadBatchSize !== undefined && job.downloadBatches.length === 0) {
          await this.repo.mutateJob((j) => (j.downloadBatchSize = settings.downloadBatchSize));
        }
        return settings;
      }
      case "discardJob": {
        const job = await this.repo.getJob();
        if (job && isActivePhase(job.phase)) throw new Error("job_active");
        await this.repo.replaceJob(null);
        await downloads.setActive(null);
        return;
      }
    }
  }

  private async assertNoActiveJob(): Promise<void> {
    const job = await this.repo.getJob();
    if (job && !["draft", "completed", "stopped"].includes(job.phase)) throw new Error("job_active");
    // A stopped job may still have a prompt generating on Flow; replacing the
    // ledger now would lose its result and could lead to a duplicate later.
    if (job && hasInFlightPrompt(job)) throw new Error("job_active");
  }

  private async start(cmd: Extract<Command, { type: "start" }>): Promise<unknown> {
    // Two Start commands racing would each open tabs and plan a job.
    if (this.starting) throw new Error("job_active");
    this.starting = true;
    try {
      return await this.startUnlocked(cmd);
    } finally {
      this.starting = false;
    }
  }

  private async startUnlocked(cmd: Extract<Command, { type: "start" }>): Promise<unknown> {
    const invalid = validateStart(cmd, FEATURES.playlist, FEATURES.submission ? VERIFIED_MAX_WORKERS : Infinity);
    if (invalid) throw new Error(invalid);
    const description = cmd.description.trim();
    await this.assertNoActiveJob();

    // The tab the user started from becomes worker 1 if it is a usable session.
    let firstTab: number | undefined;
    if (cmd.tabId !== undefined) {
      const state = await pageStateOf(cmd.tabId);
      if (state?.blocker === "login") throw new Error("login_required");
      if (state?.blocker === "captcha") throw new Error("captcha");
      if (state?.kind === "session" && !state.blocker) firstTab = cmd.tabId;
    }

    const settings = await this.repo.updateSettings({
      draftDescription: description,
      draftSongCount: cmd.songCount,
      workerCount: cmd.workerCount,
      playlistMode: cmd.playlistMode,
      playlist: cmd.playlist,
      newPlaylistName: cmd.newPlaylistName,
    });

    // Reuse a reviewed draft (keeps prompt edits) when it matches the input.
    const existing = await this.repo.getJob();
    const job = existing && existing.phase === "draft" && existing.inputDescription === description && existing.songCount === cmd.songCount
      ? existing
      : createJob(planAlbum({ description }, cmd.songCount), {
          description,
          workerCount: cmd.workerCount,
          playlistMode: cmd.playlistMode,
          downloadBatchSize: settings.downloadBatchSize,
        });
    job.workerCount = cmd.workerCount;
    job.playlistMode = cmd.playlistMode;
    job.playlistIdentity = cmd.playlistMode === "existing" ? cmd.playlist?.identity : undefined;
    job.playlistName = cmd.playlistMode === "existing" ? cmd.playlist?.name : cmd.newPlaylistName?.trim();
    job.playlistCreated = false;
    job.workerStates = [];
    job.downloadBatches = [];
    job.playlistBatches = [];
    startGeneration(job);

    if (firstTab !== undefined) await keepAlive(firstTab);
    firstTab ??= await openTab(FLOW_URLS.session, true);
    addWorker(job, firstTab);
    await this.repo.replaceJob(job);
    await this.ensureWorkerTabs();
    void this.bootWorkers();
    return { albumId: job.albumId };
  }

  private async retry(phase: "generation" | "downloads" | "playlist"): Promise<void> {
    await this.repo.mutateJob((job) => {
      if (phase === "generation") {
        retryGeneration(job);
        return;
      }
      if (openBatch(job, "download") || openBatch(job, "playlist")) throw new Error("batch_in_progress");
      // Only definite failures are retried. "verification_needed" means a file
      // or playlist entry may already exist, so it is never redone blindly.
      for (const s of job.songs) {
        if (phase === "downloads" && s.downloadStatus === "download_failed") s.downloadStatus = "not_started";
        if (phase === "playlist" && s.playlistStatus === "add_failed") s.playlistStatus = "not_started";
      }
      job.resumePhase = undefined;
      job.attentionCode = undefined;
      job.phase = phase === "downloads" ? "downloads" : "playlist";
    });
  }

  private async listPlaylists(): Promise<PlaylistRef[]> {
    const { tabId, state, opened } = await ensurePageTab("playlists");
    try {
      if (!state) throw new Error("playlists_unavailable");
      if (state.blocker) throw new Error(state.blocker === "login" ? "login_required" : state.blocker);
      const res = await sendToTab(tabId, { type: "playlists.list" });
      if (res.kind !== "success") throw new Error(res.code);
      return res.data;
    } finally {
      if (opened) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------- generation

  /** Opens session tabs until the live worker count matches the job. */
  private async ensureWorkerTabs(): Promise<void> {
    const job = await this.repo.getJob();
    if (!job || job.phase !== "generating") return;
    const live = job.workerStates.filter((w) => w.status !== "error" && w.tabId !== undefined).length;
    const queued = job.tracks.filter((t) => t.trackStatus === "queued").length;
    await this.openWorkerTabs(Math.min(job.workerCount - live, queued));
  }

  private async openWorkerTabs(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const tabId = await openTab(FLOW_URLS.session);
      await this.repo.mutateJob((j) => addWorker(j, tabId));
    }
    if (count > 0) void this.bootWorkers();
  }

  /**
   * A worker's tab closed, crashed, stopped answering or left Flow. Its
   * in-flight track becomes needs-attention (never reassigned: it may have
   * been submitted). A bounded number of replacement tabs is opened.
   */
  private async loseWorker(workerId: string, reason: string): Promise<void> {
    this.pingMisses.delete(workerId);
    const replace = await this.repo.mutateJob((j) => {
      recordWorkerLost(j, workerId, reason);
      const live = j.workerStates.filter((w) => w.status !== "error" && w.tabId !== undefined).length;
      if (live < j.workerCount && canReplaceWorker(j)) {
        noteReplacement(j);
        return true;
      }
      return false;
    });
    log.warn("worker lost", { workerId, reason, replace });
    if (replace) await this.openWorkerTabs(1);
    void this.pump();
  }

  private async bootWorkers(): Promise<void> {
    const job = await this.repo.getJob();
    if (!job) return;
    await Promise.all(
      job.workerStates
        .filter((w) => (w.status === "loading" || w.status === "idle") && w.tabId !== undefined)
        .map(async (w) => {
          const state = await waitForPage(w.tabId!, "session");
          await this.applyWorkerPage(w.workerId, state);
        }),
    );
  }

  private async applyWorkerPage(workerId: string, state: Awaited<ReturnType<typeof pageStateOf>>): Promise<void> {
    const dispatch = await this.repo.mutateJob((job) => {
      const w = job.workerStates.find((x) => x.workerId === workerId);
      if (!w || w.status === "error") return false;
      if (!state || state.kind !== "session") {
        if (w.status === "loading") {
          w.status = "paused";
          w.lastError = "session_not_ready";
        }
        return false;
      }
      if (state.blocker) {
        if (!w.currentTrackId) {
          w.status = "paused";
          w.lastError = state.blocker;
        }
        return false;
      }
      const recoverable = w.status === "loading" || w.status === "idle" ||
        (w.status === "paused" && !w.currentTrackId && BLOCKER_CODES.has(w.lastError ?? "")) ||
        (w.status === "paused" && w.lastError === "session_not_ready");
      if (!recoverable) return false;
      w.status = "idle";
      w.lastError = undefined;
      markWorkerReady(job, workerId);
      return true;
    });
    if (dispatch) await this.dispatch(workerId);
  }

  private async dispatch(workerId: string): Promise<void> {
    const settings = await this.repo.getSettings();
    const now = Date.now();
    const { claimed, startAfter } = await this.repo.mutateJob((job) => {
      // Gradual start: each worker's first submission of a run waits 15–30 s
      // after the previous worker's; the claim itself enforces it atomically.
      const t = claimNextTrack(job, workerId, now, { stagger: staggerGapMs, maxSubmissions: MAX_SONGS });
      const w = job.workerStates.find((x) => x.workerId === workerId);
      return {
        claimed: t && w?.tabId !== undefined
          ? { trackId: t.trackId, prompt: t.prompt, title: expectedFlowTitle(t.plannedTitle), instrumental: parseBrief(job.inputDescription).instrumentalOnly, tabId: w.tabId }
          : null,
        startAfter: w?.startAfter,
      };
    });
    if (!claimed) {
      if (startAfter && startAfter > now) this.scheduleDispatch(workerId, startAfter - now);
      void this.pushDebug();
      return;
    }

    let result: ActionResult;
    // Credit guard (before): record the balance; an unreadable balance or one
    // under the floor stops here, before anything is typed or clicked.
    const before = FEATURES.creditMonitoring ? await this.readCredits(claimed.tabId) : undefined;
    if (FEATURES.creditMonitoring) await this.repo.mutateJob((job) => recordCredits(job, claimed.trackId, "before", before ?? null));
    const creditStop = !FEATURES.creditMonitoring ? null
      : typeof before !== "number" ? "credits_unreadable"
      : before < CREDIT_POLICY.minBalance ? "credits_below_floor" : null;
    try {
      result = creditStop
        ? { kind: "needs_attention", code: creditStop, detail: `balance=${before ?? "unreadable"}` }
        : await sendToTab(claimed.tabId, {
            type: "session.submit", trackId: claimed.trackId, prompt: claimed.prompt,
            title: claimed.title, instrumental: claimed.instrumental,
          });
    } catch (err) {
      // Lost contact mid-call: we cannot know whether Generate was clicked.
      result = { kind: "needs_attention", code: "submit_no_response", detail: String(err) };
    }

    if (result.kind !== "success") {
      const failure = result;
      const outcome = await this.repo.mutateJob((job) =>
        recordSubmitFailure(job, workerId, claimed.trackId, failure, NOT_SUBMITTED_CODES.has(failure.code), settings.pauseOnError),
      );
      log.warn("submit failed", { workerId, code: failure.code, detail: failure.detail });
      await this.afterResult(workerId, outcome, false, failure.code === "selector_unverified" ? "ui_unverified" : failure.code);
      return;
    }

    const submittedAt = Date.now();
    const ok = await this.repo.mutateJob((job) => markSubmitted(job, workerId, claimed.trackId, submittedAt));
    void this.pushDebug();
    if (!ok) return;
    let watch: ActionResult;
    try {
      watch = await sendToTab(claimed.tabId, {
        type: "session.watch", trackId: claimed.trackId, submittedAt, timeoutMs: settings.generationTimeoutMs,
      });
    } catch (err) {
      watch = { kind: "needs_attention", code: "watch_no_response", detail: String(err) };
    }
    if (watch.kind !== "success") {
      const failure = watch;
      const outcome = await this.repo.mutateJob((job) =>
        recordGenerationResult(job, workerId, claimed.trackId, failure, settings.pauseOnError),
      );
      await this.afterResult(workerId, outcome, false, failure.code);
    }
  }

  private async readCredits(tabId: number): Promise<number | null> {
    try {
      return (await sendToTab(tabId, { type: "page.credits" })).value;
    } catch {
      return null;
    }
  }

  /**
   * Credit guard (after): records the balance a few seconds after a result
   * and returns a stop code when it is unreadable, dropped more than allowed
   * for one song, or fell under the floor. The song itself stays recorded.
   */
  private async checkCreditsAfter(trackId: string, tabId: number): Promise<string | null> {
    if (!FEATURES.creditMonitoring) return null;
    await new Promise((r) => setTimeout(r, 3_000)); // let the sidebar update
    const after = await this.readCredits(tabId);
    const verdict = await this.repo.mutateJob((job) => {
      recordCredits(job, trackId, "after", after);
      const t = job.tracks.find((x) => x.trackId === trackId);
      return assessCredits(t?.creditsBefore, after, CREDIT_POLICY);
    });
    log.info("credits", { trackId, verdict });
    void this.pushDebug();
    return verdict.status === "ok" ? null : `credits_${verdict.status}`;
  }

  private scheduleDispatch(workerId: string, delayMs: number): void {
    if (this.startTimers.has(workerId)) return;
    // Best effort: if the service worker sleeps, the alarm tick dispatches instead.
    this.startTimers.set(workerId, setTimeout(() => {
      this.startTimers.delete(workerId);
      void this.dispatch(workerId);
    }, delayMs + 250));
  }

  /** Every generation outcome goes through backoff before the worker continues. */
  private async afterResult(workerId: string, outcome: Outcome, ok: boolean, code?: string): Promise<void> {
    const backoff = await this.repo.mutateJob((job) => applyBackoff(job, ok, code));
    if (backoff.pauseCode) log.warn("backoff", { code: backoff.pauseCode, reducedTo: backoff.reducedTo });
    if (backoff.pauseCode) {
      void this.pushDebug();
      void this.pump();
      return; // nothing new is assigned; in-flight work keeps being watched
    }
    await this.afterOutcome(workerId, outcome, code);
  }

  private async afterOutcome(workerId: string, outcome: Outcome, code?: string): Promise<void> {
    if (outcome.pauseJob) await this.repo.mutateJob((job) => pauseJob(job, code ?? "worker_error"));
    void this.pushDebug();
    if (outcome.workerFree) await this.dispatch(workerId);
    else void this.pump();
  }

  /** e2e build only: mirror the job onto worker pages for the supervisor. */
  private async pushDebug(): Promise<void> {
    if (!FEATURES.debugSnapshot) return;
    const job = await this.repo.getJob();
    if (!job) return;
    const snapshot = {
      at: Date.now(),
      phase: job.phase,
      attentionCode: job.attentionCode,
      workers: job.workerStates.map(({ workerId, tabId, status, currentTrackId, lastError }) => ({ workerId, tabId, status, currentTrackId, lastError })),
      submittedCount: job.submittedCount ?? 0,
      tracks: job.tracks.map(({ trackId, index, plannedTitle, trackStatus, attempts, submittedAt, generatedAt, flowSongIds, flowTitle, lastErrorCode, creditsBefore, creditsAfter }) =>
        ({ trackId, index, plannedTitle, trackStatus, attempts, submittedAt, generatedAt, flowSongIds, flowTitle, lastErrorCode, creditsBefore, creditsAfter })),
      songs: job.songs.map(({ songId, trackId, version, downloadStatus, playlistStatus }) => ({ songId, trackId, version, downloadStatus, playlistStatus })),
    };
    for (const w of job.workerStates) {
      if (w.tabId !== undefined) await sendToTab(w.tabId, { type: "debug.snapshot", snapshot }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ page events

  async onPageEvent(evt: PageEvent, tabId: number | undefined): Promise<void> {
    await this.ready;
    if (tabId === undefined) return;
    const job = await this.repo.getJob();
    const w = job ? workerByTab(job, tabId) : undefined;
    if (!job || !w) return;

    if (evt.type === "content.ready") {
      const inFlight = (w.status === "submitting" || w.status === "generating" || w.status === "verifying") && !!w.currentTrackId;
      // In-page navigation (Flow moves /session -> /session/<uuid> on the
      // first Generate) keeps the content script and its watcher alive.
      if (evt.navigation === "spa" && inFlight) return;
      // A real (re)load lost the watcher: ask the page instead of guessing.
      // (A reload during "submitting" is resolved by dispatch's own failed call.)
      if (inFlight && w.status !== "submitting") await this.probeWorker(w.workerId);
      else if (!inFlight) await this.applyWorkerPage(w.workerId, evt.page);
      return;
    }

    const settings = await this.repo.getSettings();
    const outcome = await this.repo.mutateJob((j) =>
      recordGenerationResult(j, w.workerId, evt.trackId, evt.result, settings.pauseOnError),
    );
    if (evt.result.kind === "success") log.info("generated", { workerId: w.workerId, trackId: evt.trackId });
    // A success with the wrong title is recorded as needs-attention by job logic.
    const recorded = (await this.repo.getJob())?.tracks.find((t) => t.trackId === evt.trackId);
    const ok = recorded?.trackStatus === "generated";
    const creditCode = ok ? await this.checkCreditsAfter(evt.trackId, tabId) : null;
    if (creditCode) {
      await this.afterResult(w.workerId, outcome, false, creditCode);
      return;
    }
    await this.afterResult(w.workerId, outcome, ok, ok ? undefined : recorded?.lastErrorCode ?? (evt.result.kind === "success" ? undefined : evt.result.code));
  }

  private async probeWorker(workerId: string): Promise<void> {
    const job = await this.repo.getJob();
    const w = job?.workerStates.find((x) => x.workerId === workerId);
    if (!job || !w || w.tabId === undefined || !w.currentTrackId) return;
    let res: Awaited<ReturnType<typeof sendToTab<"session.probe">>>;
    try {
      res = await sendToTab(w.tabId, { type: "session.probe", trackId: w.currentTrackId });
    } catch {
      return; // Unreachable right now; next tick retries or tab removal handles it.
    }
    const evidence = res.kind === "success" ? res.data : null;
    const trackId = w.currentTrackId;
    const outcome = await this.repo.mutateJob((j) => applyProbe(j, workerId, evidence));
    if (evidence === "still_generating") {
      // Re-arm completion detection. The page refuses (no_baseline) when it
      // cannot attribute the result; then a later probe flags it instead.
      const settings = await this.repo.getSettings();
      await sendToTab(w.tabId, { type: "session.watch", trackId, submittedAt: Date.now(), timeoutMs: settings.generationTimeoutMs })
        .catch(() => undefined);
      return;
    }
    const recorded = (await this.repo.getJob())?.tracks.find((t) => t.trackId === trackId);
    const ok = recorded?.trackStatus === "generated";
    const creditCode = ok ? await this.checkCreditsAfter(trackId, w.tabId) : null;
    if (creditCode) {
      await this.afterResult(workerId, outcome, false, creditCode);
      return;
    }
    await this.afterResult(workerId, outcome, ok, ok ? undefined : recorded?.lastErrorCode ?? "result_unknown");
  }

  async onTabRemoved(tabId: number): Promise<void> {
    await this.ready;
    if (tabId === this.libraryTabId) this.libraryTabId = undefined;
    const job = await this.repo.getJob();
    const w = job ? workerByTab(job, tabId) : undefined;
    if (!w || w.status === "error") return;
    await this.loseWorker(w.workerId, "tab_closed");
  }

  // -------------------------------------------------------------- downloads

  onDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
    return this.serializeDownloads(async () => {
      const active = await downloads.getActive();
      if (!active || !downloads.isFromFlow(item)) return;
      if (!downloads.withinAttributionWindow(active, Date.parse(item.startTime))) return;
      if (!active.ids.includes(item.id)) active.ids.push(item.id);
      await downloads.setActive(active);
      log.info("download attributed", { batch: active.batchIndex, id: item.id });
    });
  }

  async onDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    if (!delta.state) return;
    const active = await downloads.getActive();
    if (active?.ids.includes(delta.id)) void this.pump();
  }

  private serializeDownloads<T>(op: () => Promise<T>): Promise<T> {
    const next = this.downloadChain.then(op, op);
    this.downloadChain = next.catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------- pump

  /** Drives whatever the current phase needs next. Re-entrant calls coalesce. */
  async pump(): Promise<void> {
    await this.ready;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.step();
      } while (this.pumpAgain);
    } catch (err) {
      log.error("pump failed", String(err));
    } finally {
      this.pumping = false;
    }
  }

  private async step(): Promise<void> {
    const job = await this.repo.getJob();
    if (!job) return;
    switch (job.phase) {
      case "generating": {
        if (generationSettled(job)) {
          await this.repo.mutateJob((j) => advancePhase(j));
          this.pumpAgain = true;
          return;
        }
        for (const w of job.workerStates) {
          if (w.status === "ready" && !w.currentTrackId) void this.dispatch(w.workerId);
        }
        return;
      }
      case "downloads":
        // Hard gate: no My Songs tab is opened and nothing is selected.
        if (!FEATURES.downloads) {
          await this.attention("downloads_disabled");
          return;
        }
        if (!this.bulkBusy) void this.bulk(() => this.downloadStep());
        return;
      case "playlist":
        if (!FEATURES.playlist) {
          await this.attention("playlist_disabled");
          return;
        }
        if (!this.bulkBusy) void this.bulk(() => this.playlistStep());
        return;
      default:
        return;
    }
  }

  private async bulk(op: () => Promise<boolean>): Promise<void> {
    this.bulkBusy = true;
    let again = false;
    try {
      again = await op();
    } catch (err) {
      log.error("bulk step failed", String(err));
      await this.repo.mutateJob((job) => pauseJob(job, "unexpected_error")).catch(() => undefined);
    } finally {
      this.bulkBusy = false;
    }
    if (again) void this.pump();
  }

  private async attention(code: string): Promise<false> {
    log.warn("needs attention", code);
    await this.repo.mutateJob((job) => pauseJob(job, code));
    return false;
  }

  private async libraryTab(): Promise<number | null> {
    if (this.libraryTabId === undefined) {
      const job = await this.repo.getJob();
      const workerTabs = new Set(job?.workerStates.map((w) => w.tabId));
      const tabs = await chrome.tabs.query({ url: `${FLOW_ORIGIN}/library/*` });
      this.libraryTabId = tabs.find((t) => t.id !== undefined && !workerTabs.has(t.id))?.id;
    }
    const { tabId, state } = await ensurePageTab("my_songs", this.libraryTabId);
    this.libraryTabId = tabId;
    if (!state) {
      await this.attention("my_songs_unavailable");
      return null;
    }
    if (state.blocker) {
      await this.attention(state.blocker);
      return null;
    }
    return tabId;
  }

  /**
   * Plans song batches (max 100) in album order: original track number, then
   * version. This is the planned queue order, not the order in which Flow
   * created the songs; generation/detection times stay on each record.
   */
  private async planFromMySongs(tabId: number, kind: "download" | "playlist", eligible: SongRecord[]): Promise<boolean> {
    if (kind === "playlist") {
      // Same album order the downloads used.
      const order = new Map<string, number>();
      let i = 0;
      for (const b of [...(await this.repo.getJob())!.downloadBatches].sort((a, c) => a.index - c.index)) {
        for (const id of b.songIds) if (!order.has(id)) order.set(id, i++);
      }
      const ids = [...eligible].sort((a, b) => (order.get(a.songId) ?? 1e9) - (order.get(b.songId) ?? 1e9)).map((s) => s.songId);
      await this.repo.mutateJob((job) => planBatches(job, "playlist", ids));
      return true;
    }

    // Scroll My Songs only until every wanted UUID has loaded.
    const scan = await sendToTab(tabId, { type: "mySongs.scan", wanted: eligible.map((s) => s.songId) });
    if (scan.kind !== "success") return this.attention(scan.kind === "unsupported" ? "ui_unverified" : scan.code);
    const { matches, unmatched } = matchSongs(eligible, scan.data.songs);
    const job = (await this.repo.getJob())!;
    const ordered = orderByAlbum(matches, job);
    await this.repo.mutateJob((job) => {
      if (unmatched.length > 0) markUnmatched(job, "download", unmatched, "song_not_found");
      planBatches(job, "download", ordered.map((m) => m.songId));
    });
    return true;
  }

  /** One download step. Returns true when the pump should run again. */
  private async downloadStep(): Promise<boolean> {
    const job = (await this.repo.getJob())!;
    let batch = openBatch(job, "download");

    if (batch && (batch.status === "downloading" || batch.status === "verifying")) {
      return this.reconcileDownloads(batch.index);
    }
    if (!batch) {
      const eligible = eligibleForDownload(job);
      if (eligible.length === 0) {
        await this.repo.mutateJob((j) => advancePhase(j));
        return true;
      }
      const tabId = await this.libraryTab();
      if (tabId === null) return false;
      if (!(await this.planFromMySongs(tabId, "download", eligible))) return false;
      batch = openBatch((await this.repo.getJob())!, "download");
      if (!batch) return true;
    }

    const tabId = await this.libraryTab();
    if (tabId === null) return false;
    const index = batch.index;
    const songs = batch.songIds.map((id) => songOf(song(job, id)));
    await this.repo.mutateJob((j) => setBatchStatus(j, "download", index, "selecting"));

    const selected = await sendToTab(tabId, { type: "mySongs.select", songs });
    if (selected.kind !== "success") return this.preClickFailure("download", index, selected);

    await this.repo.mutateJob((j) => setBatchStatus(j, "download", index, "downloading"));
    await downloads.setActive({ batchIndex: index, expected: songs.length, clickedAt: Date.now(), ids: [] });
    const clicked = await sendToTab(tabId, { type: "mySongs.download", expected: songs.length });
    if (clicked.kind !== "success") {
      await downloads.setActive(null);
      return this.preClickFailure("download", index, clicked);
    }
    log.info("download clicked", { batch: index, expected: songs.length });
    return false; // download events drive the next step
  }

  private async preClickFailure(kind: "download" | "playlist", index: number, failure: Failure): Promise<false> {
    await this.repo.mutateJob((job) => resetUnclickedBatch(job, kind, index));
    return this.attention(failure.kind === "unsupported" ? "ui_unverified" : failure.code);
  }

  private async reconcileDownloads(index: number): Promise<boolean> {
    return this.serializeDownloads(async () => {
      const job = (await this.repo.getJob())!;
      const b = job.downloadBatches.find((x) => x.index === index)!;
      let active = await downloads.getActive();
      if (!active || active.batchIndex !== index) {
        // Restarted mid-batch: rebuild attribution from Chrome's history.
        active = { batchIndex: index, expected: b.songIds.length, clickedAt: b.startedAt ?? job.updatedAt, ids: [] };
        active.ids = await downloads.rediscover(active);
        await downloads.setActive(active);
      }
      const facts = await downloads.collectFacts(active.ids);
      const songs = b.songIds.map((id) => ({ songId: id, title: song(job, id).title }));
      const result = downloads.reconcileSongDownloads(songs, facts, Date.now() - active.clickedAt);
      if (!result) return false; // still waiting; events or the tick will call again
      await this.repo.mutateJob((j) => applyDownloadOutcome(j, index, { kind: "per_song", ...result }));
      await downloads.setActive(null);
      log.info("download batch settled", { batch: index, status: result.batchStatus });
      if (result.batchStatus !== "completed") {
        // Typical causes: Chrome's multiple-download prompt, a blocked download,
        // or file names that cannot be tied to songs. Uncertain songs wait.
        return this.attention(result.batchStatus === "failed" ? "download_failed" : "downloads_need_check");
      }
      return true;
    });
  }

  // --------------------------------------------------------------- playlist

  private async playlistStep(): Promise<boolean> {
    const job = (await this.repo.getJob())!;
    if (!job.playlistName) return this.attention("playlist_missing");
    let batch = openBatch(job, "playlist");
    if (!batch) {
      const eligible = eligibleForPlaylist(job);
      if (eligible.length === 0) {
        await this.repo.mutateJob((j) => advancePhase(j));
        return true;
      }
      await this.planFromMySongs(-1, "playlist", eligible);
      batch = openBatch((await this.repo.getJob())!, "playlist");
      if (!batch) return true;
    }
    if (batch.status !== "pending") return false;

    const tabId = await this.libraryTab();
    if (tabId === null) return false;
    const index = batch.index;
    const songs = batch.songIds.map((id) => songOf(song(job, id)));
    await this.repo.mutateJob((j) => setBatchStatus(j, "playlist", index, "selecting"));

    const selected = await sendToTab(tabId, { type: "mySongs.select", songs });
    if (selected.kind !== "success") return this.preClickFailure("playlist", index, selected);

    const create = job.playlistMode === "new" && !job.playlistCreated;
    const playlist: PlaylistRef = { identity: job.playlistIdentity ?? `name:${job.playlistName}`, name: job.playlistName };
    await this.repo.mutateJob((j) => {
      setBatchStatus(j, "playlist", index, "adding");
      // Recorded before the attempt so a playlist is never created twice,
      // even if this attempt's outcome turns out to be unknown.
      if (create) j.playlistCreated = true;
    });

    let res: Awaited<ReturnType<typeof sendToTab<"mySongs.addToPlaylist">>>;
    try {
      res = await sendToTab(tabId, { type: "mySongs.addToPlaylist", playlist, create, expected: songs.length });
    } catch (err) {
      res = { kind: "needs_attention", code: "membership_unknown", detail: String(err) };
    }

    if (res.kind === "success") {
      const identity = res.data.playlist.identity;
      await this.repo.mutateJob((j) => {
        applyPlaylistOutcome(j, index, { kind: "added", playlistIdentity: identity });
        j.playlistIdentity = identity;
      });
      return true;
    }
    if (PRE_CLICK_CODES.has(res.code) || res.kind === "unsupported") {
      if (create) await this.repo.mutateJob((j) => (j.playlistCreated = false));
      return this.preClickFailure("playlist", index, res);
    }
    const code = res.code;
    const failed = PICKER_CODES.has(code);
    await this.repo.mutateJob((j) => applyPlaylistOutcome(j, index, failed ? { kind: "failed", code } : { kind: "ambiguous", code }));
    return this.attention(code);
  }

  // --------------------------------------------------------------- recovery

  private async recover(): Promise<void> {
    const job = await this.repo.getJob();
    if (!job || !isActivePhase(job.phase) && job.phase !== "paused" && job.phase !== "needs_attention" && job.phase !== "stopped") return;
    const live = await liveFlowTabIds();
    const report = await this.repo.mutateJob((j) => recoverJob(j, live));
    log.info("recovered", report);
    for (const workerId of report.probeWorkers) void this.probeWorker(workerId);
  }

  /** Periodic alarm: probe stale workers, settle downloads, keep things moving. */
  async onTick(): Promise<void> {
    await this.ready;
    const job = await this.repo.getJob();
    if (!job) return;
    const settings = await this.repo.getSettings();
    const staleAfter = Math.max(TIMING.heartbeatStaleMs, settings.generationTimeoutMs + 60_000);
    const live = await liveFlowTabIds();
    for (const w of job.workerStates) {
      if (w.status === "error" || w.tabId === undefined) continue;
      if (!live.has(w.tabId)) {
        // Still open but no longer on flowmusic.app -> it left Flow.
        const stillOpen = await chrome.tabs.get(w.tabId).then(() => true, () => false);
        await this.loseWorker(w.workerId, stillOpen ? "left_flow" : "tab_closed");
        continue;
      }
      // A renderer crash or hang leaves the tab open but silent.
      if (await pageStateOf(w.tabId)) {
        this.pingMisses.delete(w.workerId);
      } else {
        const misses = (this.pingMisses.get(w.workerId) ?? 0) + 1;
        this.pingMisses.set(w.workerId, misses);
        if (misses >= TIMING.unresponsiveTicks) {
          await this.loseWorker(w.workerId, "tab_unresponsive");
          continue;
        }
      }
      const stale = Date.now() - (w.lastHeartbeatAt ?? 0) > staleAfter;
      if (w.status === "verifying" || (w.status === "generating" && stale)) await this.probeWorker(w.workerId);
      // A worker that found its page busy (earlier generation still running)
      // gets one re-check per tick; submit refuses again while it is busy.
      else if (w.status === "idle" && job.phase === "generating") {
        await this.applyWorkerPage(w.workerId, await pageStateOf(w.tabId));
      }
    }
    await this.pump();
    void this.pushDebug();
  }
}

export type { AlbumJob };
