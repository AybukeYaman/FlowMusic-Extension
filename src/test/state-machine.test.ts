import { describe, expect, it } from "vitest";
import {
  advancePhase, applyDownloadOutcome, applyPlaylistOutcome, claimNextTrack, eligibleForDownload,
  eligibleForPlaylist, editPrompt, generationSettled, jobCounts, markSubmitted, pauseJob, planBatches,
  processCompletedNow, recordGenerationResult, recordSubmitFailure, recordWorkerLost, registerSongs,
  resumeJob, retryGeneration, setBatchStatus, setWorkerCount, songIdsOf, songsOfTrack, stopJob,
  hasInFlightPrompt,
} from "../background/job-logic";
import { NOT_SUBMITTED_CODES } from "../shared/messages";
import type { AlbumJob } from "../shared/types";
import { allSongIds, generateAll, makeJob, markAllDownloaded } from "./fixtures/jobs";

function claimAndSubmit(job: AlbumJob, workerId: string) {
  const t = claimNextTrack(job, workerId)!;
  expect(markSubmitted(job, workerId, t.trackId)).toBe(true);
  return t;
}

// Results as Flow returns them: the card carries the title we typed.
const ok = (id: string, t: { plannedTitle: string }) =>
  ({ kind: "success" as const, data: { flowSongId: id, flowSongIds: [id], flowTitle: t.plannedTitle } });
const two = (p: string, t: { plannedTitle: string }) => ({
  kind: "success" as const,
  data: { flowSongId: `${p}-1`, flowSongIds: [`${p}-1`, `${p}-2`], flowTitle: t.plannedTitle },
});

