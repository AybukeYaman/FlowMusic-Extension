import { describe, expect, it } from "vitest";
import { fileTitle, reconcileSongDownloads, type DownloadFact } from "../background/download-manager";
import {
  addWorker, applyBackoff, applyDownloadOutcome, canReplaceWorker, claimNextTrack, markSubmitted, markWorkerReady,
  noteReplacement, orderByAlbum, pauseJob, planBatches, rampWait, recordGenerationResult, recordWorkerLost,
  resumeJob, staggerGapMs, titleMatches,
} from "../background/job-logic";
import { advanceWatch, evaluateGeneration, type PageView } from "../content/generation-rules";
import { allPresent } from "../content/my-songs-adapter";
import { classifyAlert } from "../content/page-state-detector";
import { MAX_SONGS, TIMING, WORKER_OPTIONS } from "../shared/constants";
import type { AlbumJob, TrackRecord, WorkerCount } from "../shared/types";
import { generateAll, makeJob, uuid } from "./fixtures/jobs";

// These tests exercise the multi-worker *logic* only. They do not show that
// Flow Music accepts parallel generations; that needs live testing.

const S = 1_000;
const found = (t: TrackRecord, id: string) =>
  ({ kind: "success" as const, data: { flowSongId: id, flowSongIds: [id], flowTitle: t.plannedTitle } });

function withWorkers(n: number, tracks: number, count: WorkerCount): AlbumJob {
  const job = makeJob(tracks, n);
  job.workerCount = count;
  return job;
}

describe("worker options", () => {
  it("normal build offers 1, 2, 4, 6, 8 and 10 workers and up to 500 songs", () => {
    expect(WORKER_OPTIONS).toEqual([1, 2, 4, 6, 8, 10]);
    expect(MAX_SONGS).toBe(500);
  });
});

describe("gradual start", () => {
  it("first submissions are 15–30 s apart; later ones do not wait", () => {
    const job = withWorkers(4, 20, 4);
    const t0 = 100 * S;
    const stagger = { stagger: staggerGapMs };
    expect(claimNextTrack(job, "w1", t0, stagger)).not.toBeNull();
    // w2 must wait its gap.
    expect(claimNextTrack(job, "w2", t0 + 1 * S, stagger)).toBeNull();
    const w2 = job.workerStates[1]!;
    const gap = staggerGapMs("w2");
    expect(gap).toBeGreaterThanOrEqual(TIMING.staggerMinMs);
    expect(gap).toBeLessThanOrEqual(TIMING.staggerMaxMs);
    expect(w2.startAfter).toBe(t0 + gap);
    expect(claimNextTrack(job, "w2", t0 + gap, stagger)).not.toBeNull();
    // w1 finishes; its next claim is immediate.
    const t1 = job.tracks[0]!;
    markSubmitted(job, "w1", t1.trackId, t0 + 1);
    recordGenerationResult(job, "w1", t1.trackId, found(t1, "id-1"), false, t0 + gap + 1);
    expect(rampWait(job, "w1", t0 + gap + 2)).toBe(0);
    expect(claimNextTrack(job, "w1", t0 + gap + 2, stagger)).not.toBeNull();
  });

  it("gaps differ between workers so they never line up", () => {
    const gaps = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"].map(staggerGapMs);
    expect(new Set(gaps).size).toBeGreaterThan(5);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(15 * S);
  });

  it("resume restarts gradually for idle workers but leaves running ones alone", () => {
    const job = withWorkers(3, 10, 4);
    const stagger = { stagger: () => 20 * S };
    claimNextTrack(job, "w1", 0, stagger);
    markSubmitted(job, "w1", job.tracks[0]!.trackId, 1);
    claimNextTrack(job, "w2", 20 * S, stagger);
    pauseJob(job);
    resumeJob(job);
    expect(job.workerStates[0]!.rampedAt).toBe(0); // in flight: untouched
    expect(job.workerStates[2]!.rampedAt).toBeUndefined();
  });
});

