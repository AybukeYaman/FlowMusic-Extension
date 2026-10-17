import { jobCounts } from "../../background/job-logic";
import type { AlbumJob, JobPhase, SongRecord, TrackRecord, WorkerState } from "../../shared/types";

export type Tone = "muted" | "active" | "ok" | "warn" | "bad";

export interface StatusView {
  label: string;
  icon: string;
  tone: Tone;
}

/** Status of one Flow song (one version): the furthest stage it reached. */
export function songStatus(s: SongRecord): StatusView {
  switch (s.playlistStatus) {
    case "added": return { label: "In playlist", icon: "listMusic", tone: "ok" };
    case "selecting":
    case "adding": return { label: "Adding", icon: "loader", tone: "active" };
    case "add_failed": return { label: "Add failed", icon: "x", tone: "bad" };
    case "verification_needed": return { label: "Check playlist", icon: "help", tone: "warn" };
    case "not_started": break;
  }
  switch (s.downloadStatus) {
    case "downloaded": return { label: "Downloaded", icon: "download", tone: "ok" };
    case "selecting":
    case "downloading": return { label: "Downloading", icon: "loader", tone: "active" };
    case "download_failed": return { label: "Download failed", icon: "x", tone: "bad" };
    case "verification_needed": return { label: "Check download", icon: "help", tone: "warn" };
    case "not_started": return { label: "Generated", icon: "check", tone: "ok" };
  }
}

const TONE_RANK: Record<Tone, number> = { bad: 4, warn: 3, active: 2, muted: 1, ok: 0 };

/**
 * One canonical status per prompt. Before generation finishes it is the
 * prompt's own status; afterwards the most urgent status among its songs.
 */
export function trackStatusView(t: TrackRecord, songs: SongRecord[]): StatusView {
  if (t.trackStatus === "generated" && songs.length > 0) {
    return songs.map(songStatus).sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone])[0]!;
  }
  switch (t.trackStatus) {
    case "draft": return { label: "Draft", icon: "circle", tone: "muted" };
    case "queued": return { label: "Queued", icon: "clock", tone: "muted" };
    case "assigned":
    case "generating": return { label: "Generating", icon: "loader", tone: "active" };
    case "generated": return { label: "Generated", icon: "check", tone: "ok" };
    case "generation_failed": return { label: "Failed", icon: "x", tone: "bad" };
    case "needs_attention": return { label: "Needs attention", icon: "alert", tone: "warn" };
    case "cancelled": return { label: "Cancelled", icon: "x", tone: "muted" };
  }
}

export function workerStatus(w: WorkerState): StatusView {
  switch (w.status) {
    case "idle":
    case "ready":
      // Gradual start: waiting for its turn to make a first submission.
      if (w.startAfter && w.startAfter > Date.now() && !w.currentTrackId) return { label: "Starting soon", icon: "clock", tone: "muted" };
      return { label: "Idle", icon: "circle", tone: "muted" };
    case "loading": return { label: "Loading", icon: "loader", tone: "active" };
    case "submitting": return { label: "Submitting", icon: "loader", tone: "active" };
    case "generating": return { label: "Generating", icon: "loader", tone: "active" };
    case "verifying": return { label: "Checking", icon: "loader", tone: "active" };
    case "paused": return { label: attentionLabel(w.lastError) ?? "Paused", icon: "pause", tone: "warn" };
    case "error": return { label: attentionLabel(w.lastError) ?? "Error", icon: "x", tone: "bad" };
  }
}

export const PHASE_LABEL: Record<JobPhase, string> = {
  draft: "Draft",
  generating: "Generating",
  downloads: "Downloading",
  playlist: "Playlist",
  completed: "Done",
  paused: "Paused",
  stopped: "Stopped",
  needs_attention: "Needs attention",
};