describe("worker queue", () => {
  it("never assigns a track twice", () => {
    const job = makeJob(10, 4);
    const claimed = job.workerStates.map((w) => claimNextTrack(job, w.workerId)!.trackId);
    expect(new Set(claimed).size).toBe(4);
    // A worker that already holds a track cannot claim another.
    expect(claimNextTrack(job, "w1")).toBeNull();
    expect(job.tracks.filter((t) => t.trackStatus === "assigned")).toHaveLength(4);
  });

  it("assigns in album order", () => {
    const job = makeJob(5, 2);
    expect(claimNextTrack(job, "w1")!.index).toBe(0);
    expect(claimNextTrack(job, "w2")!.index).toBe(1);
  });

  it("gives a finished worker the next queued track without waiting for others", () => {
    const job = makeJob(6, 3);
    const a = claimAndSubmit(job, "w1");
    claimAndSubmit(job, "w2");
    claimAndSubmit(job, "w3");
    const out = recordGenerationResult(job, "w1", a.trackId, ok("s1", a), false);
    expect(out.workerFree).toBe(true);
    const next = claimNextTrack(job, "w1")!;
    expect(next.index).toBe(3);
    expect(job.workerStates.find((w) => w.workerId === "w2")!.status).toBe("generating");
  });

  it("one worker failing does not block the others", () => {
    const job = makeJob(6, 2);
    const a = claimAndSubmit(job, "w1");
    const b = claimAndSubmit(job, "w2");
    const out = recordGenerationResult(job, "w1", a.trackId, { kind: "needs_attention", code: "timeout" }, false);
    expect(out).toEqual({ workerFree: false, pauseJob: false });
    expect(job.phase).toBe("generating");
    recordGenerationResult(job, "w2", b.trackId, ok("s2", b), false);
    expect(claimNextTrack(job, "w2")).not.toBeNull();
    expect(claimNextTrack(job, "w1")).toBeNull(); // paused, uncertain page
  });

  it("pause-on-error requests a global pause", () => {
    const job = makeJob(3, 1);
    const a = claimAndSubmit(job, "w1");
    const out = recordGenerationResult(job, "w1", a.trackId, { kind: "needs_attention", code: "timeout" }, true);
    expect(out.pauseJob).toBe(true);
  });

  it("ignores stale results from a worker that no longer owns the track", () => {
    const job = makeJob(3, 2);
    const a = claimAndSubmit(job, "w1");
    const out = recordGenerationResult(job, "w2", a.trackId, ok("x", a), false);
    expect(out.workerFree).toBe(false);
    expect(job.tracks[0]!.trackStatus).toBe("generating");
  });

  it("requeues only when the prompt verifiably never reached the site", () => {
    const job = makeJob(3, 1);
    let t = claimNextTrack(job, "w1")!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "retryable_failure", code: "input_not_ready" }, true, false);
    expect(t.trackStatus).toBe("queued");

    t = claimNextTrack(job, "w1")!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "retryable_failure", code: "accept_unconfirmed" }, false, false);
    expect(t.trackStatus).toBe("needs_attention");
    expect(job.workerStates[0]!.status).toBe("paused");
  });

  it("never requeues a prompt whose tab closed after the submit request was sent", () => {
    const job = makeJob(3, 2);
    const a = claimAndSubmit(job, "w1");
    const b = claimNextTrack(job, "w2")!; // submit sent; click may have happened
    recordWorkerLost(job, "w1", "tab_closed");
    recordWorkerLost(job, "w2", "tab_closed");
    expect(a.trackStatus).toBe("needs_attention");
    expect(b.trackStatus).toBe("needs_attention");
    expect(job.tracks.filter((t) => t.trackStatus === "queued")).toHaveLength(1);
  });

  it("only pre-click failure codes count as 'not submitted'", () => {
    for (const code of ["selector_unverified", "target_missing", "target_disabled", "input_mismatch", "busy", "wrong_page"]) {
      expect(NOT_SUBMITTED_CODES.has(code)).toBe(true);
    }
    // Returned after (or possibly after) the Generate click.
    for (const code of ["accept_unconfirmed", "blocked_after_submit", "submit_no_response", "content_exception", "watch_no_response", "no_baseline"]) {
      expect(NOT_SUBMITTED_CODES.has(code)).toBe(false);
    }
  });

  it("uncertain submit outcomes are never requeued", () => {
    for (const code of ["accept_unconfirmed", "blocked_after_submit", "submit_no_response", "content_exception"]) {
      const job = makeJob(2, 1);
      const t = claimNextTrack(job, "w1")!;
      const out = recordSubmitFailure(job, "w1", t.trackId, { kind: "needs_attention", code }, NOT_SUBMITTED_CODES.has(code), false);
      expect(t.trackStatus).toBe("needs_attention");
      expect(out.workerFree).toBe(false);
      expect(claimNextTrack(job, "w1")).toBeNull(); // worker paused
    }
  });

  it("a busy page returns the prompt without spending an attempt and parks the worker", () => {
    const job = makeJob(2, 1);
    const t = claimNextTrack(job, "w1")!;
    const out = recordSubmitFailure(job, "w1", t.trackId, { kind: "retryable_failure", code: "busy" }, true, false);
    expect(out).toEqual({ workerFree: false, pauseJob: false });
    expect(t.trackStatus).toBe("queued");
    expect(t.attempts).toBe(0);
    expect(job.workerStates[0]!.status).toBe("idle");
    expect(claimNextTrack(job, "w1")).toBeNull(); // waits for the periodic page re-check
  });

  it("timeouts, missing UUIDs and ambiguous results never trigger a resubmission", () => {
    for (const code of ["generation_timeout", "result_unidentified", "result_ambiguous", "result_unknown", "no_baseline"]) {
      const job = makeJob(2, 1);
      const t = claimAndSubmit(job, "w1");
      recordGenerationResult(job, "w1", t.trackId, { kind: "needs_attention", code }, false);
      expect(t.trackStatus).toBe("needs_attention");
      // Even after the user resumes, the uncertain prompt is not handed out again.
      pauseJob(job);
      resumeJob(job);
      const next = claimNextTrack(job, "w1");
      expect(next?.trackId).not.toBe(t.trackId);
      expect(t.attempts).toBe(1);
    }
  });

  it("lowering concurrency stops extra workers from taking new work", () => {
    const job = makeJob(10, 4);
    setWorkerCount(job, 4);
    expect(claimNextTrack(job, "w4")).not.toBeNull();
    job.workerCount = 2 as never;
    expect(claimNextTrack(job, "w3")).toBeNull();
    expect(claimNextTrack(job, "w1")).not.toBeNull();
  });

  it("only allows prompt edits before assignment", () => {
    const job = makeJob(3, 1);
    editPrompt(job, job.tracks[2]!.trackId, "new prompt");
    expect(job.tracks[2]!.prompt).toBe("new prompt");
    const t = claimNextTrack(job, "w1")!;
    expect(() => editPrompt(job, t.trackId, "x")).toThrow("prompt_locked");
  });
});

