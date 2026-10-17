import { describe, expect, it } from "vitest";
import {
  applyDownloadOutcome, applyProbe, claimNextTrack, eligibleForDownload, eligibleForPlaylist,
  markSubmitted, planBatches, recoverJob, setBatchStatus,
} from "../background/job-logic";
import { matchSongs, OrderUnverifiedError, sortOldestFirst } from "../background/matcher";
import { migrateJob, splitJob } from "../storage/migrations";
import { Repository } from "../storage/repository";
import { memoryStore, STORAGE_KEYS } from "../storage/schema";
import { SCHEMA_VERSION } from "../shared/constants";
import type { FlowSong } from "../shared/types";
import { allSongIds, generateAll, makeJob, markAllDownloaded, uuid } from "./fixtures/jobs";

describe("recovery after restart", () => {
  it("does not repeat completed downloads", () => {
    const job = makeJob(75); // 150 songs
    generateAll(job);
    const [b0, b1] = planBatches(job, "download", allSongIds(job));
    applyDownloadOutcome(job, b0!.index, { kind: "verified", downloadIds: [1], files: ["x"] });
    setBatchStatus(job, "download", b1!.index, "selecting");
    setBatchStatus(job, "download", b1!.index, "downloading");

    const report = recoverJob(job, new Set());
    expect(report.verifyDownloadBatches).toEqual([1]);
    expect(b0!.status).toBe("completed");
    expect(b1!.status).toBe("verifying");
    // Neither the completed batch nor the in-flight batch can be queued again.
    expect(eligibleForDownload(job, true)).toHaveLength(0);
    expect(planBatches(job, "download", allSongIds(job))).toEqual([]);
  });

  it("resets a batch interrupted before its download click", () => {
    const job = makeJob(10);
    generateAll(job);
    const [b] = planBatches(job, "download", allSongIds(job));
    setBatchStatus(job, "download", b!.index, "selecting");
    recoverJob(job, new Set());
    expect(b!.status).toBe("pending");
    expect(job.songs.every((s) => s.downloadStatus === "not_started")).toBe(true);
    // Pending batch is resumed as-is, not duplicated.
    expect(planBatches(job, "download", allSongIds(job))).toEqual([]);
  });

  it("marks an interrupted playlist add as ambiguous instead of re-adding", () => {
    const job = makeJob(5);
    generateAll(job);
    markAllDownloaded(job);
    const [p] = planBatches(job, "playlist", allSongIds(job));
    setBatchStatus(job, "playlist", p!.index, "selecting");
    setBatchStatus(job, "playlist", p!.index, "adding");
    recoverJob(job, new Set());
    expect(job.songs.every((s) => s.playlistStatus === "verification_needed")).toBe(true);
    expect(job.songs.every((s) => s.downloadStatus === "downloaded")).toBe(true);
    expect(eligibleForPlaylist(job, true)).toHaveLength(0);
  });

  it("probes live workers with unknown state and drops closed tabs", () => {
    const job = makeJob(4, 2);
    const t1 = claimNextTrack(job, "w1")!;
    markSubmitted(job, "w1", t1.trackId);
    const t2 = claimNextTrack(job, "w2")!;
    markSubmitted(job, "w2", t2.trackId);

    const report = recoverJob(job, new Set([100])); // w2's tab (101) is gone
    expect(report.probeWorkers).toEqual(["w1"]);
    expect(report.lostWorkers).toEqual(["w2"]);
    expect(t2.trackStatus).toBe("needs_attention");

    // Probe finds both versions: recorded, not resubmitted.
    const out = applyProbe(job, "w1", { flowSongId: "abc", flowSongIds: ["abc", "def"], flowTitle: t1.plannedTitle });
    expect(out.workerFree).toBe(true);
    expect(t1.trackStatus).toBe("generated");
    expect(t1.attempts).toBe(1);
    expect(job.songs.map((s) => s.songId)).toEqual(["abc", "def"]);
  });

  it("probe with no evidence flags the track instead of retrying", () => {
    const job = makeJob(2, 1);
    const t = claimNextTrack(job, "w1")!;
    markSubmitted(job, "w1", t.trackId);
    recoverJob(job, new Set([100]));
    applyProbe(job, "w1", null);
    expect(t.trackStatus).toBe("needs_attention");
    expect(t.attempts).toBe(1);
  });
});

