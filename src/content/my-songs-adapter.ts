import { FEATURES } from "../shared/features";
import type { ScanData } from "../shared/messages";
import type { ActionResult, FlowSong, PlaylistRef } from "../shared/types";
import { click, find, findExactlyOne, setFieldValue, text, unsupported, waitFor } from "./dom-utils";
import { BEHAVIOR, missingSelectors, type SelectorKey } from "./flow-adapter";
import { detectBlocker, pageKind } from "./page-state-detector";

// My Songs: discovery, exact selection (max 100), Download and Add Playlist.
// Every bulk action re-verifies the selected count before clicking.

function guard(...keys: SelectorKey[]): ActionResult<never> | null {
  const missing = missingSelectors(...keys);
  if (missing.length > 0) return unsupported(missing.join(","));
  if (pageKind() !== "my_songs") return { kind: "retryable_failure", code: "wrong_page" };
  const blocker = detectBlocker();
  if (blocker) return { kind: "needs_attention", code: "blocked", detail: blocker };
  return null;
}

function songIdOf(row: Element): string | undefined {
  if (!BEHAVIOR.songIdFromHref) return undefined;
  const href = find("mySongs.rowLink", row)?.[0]?.getAttribute("href") ?? "";
  return href.match(BEHAVIOR.songIdFromHref)?.[1];
}

function rows(): Element[] {
  return find("mySongs.row") ?? [];
}

function toSong(row: Element, listIndex: number): FlowSong {
  const dateText = text(find("mySongs.rowDate", row)?.[0]);
  return {
    flowSongId: songIdOf(row),
    title: text(find("mySongs.rowTitle", row)?.[0]),
    createdAt: dateText && BEHAVIOR.parseRowDate ? BEHAVIOR.parseRowDate(dateText) : undefined,
    listIndex,
  };
}

