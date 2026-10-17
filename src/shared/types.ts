// Core domain types. Persisted shapes live here so storage, background,
// content and popup agree on one definition.

export type WorkerCount = 1 | 2 | 4 | 6 | 8 | 10;

export type TrackStatus =
  | "draft" | "queued" | "assigned" | "generating"
  | "generated" | "generation_failed" | "needs_attention"
  | "cancelled";

export type DownloadStatus =
  | "not_started" | "selecting" | "downloading"
  | "downloaded" | "download_failed" | "verification_needed";

export type PlaylistStatus =
  | "not_started" | "selecting" | "adding"
  | "added" | "add_failed" | "verification_needed";

export type JobPhase =
  | "draft" | "generating" | "downloads" | "playlist"
  | "completed" | "paused" | "stopped" | "needs_attention";

export type WorkerStatus =
  | "idle" | "loading" | "ready" | "submitting"
  | "generating" | "verifying" | "paused" | "error";

export type BatchStatus =
  | "pending" | "selecting" | "downloading" | "adding"
  | "verifying" | "completed" | "partial" | "failed";

export type Confidence = "high" | "medium" | "low";

export interface VariationAxes {
  leadInstrument?: string;
  rhythm?: string;
  harmony?: string;
  texture?: string;
  ambience?: string;
  energy?: string;
}

export type Energy = "low" | "medium" | "high";

export interface NormalizedAlbumBrief {
  /** First sentence of the description, for reference only (not pasted into prompts). */
  concept: string;
  /** Genre family the planner composes in (inferred when not stated). */
  family: string;
  /** Optional second family that colours the first (e.g. lo-fi + jazz). */
  secondaryFamily?: string;
  genres: string[];
  moods: string[];
  energy: Energy;
  /** Preferred ambience: weighted motifs, not applied to every track. */
  ambience: string[];
  /** Preferred instruments: strong preferences / signature sound, not the only lead. */
  instruments: string[];
  /** Explicitly required in every track ("rain in every track"). */
  requiredAmbience: string[];
  requiredInstruments: string[];
  tempo: { min: number; max: number; explicit: boolean };
  harmony: string[];
  textures: string[];
  intendedUse: string[];
  instrumentalOnly: boolean;
  /** Hard exclusions, verbatim from the user. */
  avoid: string[];
  references: string[];
  variation: "subtle" | "moderate" | "wide";
  /** What the planner inferred (shown as notes, not problems). */
  inferences: string[];
  /** Contradictions found and how they were resolved conservatively. */
  conflicts: string[];
}

export interface AlbumInput {
  description: string;
  albumTitle?: string;
}

/** Every musical decision for one track; the prompt is written from this. */
export interface TrackDesign {
  family: string;
  subgenre: string;
  influences: string[];
  lead: string;
  supports: string[];
  bass: string;
  percussion: string;
  /** "none" when the track has no drums/percussion at all. */
  percussionLevel: "none" | "soft" | "medium" | "strong";
  groove: string;
  bpm: number;
  key: string;
  harmony: string;
  melody: string;
  arrangement: string;
  /** null = no ambience bed for this track. */
  ambience: string | null;
  production: string;
  space: string;
  dynamics: string;
  mood: string;
  context: string;
  /** Hard (user) exclusions first, then planner defaults. */
  exclusions: string[];
  /** Album signature sound present in this track, if any. */
  signature?: string;
}

export interface TrackPlan {
  trackId: string;
  index: number;
  title: string;
  prompt: string;
  variationAxes: VariationAxes;
  design: TrackDesign;
}

export interface AlbumPlan {
  albumId: string;
  albumTitle: string;
  brief: NormalizedAlbumBrief;
  tracks: TrackPlan[];
  /** Problems the user should see (conflicts, unsatisfiable variety). */
  warnings: string[];
  /** Inferences made from a broad brief. */
  notes: string[];
}

export interface WorkerState {
  workerId: string;
  tabId?: number;
  status: WorkerStatus;
  currentTrackId?: string;
  lastError?: string;
  lastHeartbeatAt?: number;
  /** When this worker made its first submission of the current run (gradual start). */
  rampedAt?: number;
  /** Earliest time this worker may make its first submission (shown in the popup). */
  startAfter?: number;
}

