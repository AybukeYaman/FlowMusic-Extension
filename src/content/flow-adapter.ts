// Single registry of every Flow Music–specific selector and behavior.
//
// RULE: an entry stays `null` until it has been verified against the real,
// logged-in flowmusic.app UI. Adapters treat `null` as "unsupported" and fail
// safely; they never fall back to guessed selectors. Each filled entry notes
// the date and what was observed.
//
// Inspection 2026-10-14 (read-only; no generation, download, playlist change):
//   session.*         — compose form, in-progress state and result cards VERIFIED
//                       (2 test generations, 2026-10-14); failed state NOT VERIFIED
//   page.*            — NOT VERIFIED (account was logged in; no login wall, quota
//                       notice or blocking modal could be observed)
//   mySongs.*         — rows, ids, selection, toolbar VERIFIED; no dates in the list
//   playlistPicker.*  — menu + items VERIFIED; what happens on item click NOT VERIFIED
//   playlists.*       — VERIFIED
//   behavior.*        — see each field
//
// Observed facts that shape the integration:
//   - /session offers two inputs: a chat with an AI "Producer" and a Compose panel
//     (Lyrics + Instrumental switch, Sound description, Details → title, Generate).
//     The extension uses the Compose panel: it is a direct form, not a conversation.
//   - Producer-chat sessions (made before this extension) show TWO songs per
//     request. The Compose form produced exactly ONE song per Generate in both
//     test generations (2026-10-14). The data model keeps any number of songs
//     per prompt; more than BEHAVIOR.songsPerGeneration is treated as ambiguous.
//   - After Generate the Compose form is NOT cleared and Generate stays enabled:
//     a second click would start another generation. The adapter clicks once
//     per claimed prompt and overwrites title + sound before every submit.
//   - The first Generate in a new session moves the URL from /session to
//     /session/<uuid> (single-page navigation, no reload).
//   - Flow auto-plays each finished song in the page's player.
//   - The sidebar credit balance stayed 36 across both test generations.

import { FEATURES } from "../shared/features";
import type { MySongsOrder } from "../shared/messages";

export interface SelectorSpec {
  /** Scoped CSS selector based on verified markup. Prefer roles / aria / data-* attributes. */
  css: string;
  /** Optional accessible-name filter, applied to aria-label, title, then textContent. */
  name?: RegExp;
  /** Optional filter on the parent element's text (for unlabeled fields). */
  parentText?: RegExp;
}

export type SelectorKey =
  // Session / generation page (Compose panel)
  | "session.composeToggle"
  | "session.promptInput"
  | "session.instrumentalSwitch"
  | "session.detailsExpand"
  | "session.titleInput"
  | "session.generateButton"
  | "session.generatingIndicator"
  | "session.resultCard"
  | "session.resultTitle"
  | "session.resultLink"
  | "session.resultFailed"
  // Any page
  | "page.loginGate"
  | "page.quotaNotice"
  | "page.blockingModal"
  // My Songs
  | "mySongs.row"
  | "mySongs.rowLink"
  | "mySongs.rowTitle"
  | "mySongs.rowDate"
  | "mySongs.rowCheckbox"
  | "mySongs.selectedCount"
  | "mySongs.clearSelection"
  | "mySongs.downloadButton"
  | "mySongs.addToPlaylistButton"
  | "mySongs.loadMore"
  // Playlist chooser opened from My Songs
  | "playlistPicker.dialog"
  | "playlistPicker.option"
  | "playlistPicker.createButton"
  | "playlistPicker.nameInput"
  | "playlistPicker.confirm"
  | "playlistPicker.success"
  // Playlists page
  | "playlists.card"
  | "playlists.cardTitle"
  | "playlists.cardLink";

// Song card markup is shared by session results and My Songs rows (2026-10-14).
const SONG_CARD: SelectorSpec = { css: '[role="button"][aria-label^="Open details for "]' };
const SONG_LINK: SelectorSpec = { css: 'a[href^="/song/"]' };