describe("10 workers, 50 songs: a shared queue processed concurrently (simulated)", () => {
  it("every track is claimed exactly once, workers are reused, first starts are spaced", () => {
    const job = withWorkers(10, 50, 10);
    const claims = new Map<string, string[]>(); // trackId -> workers
    const firstStart = new Map<string, number>();
    let now = 0;
    let serial = 0;
    for (let step = 0; step < 2_000 && job.tracks.some((t) => t.trackStatus !== "generated"); step++) {
      now += 2 * S;
      for (const w of job.workerStates) {
        // A running song finishes ~40 s after submission.
        if (w.currentTrackId) {
          const t = job.tracks.find((x) => x.trackId === w.currentTrackId)!;
          if (t.trackStatus === "assigned") markSubmitted(job, w.workerId, t.trackId, now);
          else if (now - (t.submittedAt ?? now) >= 40 * S) {
            recordGenerationResult(job, w.workerId, t.trackId, found(t, `song-${serial++}`), false, now);
          }
          continue;
        }
        const t = claimNextTrack(job, w.workerId, now, { stagger: staggerGapMs });
        if (t) {
          claims.set(t.trackId, [...(claims.get(t.trackId) ?? []), w.workerId]);
          if (!firstStart.has(w.workerId)) firstStart.set(w.workerId, now);
        }
      }
    }
    expect(job.tracks.every((t) => t.trackStatus === "generated")).toBe(true);
    expect(claims.size).toBe(50);
    expect([...claims.values()].every((ws) => ws.length === 1)).toBe(true);
    expect(new Set(job.songs.map((s) => s.songId)).size).toBe(50);
    // All 10 workers were used and each did several tracks.
    const perWorker = new Map<string, number>();
    for (const [, [w]] of claims) perWorker.set(w!, (perWorker.get(w!) ?? 0) + 1);
    expect(perWorker.size).toBe(10);
    expect(Math.min(...perWorker.values())).toBeGreaterThanOrEqual(2);
    // First submissions are at least 15 s apart.
    const starts = [...firstStart.values()].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(15 * S);
  });
});

describe("backoff", () => {
  it("a blocker stops all new assignments at once", () => {
    for (const code of ["login", "captcha", "quota", "rate_limit", "blocked", "left_flow", "modal", "alert"]) {
      const job = withWorkers(2, 6, 2);
      expect(applyBackoff(job, false, code)).toEqual({ pauseCode: code });
      expect(job.phase).toBe("needs_attention");
      expect(claimNextTrack(job, "w2")).toBeNull();
    }
  });

  it("two failures among the last three outcomes pause and lower concurrency one step", () => {
    const job = withWorkers(10, 20, 10);
    expect(applyBackoff(job, true, undefined)).toEqual({});
    expect(applyBackoff(job, false, "generation_timeout")).toEqual({});
    expect(applyBackoff(job, true, undefined)).toEqual({});
    expect(applyBackoff(job, false, "title_mismatch")).toEqual({ pauseCode: "failure_rate", reducedTo: 8 });
    expect(job.workerCount).toBe(8);
    expect(job.phase).toBe("needs_attention");
  });

  it("isolated failures and pre-click refusals do not trigger backoff", () => {
    const job = withWorkers(4, 20, 4);
    for (const [ok, code] of [[false, "generation_timeout"], [true], [true], [false, "busy"], [false, "input_mismatch"], [true]] as const) {
      expect(applyBackoff(job, ok, code)).toEqual({});
    }
    expect(job.workerCount).toBe(4);
  });

  it("concurrency never drops below one worker, and backoff never requeues anything", () => {
    const job = withWorkers(1, 4, 1);
    const t = claimNextTrack(job, "w1")!;
    markSubmitted(job, "w1", t.trackId);
    recordGenerationResult(job, "w1", t.trackId, { kind: "needs_attention", code: "generation_timeout" }, false);
    applyBackoff(job, false, "generation_timeout");
    expect(applyBackoff(job, false, "result_unknown")).toEqual({ pauseCode: "failure_rate" });
    expect(job.workerCount).toBe(1);
    expect(t.trackStatus).toBe("needs_attention");
    expect(t.attempts).toBe(1);
  });
});

