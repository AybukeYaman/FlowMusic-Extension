import { DEFAULT_SETTINGS, MAX_BATCH_SIZE, SCHEMA_VERSION, WORKER_OPTIONS } from "../shared/constants";
import type { AlbumJob, Settings, SongRecord, TrackRecord } from "../shared/types";

type Raw = Record<string, unknown>;

// Brings any stored job (including pre-versioned v0 data) up to the current
// schema without dropping data. Each step must be additive and idempotent.
export function migrateJob(meta: Raw, tracks: unknown[], songs: unknown[] = []): AlbumJob {
  let version = typeof meta.schemaVersion === "number" ? meta.schemaVersion : 0;
  const job = {
    ...meta,
    tracks: tracks.map((t) => ({ ...(t as Raw) })),
    songs: songs.map((s) => ({ ...(s as Raw) })),
  } as Raw;

  if (version < 1) {
    job.downloadBatches ??= [];
    job.playlistBatches ??= [];
    job.workerStates ??= [];
    job.downloadBatchSize = Math.min(
      Number(job.downloadBatchSize) || MAX_BATCH_SIZE,
      MAX_BATCH_SIZE,
    );
    job.albumTitle ??= "Album";
    for (const t of job.tracks as Raw[]) {
      t.attempts ??= 0;
      t.downloadStatus ??= "not_started";
      t.playlistStatus ??= "not_started";
      t.variationAxes ??= {};
      t.updatedAt ??= Date.now();
    }
    version = 1;
  }

  if (version < 2) {
    // v2: songs (one per Flow /song/<uuid>) become the unit of download and
    // playlist work. Each known id of a v1 track becomes a song that inherits
    // the track's statuses; batches switch from track ids to song ids.
    const songList = job.songs as Raw[];
    const known = new Set(songList.map((s) => s.songId));
    const idsByTrack = new Map<string, string[]>();
    for (const t of job.tracks as Raw[]) {
      const ids = (t.flowSongIds as string[] | undefined) ?? (t.flowSongId ? [t.flowSongId as string] : []);
      idsByTrack.set(t.trackId as string, ids);
      ids.forEach((songId, version) => {
        if (known.has(songId)) return;
        known.add(songId);
        songList.push({
          songId,
          trackId: t.trackId,
          version,
          title: t.flowTitle ?? t.plannedTitle,
          generatedAt: t.generatedAt ?? t.updatedAt ?? Date.now(),
          downloadStatus: t.downloadStatus ?? "not_started",
          downloadIds: t.downloadIds,
          downloadedFiles: t.downloadedFiles,
          playlistStatus: t.playlistStatus ?? "not_started",
          playlistIdentity: t.playlistIdentity,
          lastErrorCode: t.lastErrorCode,
          updatedAt: t.updatedAt ?? Date.now(),
        });
      });
      for (const k of ["downloadStatus", "downloadIds", "downloadedFiles", "playlistStatus", "playlistIdentity"]) delete t[k];
    }
    for (const key of ["downloadBatches", "playlistBatches"]) {
      for (const b of (job[key] as Raw[]) ?? []) {
        if (!b.songIds) b.songIds = ((b.trackIds as string[]) ?? []).flatMap((id) => idsByTrack.get(id) ?? []);
        delete b.trackIds;
      }
    }
    version = 2;
  }

  if (version < 3) {
    // v3: a prompt whose manual confirmation timed out left a filled Compose
    // form on the page; a later manual click could have generated it outside
    // the ledger (this happened in E0 on 2026-10-14). Such prompts are
    // uncertain, not queued, so they can never be sent again automatically.
    for (const t of job.tracks as Raw[]) {
      if (t.trackStatus === "queued" && t.lastErrorCode === "test_not_confirmed") {
        t.trackStatus = "needs_attention";
        t.lastErrorCode = "unconfirmed_fill_left_on_page";
        job.submittedCount = (Number(job.submittedCount) || 0) + 1;
      }
    }
    if (job.attentionCode === "test_not_confirmed") job.attentionCode = "unconfirmed_fill_left_on_page";
    version = 3;
  }

  job.schemaVersion = SCHEMA_VERSION;
  return job as unknown as AlbumJob;
}

export function splitJob(job: AlbumJob): {
  meta: Omit<AlbumJob, "tracks" | "songs">;
  tracks: TrackRecord[];
  songs: SongRecord[];
} {
  const { tracks, songs, ...meta } = job;
  return { meta, tracks, songs };
}

export function migrateSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS, ...((raw as Partial<Settings>) ?? {}) };
  s.downloadBatchSize = Math.max(1, Math.min(s.downloadBatchSize, MAX_BATCH_SIZE));
  if (!WORKER_OPTIONS.includes(s.workerCount)) s.workerCount = DEFAULT_SETTINGS.workerCount;
  return s;
}