export const SELECTORS: Record<SelectorKey, SelectorSpec | null> = {
  // 2026-10-14: header icon button; the panel's fields exist in the DOM even
  // when closed (zero width), so visibility decides whether to toggle it.
  "session.composeToggle": { css: 'button[aria-label="Toggle compose panel"]' },
  // 2026-10-14: <textarea aria-label="Sound description" maxlength="3000">.
  // Re-verified 2026-10-14 (phase 1): writing via the native value setter +
  // input event enables Generate; clearing it disables Generate again. The
  // panel slides in over ~1–2 s, during which the field has zero width.
  "session.promptInput": { css: 'textarea[aria-label="Sound description"]' },
  // 2026-10-14: <button role="switch" aria-checked="false|true">. Re-verified:
  // element.click() flips aria-checked; Lyrics is disabled while it is on.
  "session.instrumentalSwitch": { css: 'button[role="switch"][aria-label="Toggle instrumental mode"]' },
  // 2026-10-14: collapsed by default; label flips to "Collapse Details section".
  "session.detailsExpand": { css: 'button[aria-label="Expand Details section"]' },
  // 2026-10-14: unlabeled <textarea maxlength="100">, the only one on the page;
  // rendered only after "Expand Details section". The "Add title (optional)"
  // overlay in its parent disappears once text is typed, so it is not used to
  // find the field. Writing via the native setter + input event was verified.
  "session.titleInput": { css: 'textarea[maxlength="100"]' },
  // 2026-10-14: text-only <button>Generate</button>, `disabled` while the form is empty.
  "session.generateButton": { css: "button", name: /^Generate$/ },
  // 2026-10-14 (2 test generations): an accessible live region
  // <div role="status">Generating <title>...</div> appeared within ~1 s of the
  // click and emptied when the result card appeared (~22–30 s). A visual twin,
  // <div class="text-progress-trace-active">Creating "<title>"...</div>, became
  // a collapsed "Thoughts" header; the role=status region is used instead.
  "session.generatingIndicator": { css: '[role="status"]', name: /^Generating\b/ },
  // 2026-10-14: verified on finished results in an existing session.
  "session.resultCard": SONG_CARD,
  "session.resultTitle": SONG_LINK,
  "session.resultLink": SONG_LINK,
  // Not observed (both test generations succeeded). Until verified, a failed
  // generation surfaces as "generation_timeout" -> needs attention, never success.
  "session.resultFailed": null,

  "page.loginGate": null,
  "page.quotaNotice": null,
  "page.blockingModal": null,

  // 2026-10-14: one card per song; 20 rows per page, infinite scroll, loaded
  // rows stay in the DOM (80 unique after 3 loads).
  "mySongs.row": SONG_CARD,
  "mySongs.rowLink": SONG_LINK,
  "mySongs.rowTitle": SONG_LINK,
  // No date in the list. Song pages show "N days ago" with an exact
  // minute-precision tooltip, which is too coarse and too slow for bulk use.
  "mySongs.rowDate": null,
  // 2026-10-14: label flips "Select song" -> "Deselect song" when ticked.
  "mySongs.rowCheckbox": { css: 'button[aria-label="Select song"], button[aria-label="Deselect song"]' },
  // 2026-10-14: <span>N selected</span> in the toolbar; absent when nothing is selected.
  "mySongs.selectedCount": { css: "span", name: /^\d+ selected$/ },
  // 2026-10-14: toolbar ×; Escape also cleared the selection.
  "mySongs.clearSelection": { css: 'button[aria-label="Clear selection"]' },
  // 2026-10-14: text-only toolbar button. A "Delete" button sits next to it;
  // the anchored name keeps it from ever matching. Click NOT performed.
  "mySongs.downloadButton": { css: "button", name: /^Download$/ },
  // 2026-10-14: opens a Radix menu (aria-haspopup="menu").
  "mySongs.addToPlaylistButton": { css: 'button[aria-haspopup="menu"]', name: /^Add to playlist$/ },
  // Infinite scroll, no button (see BEHAVIOR.mySongsInfiniteScroll).
  "mySongs.loadMore": null,

  // 2026-10-14: menu lists "Create playlist" then every playlist by exact name.
  "playlistPicker.dialog": { css: '[role="menu"]' },
  "playlistPicker.option": { css: '[role="menuitem"]' },
  "playlistPicker.createButton": { css: '[role="menuitem"]', name: /^Create playlist$/ },
  // Not opened: choosing "Create playlist" could create one.
  "playlistPicker.nameInput": null,
  "playlistPicker.confirm": null,
  // Not observed: no item was clicked. Membership can instead be checked via
  // the playlist's "N songs" count on the Playlists page.
  "playlistPicker.success": null,

  // 2026-10-14: <a href="/playlist/<uuid>" aria-label="Playlist NAME by USER, N songs">.
  "playlists.card": { css: 'a[href^="/playlist/"]' },
  // 2026-10-14: first leaf <div> of the card holds the exact name.
  "playlists.cardTitle": { css: "div.font-display" },
  // The card is itself the link; the adapter reads its href directly.
  "playlists.cardLink": { css: 'a[href^="/playlist/"]' },
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const BEHAVIOR: {
  /** Extracts a stable song id from a song link href. Verified 2026-10-14. */
  songIdFromHref: RegExp | null;
  /** Extracts a stable playlist id from a playlist link href. Verified 2026-10-14. */
  playlistIdFromHref: RegExp | null;
  /**
   * Verified default ordering of the My Songs list. Observed 2026-10-14: top
   * row 1:02 AM, a lower row 1:00 AM (newest first), but only two minute-level
   * samples and the two versions of a song are not always adjacent, so this is
   * not treated as proven. Ordering falls back to the extension's own ledger.
   */
  mySongsOrder: MySongsOrder;
  /** My Songs loads more rows when its scroll container reaches the bottom. Verified 2026-10-14. */
  mySongsInfiniteScroll: boolean;
  /** Maximum selection on My Songs. PLAN says 100; the site limit is NOT VERIFIED. */
  maxSelection: number;
  /** How a multi-select download arrives. NOT VERIFIED (Download not clicked). */
  downloadShape: "per_song" | "single_archive" | "unknown";
  /** Whether a row's date text can be parsed into a timestamp. No row dates exist. */
  parseRowDate: ((text: string) => number | undefined) | null;
  /**
   * Songs one Compose "Generate" produced: 1 in both test generations
   * (2026-10-14). Fewer than this is still success; more is ambiguous.
   */
  songsPerGeneration: number;
  /**
   * Master switch for extension-driven submission. False in the default build;
   * true only in the supervised e2e test build (see shared/features.ts).
   */
  submissionEnabled: boolean;
} = {
  songIdFromHref: new RegExp(`^/song/(${UUID})`),
  playlistIdFromHref: new RegExp(`^/playlist/(${UUID})`),
  mySongsOrder: "unknown",
  mySongsInfiniteScroll: true,
  maxSelection: 100,
  downloadShape: "unknown",
  parseRowDate: null,
  songsPerGeneration: 1,
  submissionEnabled: FEATURES.submission,
};

export function isVerified(...keys: SelectorKey[]): boolean {
  return keys.every((k) => SELECTORS[k] !== null);
}

export function missingSelectors(...keys: SelectorKey[]): SelectorKey[] {
  return keys.filter((k) => SELECTORS[k] === null);
}