describe("My Songs matching by UUID", () => {
  const job = makeJob(3);
  generateAll(job, 2);
  const byId = new Map(job.songs.map((s) => [s.songId, s]));

  it("matches both versions by UUID and ignores unrelated library songs", () => {
    const visible: FlowSong[] = [
      { flowSongId: "11111111-1111-4111-8111-111111111111", title: job.songs[0]!.title, listIndex: 0 },
      ...job.songs.map((s, i) => ({ flowSongId: s.songId, title: s.title, listIndex: i + 1 })),
    ];
    const { matches, unmatched } = matchSongs(job.songs, visible);
    expect(unmatched).toEqual([]);
    expect(matches).toHaveLength(6);
    expect(matches.map((m) => m.songId)).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("never matches by title, even when the title is identical", () => {
    const visible: FlowSong[] = job.songs.map((s, i) => ({ title: s.title, listIndex: i }));
    const { matches, unmatched } = matchSongs(job.songs, visible);
    expect(matches).toEqual([]);
    expect(unmatched).toHaveLength(6);
  });

  it("orders oldest first from timestamps, verified list order, or the ledger", () => {
    const visible: FlowSong[] = job.songs.map((s, i) => ({ flowSongId: s.songId, title: s.title, listIndex: i }));
    const { matches } = matchSongs(job.songs, visible);
    expect(sortOldestFirst(matches, "newest_first", byId).map((m) => m.song.listIndex)).toEqual([5, 4, 3, 2, 1, 0]);

    const withTimes = matches.map((m, i) => ({ ...m, song: { ...m.song, createdAt: 10 - i } }));
    expect(sortOldestFirst(withTimes, "unknown", byId).map((m) => m.song.listIndex)).toEqual([5, 4, 3, 2, 1, 0]);

    // Ledger fallback: prompt generation order, then version order.
    const reversed = [...matches].reverse();
    expect(sortOldestFirst(reversed, "unknown", byId).map((m) => m.songId)).toEqual([
      uuid(0, 0), uuid(0, 1), uuid(1, 0), uuid(1, 1), uuid(2, 0), uuid(2, 1),
    ]);
  });

  it("refuses to order without evidence", () => {
    const visible: FlowSong[] = job.songs.map((s, i) => ({ flowSongId: s.songId, title: s.title, listIndex: i }));
    const { matches } = matchSongs(job.songs, visible);
    expect(() => sortOldestFirst(matches, "unknown", new Map())).toThrow(OrderUnverifiedError);
  });
});

describe("storage", () => {
  it("v0/v1 data migrates to songs without losing statuses", () => {
    const job = makeJob(3);
    generateAll(job, 2);
    const { meta, tracks } = splitJob(job);
    // Recreate a v1 layout: statuses on tracks, batches by track id, no songs key.
    const v1Meta: Record<string, unknown> = {
      ...meta, schemaVersion: 1,
      downloadBatches: [{ kind: "download", index: 0, trackIds: [tracks[0]!.trackId], status: "completed", attempts: 1 }],
      playlistBatches: [],
    };
    const v1Tracks = tracks.map((t, i) => ({
      ...t,
      downloadStatus: i === 0 ? "downloaded" : "not_started",
      playlistStatus: "not_started",
    }));
    const migrated = migrateJob(v1Meta, v1Tracks);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.songs).toHaveLength(6);
    expect(migrated.songs.filter((s) => s.downloadStatus === "downloaded").map((s) => s.songId)).toEqual([uuid(0, 0), uuid(0, 1)]);
    expect(migrated.downloadBatches[0]!.songIds).toEqual([uuid(0, 0), uuid(0, 1)]);
    expect(migrated.tracks.map((t) => t.prompt)).toEqual(job.tracks.map((t) => t.prompt));
    expect("downloadStatus" in migrated.tracks[0]!).toBe(false);
  });

  it("pre-versioned data still migrates", () => {
    const job = makeJob(2);
    const { meta, tracks } = splitJob(job);
    const legacyMeta: Record<string, unknown> = { ...meta };
    delete legacyMeta.schemaVersion;
    delete legacyMeta.downloadBatches;
    const legacyTracks = tracks.map((t) => {
      const copy: Record<string, unknown> = { ...t };
      delete copy.attempts;
      return copy;
    });
    const migrated = migrateJob(legacyMeta, legacyTracks);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.downloadBatches).toEqual([]);
    expect(migrated.songs).toEqual([]);
    expect(migrated.tracks.every((t) => t.attempts === 0)).toBe(true);
  });

  it("persists songs in their own key and reads them back", async () => {
    const store = memoryStore();
    const repo = new Repository(store);
    const job = makeJob(2);
    generateAll(job, 2);
    await repo.replaceJob(job);
    expect((store.data[STORAGE_KEYS.jobSongs] as unknown[]).length).toBe(4);
    expect((await repo.getJob())!.songs.map((s) => s.songId)).toEqual(allSongIds(job));
  });

  it("serializes concurrent claims so no track is handed out twice", async () => {
    const store = memoryStore();
    const repo = new Repository(store);
    await repo.replaceJob(makeJob(20, 8));
    const ids = await Promise.all(
      ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].map((w) =>
        repo.mutateJob((job) => claimNextTrack(job, w)?.trackId),
      ),
    );
    expect(new Set(ids).size).toBe(8);
    const job = await repo.getJob();
    expect(job!.tracks.filter((t) => t.trackStatus === "assigned")).toHaveLength(8);
  });

  it("a throwing mutation writes nothing", async () => {
    const repo = new Repository(memoryStore());
    await repo.replaceJob(makeJob(2));
    await expect(repo.mutateJob((job) => {
      job.tracks[0]!.prompt = "changed";
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await repo.getJob())!.tracks[0]!.prompt).not.toBe("changed");
  });
});