function scrollContainer(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/**
 * Loads the full list (bounded): a verified "load more" button if one exists,
 * otherwise infinite scroll, which is what My Songs used on 2026-10-14.
 */
async function loadAll(done: () => boolean = () => false): Promise<void> {
  const container = rows()[0] ? scrollContainer(rows()[0]!) : null;
  for (let i = 0; i < 100; i++) {
    if (done()) break;
    const before = rows().length;
    const more = find("mySongs.loadMore");
    if (more && more.length === 1) click(more[0]!);
    else if (BEHAVIOR.mySongsInfiniteScroll && container) container.scrollTop = container.scrollHeight;
    else break;
    const grew = await waitFor(() => rows().length > before, { timeoutMs: 6_000 });
    if (!grew) break;
  }
  if (container) container.scrollTop = 0;
}

/** True once every wanted UUID has a loaded row. */
export function allPresent(wanted: readonly string[], present: ReadonlySet<string>): boolean {
  return wanted.every((id) => present.has(id));
}

function loadedIds(): Set<string> {
  return new Set(rows().flatMap((r) => {
    const id = songIdOf(r);
    return id ? [id] : [];
  }));
}

/**
 * Loads My Songs until every wanted UUID is present (or the list ends), so a
 * batch of recent songs does not require scrolling the whole library.
 */
export async function scan(wanted: string[] = []): Promise<ActionResult<ScanData>> {
  const g = guard("mySongs.row", "mySongs.rowTitle");
  if (g) return g;
  await waitFor(() => rows().length > 0, { timeoutMs: 15_000 });
  await loadAll(() => wanted.length > 0 && allPresent(wanted, loadedIds()));
  return { kind: "success", data: { songs: rows().map(toSong), order: BEHAVIOR.mySongsOrder } };
}

// Rows are found by song UUID only: versions of one generation share a title.
function findRow(song: FlowSong): ActionResult<Element> {
  if (!song.flowSongId) return { kind: "needs_attention", code: "song_unidentified", detail: song.title };
  const matches = rows().filter((r) => songIdOf(r) === song.flowSongId);
  if (matches.length === 1) return { kind: "success", data: matches[0]! };
  return { kind: "needs_attention", code: matches.length === 0 ? "song_not_found" : "song_ambiguous", detail: song.title };
}

function selectedCount(): number | null {
  const el = find("mySongs.selectedCount")?.[0];
  if (!el) return 0;
  const m = text(el).match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Verified 2026-10-14: the row checkbox's label flips to "Deselect song" when ticked.
function isChecked(box: Element): boolean {
  return box.getAttribute("aria-label") === "Deselect song" ||
    (box as HTMLInputElement).checked === true || box.getAttribute("aria-checked") === "true";
}

export async function clearSelection(): Promise<ActionResult> {
  const g = guard("mySongs.selectedCount", "mySongs.clearSelection");
  if (g) return g;
  if (selectedCount() === 0) return { kind: "success", data: undefined };
  const btn = findExactlyOne("mySongs.clearSelection");
  if (btn.kind !== "success") return btn;
  click(btn.data);
  const cleared = await waitFor(() => selectedCount() === 0, { timeoutMs: 5_000 });
  return cleared ? { kind: "success", data: undefined } : { kind: "needs_attention", code: "selection_not_cleared" };
}

export async function select(songs: FlowSong[]): Promise<ActionResult<{ selected: number }>> {
  // Selection only serves Download / Add to playlist; off while both are.
  if (!FEATURES.downloads && !FEATURES.playlist) return unsupported("downloads_disabled");
  const g = guard("mySongs.row", "mySongs.rowCheckbox", "mySongs.selectedCount", "mySongs.clearSelection");
  if (g) return g;
  if (songs.length === 0 || songs.length > BEHAVIOR.maxSelection) {
    return { kind: "needs_attention", code: "batch_size_invalid", detail: String(songs.length) };
  }
  const cleared = await clearSelection();
  if (cleared.kind !== "success") return cleared;

  // Older songs sit below the first page of the infinite list.
  const wantedIds = songs.flatMap((s) => (s.flowSongId ? [s.flowSongId] : []));
  if (songs.some((s) => findRow(s).kind !== "success")) await loadAll(() => allPresent(wantedIds, loadedIds()));

  // Resolve every row first; do not click anything if one is missing.
  const targets: Element[] = [];
  for (const song of songs) {
    const row = findRow(song);
    if (row.kind !== "success") return row;
    const box = findExactlyOne("mySongs.rowCheckbox", row.data, true);
    if (box.kind !== "success") return box;
    targets.push(box.data);
  }
  for (const box of targets) if (!isChecked(box)) click(box);

  const count = await waitFor(() => (selectedCount() === songs.length ? songs.length : null), { timeoutMs: 10_000 });
  if (count === null) {
    return { kind: "needs_attention", code: "selection_count_mismatch", detail: `${selectedCount()}/${songs.length}` };
  }
  return { kind: "success", data: { selected: count } };
}

function verifyCount(expected: number): ActionResult<never> | null {
  const n = selectedCount();
  return n === expected ? null : { kind: "needs_attention", code: "selection_count_mismatch", detail: `${n}/${expected}` };
}

/** Clicks Download. Completion is verified by the service worker via chrome.downloads. */
export async function download(expected: number): Promise<ActionResult> {
  if (!FEATURES.downloads) return unsupported("downloads_disabled");
  const g = guard("mySongs.downloadButton", "mySongs.selectedCount");
  if (g) return g;
  const mismatch = verifyCount(expected);
  if (mismatch) return mismatch;
  const btn = findExactlyOne("mySongs.downloadButton");
  if (btn.kind !== "success") return btn;
  click(btn.data);
  return { kind: "success", data: undefined };
}

export async function addToPlaylist(
  playlist: PlaylistRef, create: boolean, expected: number,
): Promise<ActionResult<{ playlist: PlaylistRef }>> {
  if (!FEATURES.playlist) return unsupported("playlist_disabled");
  const g = guard(
    "mySongs.addToPlaylistButton", "mySongs.selectedCount",
    "playlistPicker.dialog", "playlistPicker.option", "playlistPicker.success",
    ...(create ? (["playlistPicker.createButton", "playlistPicker.nameInput", "playlistPicker.confirm"] as const) : []),
  );
  if (g) return g;
  const mismatch = verifyCount(expected);
  if (mismatch) return mismatch;

  const open = findExactlyOne("mySongs.addToPlaylistButton");
  if (open.kind !== "success") return open;
  click(open.data);
  const dialog = await waitFor(() => find("playlistPicker.dialog")?.[0], { timeoutMs: 8_000 });
  if (!dialog) return { kind: "needs_attention", code: "playlist_picker_missing" };

  if (create) {
    const createBtn = findExactlyOne("playlistPicker.createButton", dialog);
    if (createBtn.kind !== "success") return createBtn;
    click(createBtn.data);
    const input = await waitFor(() => find("playlistPicker.nameInput")?.[0], { timeoutMs: 5_000 });
    if (!input) return { kind: "needs_attention", code: "playlist_name_input_missing" };
    setFieldValue(input, playlist.name);
    const confirm = findExactlyOne("playlistPicker.confirm");
    if (confirm.kind !== "success") return confirm;
    click(confirm.data);
  } else {
    const options = (find("playlistPicker.option", dialog) ?? []).filter((o) => text(o) === playlist.name);
    if (options.length !== 1) {
      return { kind: "needs_attention", code: options.length === 0 ? "playlist_not_found" : "playlist_ambiguous" };
    }
    click(options[0]!);
  }

  const ok = await waitFor(() => find("playlistPicker.success")?.length, { timeoutMs: 15_000 });
  if (!ok) return { kind: "needs_attention", code: "membership_unknown" };
  return { kind: "success", data: { playlist } };
}