export interface TrackRecord {
  trackId: string;
  albumId: string;
  index: number;
  plannedTitle: string;
  prompt: string;
  variationAxes: VariationAxes;
  design?: TrackDesign;
  trackStatus: TrackStatus;
  attempts: number;
  workerId?: string;
  sessionTabId?: number;
  submittedAt?: number;
  generatedAt?: number;
  flowSongId?: string;
  flowSongIds?: string[];
  flowTitle?: string;
  flowCreatedAt?: number;
  identityConfidence?: Confidence;
  /** Sidebar balance read right before submitting / after the result (unverified meaning). */
  creditsBefore?: number | null;
  creditsAfter?: number | null;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt: number;
}

/**
 * One song on Flow Music, identified only by its /song/<uuid>. A track
 * (prompt) produces one or more songs (2 observed per generation); each song
 * is downloaded and added to the playlist independently.
 */
export interface SongRecord {
  songId: string;
  trackId: string;
  /** 0-based position among the songs of its generation, as listed on the page. */
  version: number;
  /** Title Flow showed; versions share it, so it is display-only. */
  title: string;
  generatedAt: number;
  downloadStatus: DownloadStatus;
  downloadIds?: number[];
  downloadedFiles?: string[];
  playlistStatus: PlaylistStatus;
  playlistIdentity?: string;
  lastErrorCode?: string;
  updatedAt: number;
}

export interface BatchRecord {
  kind: "download" | "playlist";
  index: number;
  /** Song UUIDs, never more than 100. */
  songIds: string[];
  status: BatchStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  downloadIds?: number[];
  files?: string[];
  errorCode?: string;
}

export interface PlaylistRef {
  // Stable visible identity when the site exposes one, else the exact name.
  identity: string;
  name: string;
  detail?: string;
}

export interface AlbumJob {
  schemaVersion: number;
  albumId: string;
  albumTitle: string;
  createdAt: number;
  updatedAt: number;
  inputDescription: string;
  songCount: number;
  workerCount: WorkerCount;
  playlistMode: "existing" | "new";
  playlistIdentity?: string;
  playlistName?: string;
  playlistCreated?: boolean;
  phase: JobPhase;
  // Phase to return to on resume from paused / needs_attention.
  resumePhase?: JobPhase;
  attentionCode?: string;
  tracks: TrackRecord[];
  songs: SongRecord[];
  workerStates: WorkerState[];
  downloadBatchSize: number;
  downloadBatches: BatchRecord[];
  playlistBatches: BatchRecord[];
  /** Last first-submission of any worker in the current run (gradual start). */
  lastRampAt?: number;
  /** Recent generation outcomes, for failure-rate backoff. */
  recentOutcomes?: { at: number; ok: boolean; code?: string }[];
  /** Replacement worker tabs opened after crashes/closures in this job. */
  workerReplacements?: number;
  /** Prompts handed to Flow (Generate may have been clicked) in this job. */
  submittedCount?: number;
  lastProcessedDownloadBatch?: number;
  lastProcessedPlaylistBatch?: number;
}

export interface Settings {
  workerCount: WorkerCount;
  playlistMode: "existing" | "new";
  playlist?: PlaylistRef;
  newPlaylistName?: string;
  pauseOnError: boolean;
  downloadBatchSize: number;
  generationTimeoutMs: number;
  draftDescription: string;
  draftSongCount: number;
}

// Typed result of every page action (plan §9.3).
export type ActionResult<T = undefined> =
  | { kind: "success"; data: T }
  | { kind: "retryable_failure"; code: string; detail?: string }
  | { kind: "needs_attention"; code: string; detail?: string }
  | { kind: "unsupported"; code: string; detail?: string };

export type PageKind = "session" | "my_songs" | "playlists" | "other";

export type PageBlocker = "login" | "captcha" | "quota" | "modal" | "alert" | null;

export interface PageState {
  kind: PageKind;
  url: string;
  blocker: PageBlocker;
  ready: boolean;
}

// A song as visible on My Songs.
export interface FlowSong {
  flowSongId?: string;
  title: string;
  createdAt?: number;
  // Position in the visible list, 0 = top.
  listIndex: number;
}

export interface GenerationEvidence {
  flowSongId?: string;
  /** Every song one generation produced (Flow made 2 per generation when inspected). */
  flowSongIds?: string[];
  flowTitle?: string;
  flowCreatedAt?: number;
}
