import { addWorker, createJob, markWorkerReady, registerSongs, startGeneration } from "../../background/job-logic";
import { planAlbum } from "../../prompt/local-planner";
import type { AlbumJob } from "../../shared/types";

export const DESCRIPTION = "Calm lofi hip hop for studying, warm Rhodes, soft rain, instrumental, avoid loud percussion.";

export function makeJob(promptCount: number, workers = 0, now = 1_000): AlbumJob {
  const plan = planAlbum({ description: DESCRIPTION }, promptCount, { albumId: "alb" });
  const job = createJob(plan, {
    description: DESCRIPTION,
    workerCount: 8,
    playlistMode: "existing",
    playlistIdentity: "pl-1",
    playlistName: "Test playlist",
    downloadBatchSize: 100,
  }, now);
  startGeneration(job);
  for (let i = 0; i < workers; i++) {
    const w = addWorker(job, 100 + i);
    markWorkerReady(job, w.workerId, now);
  }
  return job;
}

/** Fake but well-formed Flow song UUID for prompt `t`, version `v`. */
export function uuid(t: number, v: number): string {
  return `00000000-0000-4000-8000-${String(t).padStart(8, "0")}${String(v).padStart(4, "0")}`;
}

/** Marks every prompt generated; each yields `versions` songs (Flow made 2). */
export function generateAll(job: AlbumJob, versions = 2, now = 2_000): void {
  job.tracks.forEach((t, i) => {
    const ids = Array.from({ length: versions }, (_, v) => uuid(i, v));
    t.trackStatus = "generated";
    t.generatedAt = now + i;
    t.flowSongId = ids[0];
    t.flowSongIds = ids;
    t.flowTitle = t.plannedTitle;
    registerSongs(job, t, ids, now + i);
  });
}

export const allSongIds = (job: AlbumJob) => job.songs.map((s) => s.songId);

export function markAllDownloaded(job: AlbumJob): void {
  for (const s of job.songs) s.downloadStatus = "downloaded";
}