const ATTENTION: Record<string, string> = {
  ui_unverified: "Flow UI not verified",
  selector_unverified: "Flow UI not verified",
  login: "Log in to Flow Music",
  login_required: "Log in to Flow Music",
  captcha: "Verification required",
  quota: "Limit reached",
  modal: "Dialog open on page",
  blocked: "Page blocked",
  order_unverified: "Order needs verification",
  selection_count_mismatch: "Selection mismatch",
  selection_not_cleared: "Selection mismatch",
  no_download_started: "Download blocked",
  fewer_files_than_expected: "Downloads incomplete",
  file_mapping_unknown: "Check downloads",
  download_stalled: "Download stalled",
  playlist_not_found: "Playlist not found",
  playlist_ambiguous: "Playlist name not unique",
  playlist_missing: "Choose a playlist",
  membership_unknown: "Playlist add unverified",
  my_songs_unavailable: "My Songs unavailable",
  result_unknown: "Result unclear",
  generation_timeout: "Generation timed out",
  accept_unconfirmed: "Submission unclear",
  session_not_ready: "Session not ready",
  song_not_found: "Song not found",
  tab_closed: "Tab closed",
  job_active: "A job is running",
  playlist_required: "Choose a playlist",
  playlist_name_required: "Name the playlist",
  empty_description: "Describe the album",
  invalid_song_count: "Songs: 1–500",
  nothing_to_process: "No finished songs yet",
  batch_in_progress: "Batch in progress",
  playlists_unavailable: "Playlists unavailable",
  downloads_disabled: "Downloads not enabled",
  form_check_failed: "Form check failed; nothing sent",
  title_already_on_page: "Song with this title already exists",
  unconfirmed_fill_left_on_page: "Earlier fill may have been generated manually",
  credits_unreadable: "Credit balance unreadable",
  credits_unexpected_spend: "Unexpected credit use",
  credits_below_floor: "Credit balance too low",
  workers_unverified: "Worker count not yet verified",
  failure_rate: "Repeated failures: paused, fewer workers",
  title_mismatch: "Result title differs",
  left_flow: "Tab left Flow Music",
  tab_unresponsive: "Tab not responding",
  indicator_cleared_without_result: "No song after generating",
  rate_limit: "Rate limited",
  alert: "Page shows a message",
  downloads_need_check: "Check downloads",
  download_failed: "Download failed",
  file_not_matched: "File not matched to song",
  no_baseline: "Result unclear",
  result_unidentified: "Result has no ID",
  result_ambiguous: "Unexpected extra result",
  generation_failed_on_site: "Generation failed",
  submit_no_response: "Submission unclear",
  playlist_disabled: "Playlist step not enabled",
  test_not_confirmed: "Generate not confirmed",
  submission_not_enabled: "Submission not enabled",
};

export function attentionLabel(code?: string): string | undefined {
  if (!code) return undefined;
  if (ATTENTION[code]) return ATTENTION[code];
  if (code.startsWith("download_")) return "Download failed";
  return undefined;
}

export interface Progress {
  done: number;
  total: number;
  unit: "prompts" | "songs downloaded" | "songs in playlist";
}

/** Single progress figure for the current stage of the job. */
export function jobProgress(job: AlbumJob): Progress {
  const phase = job.phase === "paused" || job.phase === "needs_attention" || job.phase === "stopped"
    ? job.resumePhase ?? "generating"
    : job.phase;
  const c = jobCounts(job);
  if (phase === "downloads") return { done: c.songsDownloaded, total: c.songsFound, unit: "songs downloaded" };
  if (phase === "playlist" || phase === "completed") {
    return { done: c.songsAdded, total: c.songsDownloaded, unit: "songs in playlist" };
  }
  return { done: c.promptsDone, total: c.promptsTotal, unit: "prompts" };
}

/**
 * Secondary line that keeps prompts and songs apart, e.g. "50/50 prompts ·
 * 100 songs". While the main figure already counts prompts, only songs are added.
 */
export function countsLine(job: AlbumJob): string {
  const c = jobCounts(job);
  const songs = `${c.songsFound} ${c.songsFound === 1 ? "song" : "songs"} found${c.songsDownloaded > 0 ? ` · ${c.songsDownloaded} downloaded` : ""}`;
  return jobProgress(job).unit === "prompts" ? songs : `${c.promptsDone}/${c.promptsTotal} prompts · ${songs}`;
}

export function issueCount(job: AlbumJob): number {
  const bad = (v: StatusView) => v.tone === "bad" || v.tone === "warn";
  const trackIssues = job.tracks.filter((t) => t.trackStatus !== "generated" && bad(trackStatusView(t, []))).length;
  return trackIssues + job.songs.filter((s) => bad(songStatus(s))).length;
}