describe("phases", () => {
  it("moves generating -> downloads -> playlist -> completed", () => {
    const job = makeJob(3);
    expect(advancePhase(job)).toBe("generating");
    generateAll(job);
    expect(generationSettled(job)).toBe(true);
    expect(advancePhase(job)).toBe("downloads");

    const ids = eligibleForDownload(job).map((s) => s.songId);
    expect(ids).toHaveLength(6); // 3 prompts x 2 versions
    const [b] = planBatches(job, "download", ids);
    expect(advancePhase(job)).toBe("downloads");
    setBatchStatus(job, "download", b!.index, "selecting");
    setBatchStatus(job, "download", b!.index, "downloading");
    applyDownloadOutcome(job, b!.index, { kind: "verified", downloadIds: [1], files: ["a.zip"] });
    expect(advancePhase(job)).toBe("playlist");

    const [p] = planBatches(job, "playlist", eligibleForPlaylist(job).map((s) => s.songId));
    expect(p!.songIds).toHaveLength(6);
    applyPlaylistOutcome(job, p!.index, { kind: "added", playlistIdentity: "pl-1" });
    expect(advancePhase(job)).toBe("completed");
  });

  it("generation can complete with failures, which stay visible", () => {
    const job = makeJob(2, 1);
    const a = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", a.trackId, { kind: "retryable_failure", code: "generation_failed_on_site" }, false);
    const b = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", b.trackId, two("s", b), false);
    expect(advancePhase(job)).toBe("downloads");
    expect(job.tracks.map((t) => t.trackStatus)).toEqual(["generation_failed", "generated"]);
    expect(eligibleForDownload(job)).toHaveLength(2);
  });

  it("playlist never precedes download", () => {
    const job = makeJob(3);
    generateAll(job);
    expect(eligibleForPlaylist(job)).toHaveLength(0);
  });

  it("download failure does not reset generation status", () => {
    const job = makeJob(3);
    generateAll(job);
    const [b] = planBatches(job, "download", allSongIds(job));
    applyDownloadOutcome(job, b!.index, { kind: "failed", code: "blocked" });
    expect(job.tracks.every((t) => t.trackStatus === "generated")).toBe(true);
    expect(job.songs.every((s) => s.downloadStatus === "download_failed")).toBe(true);
    // Not retried automatically, only on explicit retry.
    expect(eligibleForDownload(job)).toHaveLength(0);
    expect(eligibleForDownload(job, true)).toHaveLength(6);
  });

  it("playlist failure does not reset download status, and only the failed batch is retried", () => {
    const job = makeJob(125);
    generateAll(job);
    markAllDownloaded(job);
    const pbs = planBatches(job, "playlist", allSongIds(job));
    expect(pbs.map((b) => b.songIds.length)).toEqual([100, 100, 50]);
    applyPlaylistOutcome(job, 0, { kind: "added", playlistIdentity: "pl-1" });
    applyPlaylistOutcome(job, 1, { kind: "failed", code: "add_failed" });
    applyPlaylistOutcome(job, 2, { kind: "added", playlistIdentity: "pl-1" });
    expect(job.songs.every((s) => s.downloadStatus === "downloaded")).toBe(true);
    const retry = eligibleForPlaylist(job, true);
    expect(retry.map((s) => s.songId)).toEqual(pbs[1]!.songIds);
  });

  it("ambiguous outcomes become verification_needed and are never retried", () => {
    const job = makeJob(4);
    generateAll(job);
    const [b] = planBatches(job, "download", allSongIds(job));
    applyDownloadOutcome(job, b!.index, { kind: "ambiguous", code: "file_mapping_unknown" });
    expect(job.songs.every((s) => s.downloadStatus === "verification_needed")).toBe(true);
    expect(b!.status).toBe("partial");
    // A file may exist: neither automatic nor explicit retry re-downloads it.
    expect(eligibleForDownload(job, true)).toHaveLength(0);
    expect(planBatches(job, "download", allSongIds(job))).toEqual([]);

    markAllDownloaded(job);
    const [p] = planBatches(job, "playlist", allSongIds(job));
    applyPlaylistOutcome(job, p!.index, { kind: "ambiguous", code: "membership_unknown" });
    expect(job.songs.every((s) => s.playlistStatus === "verification_needed")).toBe(true);
    expect(eligibleForPlaylist(job, true)).toHaveLength(0);
    expect(planBatches(job, "playlist", allSongIds(job))).toEqual([]);
  });

  it("process-completed-now runs downloads for every version generated so far", () => {
    const job = makeJob(4, 1);
    const a = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", a.trackId, two("a", a), false);
    expect(processCompletedNow(job)).toBe(true);
    expect(job.phase).toBe("downloads");
    expect(eligibleForDownload(job)).toHaveLength(2);
  });
});

