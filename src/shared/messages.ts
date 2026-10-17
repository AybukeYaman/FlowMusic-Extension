import type {
  ActionResult, FlowSong, GenerationEvidence, PageState, PlaylistRef, Settings, WorkerCount,
} from "./types";

// Popup -> service worker.
export type Command =
  | { type: "plan"; description: string; songCount: number }
  | {
      type: "start";
      description: string;
      songCount: number;
      workerCount: WorkerCount;
      playlistMode: "existing" | "new";
      playlist?: PlaylistRef;
      newPlaylistName?: string;
      tabId?: number;
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "processCompleted" }
  | { type: "retry"; phase: "generation" | "downloads" | "playlist" }
  | { type: "editPrompt"; trackId: string; prompt: string }
  | { type: "setWorkerCount"; workerCount: WorkerCount }
  | { type: "selectPlaylist"; playlist: PlaylistRef }
  | { type: "listPlaylists" }
  | { type: "updateSettings"; patch: Partial<Pick<Settings, "pauseOnError" | "downloadBatchSize">> }
  | { type: "discardJob" };

export type CommandResponse<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export type MySongsOrder = "oldest_first" | "newest_first" | "timestamp" | "unknown";

// Service worker -> content script.
export type PageRequest =
  | { type: "page.state" }
  /** Sidebar balance (number next to "Invite"); meaning unverified. */
  | { type: "page.credits" }
  | { type: "session.submit"; trackId: string; prompt: string; title?: string; instrumental?: boolean }
  | { type: "session.watch"; trackId: string; submittedAt: number; timeoutMs: number }
  | { type: "session.probe"; trackId: string }
  | { type: "mySongs.scan"; wanted?: string[] }
  | { type: "mySongs.clearSelection" }
  | { type: "mySongs.select"; songs: FlowSong[] }
  | { type: "mySongs.download"; expected: number }
  | { type: "mySongs.addToPlaylist"; playlist: PlaylistRef; create: boolean; expected: number }
  | { type: "playlists.list" }
  /** e2e build only: job snapshot for the supervisor. */
  | { type: "debug.snapshot"; snapshot: unknown };

export interface ScanData {
  songs: FlowSong[];
  order: MySongsOrder;
}

export interface PageResponses {
  "page.state": PageState;
  "page.credits": { value: number | null };
  "session.submit": ActionResult;
  "session.watch": ActionResult;
  "session.probe": ActionResult<GenerationEvidence | null | "still_generating">;
  "mySongs.scan": ActionResult<ScanData>;
  "mySongs.clearSelection": ActionResult;
  "mySongs.select": ActionResult<{ selected: number }>;
  "mySongs.download": ActionResult;
  "mySongs.addToPlaylist": ActionResult<{ playlist: PlaylistRef }>;
  "playlists.list": ActionResult<PlaylistRef[]>;
  "debug.snapshot": ActionResult;
}

// Content script -> service worker (unsolicited).
export type PageEvent =
  /** navigation: "load" = fresh content script (page loaded/reloaded); "spa" = in-page URL change. */
  | { type: "content.ready"; page: PageState; navigation: "load" | "spa" }
  | { type: "session.result"; trackId: string; result: ActionResult<GenerationEvidence> };

/**
 * session.submit failure codes that are only returned before the Generate
 * control was clicked, i.e. the prompt verifiably never reached the site.
 */
export const NOT_SUBMITTED_CODES = new Set([
  "selector_unverified", "target_missing", "target_ambiguous", "target_disabled",
  "input_mismatch", "blocked", "wrong_page", "busy", "page_not_ready",
  // The automatic pre-click form check failed: Generate was not clicked.
  "form_check_failed",
  // Credit guard stopped before submitting: nothing was typed or clicked.
  "credits_unreadable", "credits_below_floor",
  // e2e build: the supervisor did not confirm, so Generate was never clicked.
  "test_not_confirmed",
]);

export function isPageEvent(msg: unknown): msg is PageEvent {
  const t = (msg as { type?: unknown } | null)?.type;
  return t === "content.ready" || t === "session.result";
}