describe("result verification", () => {
  it("records success only with the exact planned title", () => {
    const job = withWorkers(1, 2, 1);
    const t = claimNextTrack(job, "w1")!;
    markSubmitted(job, "w1", t.trackId);
    const out = recordGenerationResult(job, "w1", t.trackId,
      { kind: "success", data: { flowSongId: "x", flowSongIds: ["x"], flowTitle: `${t.plannedTitle} (2)` } }, false);
    expect(out.workerFree).toBe(false);
    expect(t.trackStatus).toBe("needs_attention");
    expect(t.lastErrorCode).toBe("title_mismatch");
    expect(job.songs).toHaveLength(0);
  });

  it("title comparison ignores only whitespace/Unicode form and Flow's 100-char limit", () => {
    expect(titleMatches("Rain & Desk", " Rain  &  Desk ")).toBe(true);
    expect(titleMatches("Rain & Desk", "rain & desk")).toBe(false);
    const long = "A".repeat(120);
    expect(titleMatches(long, "A".repeat(100))).toBe(true);
    expect(titleMatches("x", undefined)).toBe(false);
  });

  const card = (id: string | undefined, title: string) => ({ id, title, failed: false });
  const base = new Set(["old"]);

  it("content rules: wrong title, missing UUID or extra card need attention", () => {
    const view = (cards: PageView["cards"]): PageView => ({ indicatorActive: false, cards });
    expect(evaluateGeneration(view([card("old", "Old"), card("new", "Mine")]), base, 1, "Mine").kind).toBe("success");
    expect(evaluateGeneration(view([card("new", "Other")]), base, 1, "Mine")).toEqual({ kind: "needs_attention", code: "title_mismatch" });
    expect(evaluateGeneration(view([card(undefined, "Mine")]), base, 1, "Mine")).toEqual({ kind: "needs_attention", code: "result_unidentified" });
    expect(evaluateGeneration(view([card("a", "Mine"), card("b", "Mine")]), base, 1, "Mine")).toEqual({ kind: "needs_attention", code: "result_ambiguous" });
  });

  it("'Generating' cleared without a new card is flagged after the grace period", () => {
    let st = { sawIndicator: false } as { sawIndicator: boolean; clearedAt?: number };
    const running: PageView = { indicatorActive: true, cards: [card("old", "Old")] };
    const cleared: PageView = { indicatorActive: false, cards: [card("old", "Old")] };
    st = advanceWatch(st, running, base, 1, "Mine", 0, 90 * S).state;
    let step = advanceWatch(st, cleared, base, 1, "Mine", 10 * S, 90 * S);
    expect(step.outcome.kind).toBe("pending");
    step = advanceWatch(step.state, cleared, base, 1, "Mine", 89 * S, 90 * S);
    expect(step.outcome.kind).toBe("pending"); // 79 s after clearing
    step = advanceWatch(step.state, cleared, base, 1, "Mine", 100 * S, 90 * S);
    expect(step.outcome).toEqual({ kind: "needs_attention", code: "indicator_cleared_without_result" });
    // A card arriving within the grace period is a normal success.
    const late = advanceWatch(st, { indicatorActive: false, cards: [card("old", "Old"), card("n", "Mine")] }, base, 1, "Mine", 30 * S, 90 * S);
    expect(late.outcome.kind).toBe("success");
  });
});

describe("blocker classification (generic ARIA alerts, unverified on Flow)", () => {
  it.each([
    ["You've reached your daily limit. Try again later.", "quota"],
    ["Too many requests", "quota"],
    ["Please sign in to continue", "login"],
    ["Your session has expired", "login"],
    ["Something went wrong", "alert"],
    ["   ", null],
  ])("%s -> %s", (text, kind) => {
    expect(classifyAlert(text)).toBe(kind);
  });
});

describe("worker recovery", () => {
  it("a lost worker's in-flight track is never reassigned; replacements are bounded", () => {
    const job = withWorkers(2, 10, 2);
    const t = claimNextTrack(job, "w1")!;
    markSubmitted(job, "w1", t.trackId);
    recordWorkerLost(job, "w1", "tab_unresponsive");
    expect(t.trackStatus).toBe("needs_attention");
    expect(claimNextTrack(job, "w2")!.trackId).not.toBe(t.trackId);
    for (let i = 0; i < TIMING.maxWorkerReplacements; i++) {
      expect(canReplaceWorker(job)).toBe(true);
      noteReplacement(job);
      const w = addWorker(job, 500 + i);
      markWorkerReady(job, w.workerId);
    }
    expect(canReplaceWorker(job)).toBe(false);
  });

  it("no replacement when nothing is queued or the job is not generating", () => {
    const job = withWorkers(1, 2, 1);
    generateAll(job);
    expect(canReplaceWorker(job)).toBe(false);
    const other = withWorkers(1, 2, 1);
    pauseJob(other);
    expect(canReplaceWorker(other)).toBe(false);
  });
});