describe("songs from one generation", () => {
  it("tracks every returned version as an independent song", () => {
    const job = makeJob(2, 1);
    const t = claimAndSubmit(job, "w1");
    const out = recordGenerationResult(job, "w1", t.trackId, two("a", t), false);
    expect(out.workerFree).toBe(true);
    expect(songsOfTrack(job, t.trackId).map((s) => [s.songId, s.version])).toEqual([["a-1", 0], ["a-2", 1]]);
    expect(t.flowSongIds).toEqual(["a-1", "a-2"]);
    // Versions share a title; only the UUID distinguishes them.
    expect(new Set(job.songs.map((s) => s.title)).size).toBe(1);
  });

  it("counts prompts and songs separately", () => {
    const job = makeJob(50);
    generateAll(job, 2);
    expect(jobCounts(job)).toMatchObject({ promptsTotal: 50, promptsDone: 50, songsFound: 100 });
  });

  it("registering the same UUIDs again adds nothing", () => {
    const job = makeJob(1);
    generateAll(job, 2);
    expect(registerSongs(job, job.tracks[0]!, ["00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001"])).toEqual([]);
    expect(job.songs).toHaveLength(2);
  });

  it("de-duplicates ids within one result", () => {
    expect(songIdsOf({ flowSongIds: ["x", "x", "y"] })).toEqual(["x", "y"]);
    expect(songIdsOf({ flowSongId: "z" })).toEqual(["z"]);
    expect(songIdsOf({})).toEqual([]);
  });

  it("refuses a result whose song already belongs to another prompt", () => {
    const job = makeJob(2, 1);
    const a = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", a.trackId, two("a", a), false);
    const b = claimAndSubmit(job, "w1");
    const out = recordGenerationResult(job, "w1", b.trackId, two("a", b), false);
    expect(out.workerFree).toBe(false);
    expect(b.trackStatus).toBe("needs_attention");
    expect(b.lastErrorCode).toBe("song_already_claimed");
    expect(job.songs).toHaveLength(2);
  });

  it("does not mark a prompt generated without any song UUID", () => {
    const job = makeJob(1, 1);
    const t = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", t.trackId, { kind: "success", data: { flowTitle: t.plannedTitle } }, false);
    expect(t.trackStatus).toBe("needs_attention");
    expect(t.lastErrorCode).toBe("result_unidentified");
    expect(job.songs).toHaveLength(0);
  });
});

describe("pause / stop / resume", () => {
  it("pause blocks new claims and resume restores the phase", () => {
    const job = makeJob(4, 1);
    pauseJob(job);
    expect(job.phase).toBe("paused");
    expect(claimNextTrack(job, "w1")).toBeNull();
    resumeJob(job);
    expect(job.phase).toBe("generating");
    expect(claimNextTrack(job, "w1")).not.toBeNull();
  });

  it("stop during a submit keeps the prompt with its worker so it cannot be sent twice", () => {
    const job = makeJob(4, 2);
    const a = claimAndSubmit(job, "w1");
    const b = claimNextTrack(job, "w2")!; // Generate click may be happening now
    stopJob(job);
    expect(job.phase).toBe("stopped");
    expect(a.trackStatus).toBe("generating");
    expect(b.trackStatus).toBe("assigned");
    expect(hasInFlightPrompt(job)).toBe(true);
    // The pending submit can still record its real outcome...
    expect(markSubmitted(job, "w2", b.trackId)).toBe(true);
    recordGenerationResult(job, "w2", b.trackId, ok("b-song", b), false);
    expect(b.trackStatus).toBe("generated");
    // ...and nothing new is handed out while stopped.
    expect(claimNextTrack(job, "w2")).toBeNull();
    expect(job.tracks).toHaveLength(4);
  });

  it("resume after stop never re-sends an already submitted prompt", () => {
    const job = makeJob(3, 1);
    const a = claimAndSubmit(job, "w1");
    stopJob(job);
    resumeJob(job);
    expect(claimNextTrack(job, "w1")).toBeNull(); // worker still owns the running prompt
    expect(a.trackStatus).toBe("generating");
    expect(a.attempts).toBe(1);
  });

  it("resume releases paused workers but leaves uncertain tracks for explicit retry", () => {
    const job = makeJob(3, 1);
    const a = claimAndSubmit(job, "w1");
    recordGenerationResult(job, "w1", a.trackId, { kind: "needs_attention", code: "timeout" }, true);
    pauseJob(job);
    resumeJob(job);
    expect(job.workerStates[0]!.status).toBe("ready");
    expect(a.trackStatus).toBe("needs_attention");
    expect(retryGeneration(job)).toBe(1);
    expect(a.trackStatus).toBe("queued");
  });
});
