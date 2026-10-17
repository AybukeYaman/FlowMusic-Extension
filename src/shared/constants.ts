import { E2E_TEST } from "./features";
import type { Settings, WorkerCount } from "./types";

export const FLOW_ORIGIN = "https://www.flowmusic.app";
export const FLOW_URLS = {
  session: `${FLOW_ORIGIN}/session`,
  mySongs: `${FLOW_ORIGIN}/library/my-songs`,
  playlists: `${FLOW_ORIGIN}/library/playlists`,
} as const;

// The e2e build stays at the approved test scope (1 worker, 1 prompt).
export const WORKER_OPTIONS: readonly WorkerCount[] = E2E_TEST ? [1] : [1, 2, 4, 6, 8, 10];
export const MAX_BATCH_SIZE = 100;
export const MIN_SONGS = 1;
export const MAX_SONGS = E2E_TEST ? 1 : 500;

export const SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  workerCount: E2E_TEST ? 1 : 8,
  playlistMode: "existing",
  pauseOnError: false,
  downloadBatchSize: MAX_BATCH_SIZE,
  generationTimeoutMs: 15 * 60_000,
  draftDescription: "",
  draftSongCount: 50,
};

export const TIMING = {
  tabReadyTimeoutMs: 45_000,
  submitAcceptTimeoutMs: 20_000,
  // A worker that has not reported for this long is probed.
  heartbeatStaleMs: 90_000,
  // Window after clicking Download in which new downloads are attributed to the batch.
  downloadAttributionMs: 120_000,
  // A batch whose downloads have not all completed by then is reconciled as-is.
  downloadSettleMs: 10 * 60_000,
  alarmPeriodMin: 1,
  /** Gradual start: each worker's first submission waits 15–30 s after the previous one. */
  staggerMinMs: 15_000,
  staggerMaxMs: 30_000,
  /** "Generating…" cleared but no result card appeared within this time -> needs attention. */
  resultGraceMs: 90_000,
  /** Unanswered page pings (one per tick) before a worker tab counts as unresponsive. */
  unresponsiveTicks: 3,
  /** Replacement tabs per job after worker tabs crash or close. */
  maxWorkerReplacements: 3,
} as const;

export const ALARM_TICK = "studio-tick";

/**
 * Credit guard. The meaning and cost of the sidebar balance are NOT verified
 * (two test generations left it at 36). These are conservative initial
 * limits: a larger drop for one song, or a balance under the floor, stops
 * new generations. An unreadable balance also stops them.
 */
export const CREDIT_POLICY = { maxSpendPerSong: 5, minBalance: 5 } as const;