describe("downloads (logic only; Flow's download format is not verified)", () => {
  const songs = [
    { songId: "s1", title: "Attic & Cardigan" },
    { songId: "s2", title: "Window Glass at 3 AM" },
    { songId: "s3", title: "Drizzle in Room 12" },
  ];
  const done = (id: number, filename: string): DownloadFact => ({ id, state: "complete", filename });
  const late = TIMING.downloadAttributionMs + 1;

  it("maps files to songs by exact title, ignoring folders, extensions and Chrome's (1)", () => {
    expect(fileTitle("C:\\Music\\Attic & Cardigan (1).mp3")).toBe(fileTitle("Attic & Cardigan"));
    const r = reconcileSongDownloads(songs, [done(1, "/d/Attic & Cardigan.mp3"), done(2, "/d/Window Glass at 3 AM.wav"), done(3, "/d/Drizzle in Room 12.mp3")], late)!;
    expect(r.batchStatus).toBe("completed");
    expect(r.perSong.s1).toEqual({ status: "downloaded", files: ["Attic & Cardigan.mp3"], code: undefined });
  });

  it("an archive counts for the whole batch", () => {
    const r = reconcileSongDownloads(songs, [done(9, "flow-songs.zip")], 1_000)!;
    expect(r.batchStatus).toBe("completed");
    expect(Object.values(r.perSong).every((x) => x.status === "downloaded" && x.code === "archive")).toBe(true);
  });

  it("separates definite failures from uncertain outcomes", () => {
    const r = reconcileSongDownloads(songs, [
      done(1, "Attic & Cardigan.mp3"),
      { id: 2, state: "interrupted", filename: "Window Glass at 3 AM.mp3", error: "NETWORK_FAILED" },
      done(3, "track_0042.mp3"), // name cannot be tied to a song
    ], late)!;
    expect(r.batchStatus).toBe("partial");
    expect(r.perSong.s1!.status).toBe("downloaded");
    expect(r.perSong.s2).toEqual({ status: "download_failed", code: "download_network_failed" });
    expect(r.perSong.s3).toEqual({ status: "verification_needed", code: "file_not_matched" });
  });

  it("nothing started is a definite failure; too early is no decision", () => {
    expect(reconcileSongDownloads(songs, [], 1_000)).toBeNull();
    expect(reconcileSongDownloads(songs, [], late)!.batchStatus).toBe("failed");
  });

  it("duplicate titles in one batch are never guessed", () => {
    const twins = [{ songId: "a", title: "Same" }, { songId: "b", title: "Same" }];
    const r = reconcileSongDownloads(twins, [done(1, "Same.mp3"), done(2, "Same (1).mp3")], late)!;
    expect(r.perSong.a!.status).toBe("verification_needed");
    expect(r.perSong.b!.status).toBe("verification_needed");
  });

  it("per-song results are stored on each song without touching generation", () => {
    const job = makeJob(3);
    generateAll(job, 1);
    const [b] = planBatches(job, "download", job.songs.map((s) => s.songId));
    const ids = b!.songIds;
    applyDownloadOutcome(job, b!.index, {
      kind: "per_song", batchStatus: "partial", downloadIds: [1, 2], files: ["x.mp3"],
      perSong: { [ids[0]!]: { status: "downloaded", files: ["x.mp3"] }, [ids[1]!]: { status: "download_failed", code: "download_network_failed" } },
    });
    const st = ids.map((id) => job.songs.find((s) => s.songId === id)!.downloadStatus);
    expect(st).toEqual(["downloaded", "download_failed", "verification_needed"]);
    expect(job.tracks.every((t) => t.trackStatus === "generated")).toBe(true);
  });

  it("planned download order is album order (track number), not completion order", () => {
    const job = makeJob(5);
    generateAll(job, 1);
    // Workers finished in reverse order.
    job.songs.forEach((s, i) => (s.generatedAt = 10_000 - i));
    const shuffled = [...job.songs].reverse().map((s) => ({ songId: s.songId }));
    const ordered = orderByAlbum(shuffled, job).map((x) => x.songId);
    expect(ordered).toEqual([0, 1, 2, 3, 4].map((i) => uuid(i, 0)));
    // Timestamps are kept, not overwritten by the ordering.
    expect(job.songs.map((s) => s.generatedAt)).toEqual([10_000, 9_999, 9_998, 9_997, 9_996]);
  });

  it("the My Songs scan stops once every wanted UUID is loaded", () => {
    expect(allPresent(["a", "b"], new Set(["a", "b", "c"]))).toBe(true);
    expect(allPresent(["a", "z"], new Set(["a", "b"]))).toBe(false);
    expect(allPresent([], new Set())).toBe(true);
  });
});
