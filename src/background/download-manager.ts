import { FLOW_ORIGIN, TIMING } from "../shared/constants";
import { normalizeTitle } from "../prompt/uniqueness-validator";
import type { DownloadOutcome } from "./job-logic";

// Attributes Chrome downloads to the active My Songs batch and decides when
// the batch's downloads are settled. The attribution record is persisted so
// a service-worker restart does not lose it.

export interface ActiveDownloadBatch {
  batchIndex: number;
  expected: number;
  clickedAt: number;
  ids: number[];
}

export interface DownloadFact {
  id: number;
  state: "in_progress" | "complete" | "interrupted";
  filename: string;
  error?: string;
}

const KEY = "downloads.active";

export async function getActive(): Promise<ActiveDownloadBatch | null> {
  return ((await chrome.storage.local.get(KEY))[KEY] as ActiveDownloadBatch | undefined) ?? null;
}

export async function setActive(active: ActiveDownloadBatch | null): Promise<void> {
  if (active) await chrome.storage.local.set({ [KEY]: active });
  else await chrome.storage.local.remove(KEY);
}

export function isFromFlow(item: Pick<chrome.downloads.DownloadItem, "url" | "finalUrl" | "referrer">): boolean {
  const from = (u?: string) => !!u && (u.startsWith(FLOW_ORIGIN) || u.startsWith(`blob:${FLOW_ORIGIN}`));
  return from(item.referrer) || from(item.url) || from(item.finalUrl);
}

export function withinAttributionWindow(active: ActiveDownloadBatch, startTime: number): boolean {
  return startTime >= active.clickedAt - 2_000 && startTime <= active.clickedAt + TIMING.downloadAttributionMs;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Pure decision on a batch's downloads. Returns null while it is too early
 * to decide. The site's download shape (one file per song or one archive)
 * is not yet verified, so only two layouts count as verified: exactly one
 * file per selected song, or a single archive for the whole batch.
 */
export function evaluateDownloads(
  expected: number,
  facts: DownloadFact[],
  ageMs: number,
): DownloadOutcome | null {
  const ids = facts.map((f) => f.id);
  const done = facts.filter((f) => f.state === "complete");
  const failed = facts.filter((f) => f.state === "interrupted");
  const running = facts.filter((f) => f.state === "in_progress");
  const files = done.map((f) => basename(f.filename));

  if (facts.length === 0) {
    if (ageMs < TIMING.downloadAttributionMs) return null;
    return { kind: "failed", code: "no_download_started", downloadIds: [] };
  }
  if (running.length > 0 && ageMs < TIMING.downloadSettleMs) return null;
  // More files may still be on their way (or waiting on Chrome's
  // multiple-download prompt) until the attribution window closes.
  if (done.length < expected && ageMs < TIMING.downloadAttributionMs && !(expected > 1 && isArchive(files))) return null;

  if (failed.length === 0 && running.length === 0) {
    if (done.length === expected) return { kind: "verified", downloadIds: ids, files };
    if (done.length === 1 && expected > 1 && isArchive(files)) return { kind: "verified", downloadIds: ids, files };
  }
  if (done.length === 0 && running.length === 0) {
    return { kind: "failed", code: failed[0]?.error ? `download_${failed[0].error.toLowerCase()}` : "download_failed", downloadIds: ids };
  }
  return {
    kind: "ambiguous",
    code: running.length > 0 ? "download_stalled" : done.length < expected ? "fewer_files_than_expected" : "file_mapping_unknown",
    downloadIds: ids,
    files,
  };
}

export interface SongRef {
  songId: string;
  title: string;
}

export type SongDownloadStatus = "downloaded" | "download_failed" | "verification_needed";

export interface SongDownloadResult {
  status: SongDownloadStatus;
  files?: string[];
  code?: string;
}

export interface BatchReconciliation {
  batchStatus: "completed" | "failed" | "partial";
  perSong: Record<string, SongDownloadResult>;
  downloadIds: number[];
  files: string[];
}

/** File name -> comparable title: no folder, no extension, no Chrome " (1)" suffix. */
export function fileTitle(path: string): string {
  const base = basename(path).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/\s*\(\d+\)$/, "");
  return normalizeTitle(base);
}

/**
 * Associates a batch's Chrome downloads with its songs. NOT VERIFIED against
 * Flow: whether a multi-select gives one file per song or an archive, and how
 * files are named, is unknown, so association is conservative:
 *  - one archive for the batch -> every song "downloaded" (in that archive);
 *  - otherwise a file maps to a song only if its name equals the song's title
 *    and exactly one song in the batch has that title;
 *  - a song whose own file was interrupted -> definite "download_failed";
 *  - nothing started at all after the attribution window -> "download_failed";
 *  - anything else (unmatched names, missing files) -> "verification_needed".
 * Returns null while it is too early to decide.
 */
export function reconcileSongDownloads(songs: SongRef[], facts: DownloadFact[], ageMs: number): BatchReconciliation | null {
  const ids = facts.map((f) => f.id);
  const done = facts.filter((f) => f.state === "complete");
  const running = facts.filter((f) => f.state === "in_progress");
  const files = done.map((f) => basename(f.filename));
  const all = (status: SongDownloadStatus, extra: Omit<SongDownloadResult, "status"> = {}) =>
    Object.fromEntries(songs.map((s) => [s.songId, { status, ...extra }]));

  if (facts.length === 0) {
    if (ageMs < TIMING.downloadAttributionMs) return null;
    return { batchStatus: "failed", perSong: all("download_failed", { code: "no_download_started" }), downloadIds: [], files: [] };
  }
  if (running.length > 0 && ageMs < TIMING.downloadSettleMs) return null;
  const archive = done.length === 1 && isArchive(files);
  if (!archive && done.length < songs.length && ageMs < TIMING.downloadAttributionMs) return null;

  if (archive && running.length === 0) {
    return { batchStatus: "completed", perSong: all("downloaded", { files, code: "archive" }), downloadIds: ids, files };
  }

  const titleCount = new Map<string, number>();
  for (const s of songs) titleCount.set(normalizeTitle(s.title), (titleCount.get(normalizeTitle(s.title)) ?? 0) + 1);
  const songByTitle = new Map(songs.filter((s) => titleCount.get(normalizeTitle(s.title)) === 1).map((s) => [normalizeTitle(s.title), s]));

  const perSong: Record<string, SongDownloadResult> = {};
  for (const f of facts) {
    const song = songByTitle.get(fileTitle(f.filename));
    if (!song) continue;
    const prev = perSong[song.songId];
    if (f.state === "complete") {
      perSong[song.songId] = { status: prev?.status === "downloaded" ? "verification_needed" : "downloaded", files: [...(prev?.files ?? []), basename(f.filename)], code: prev?.status === "downloaded" ? "duplicate_file" : undefined };
    } else if (f.state === "interrupted" && !prev) {
      perSong[song.songId] = { status: "download_failed", code: f.error ? `download_${f.error.toLowerCase()}` : "download_interrupted" };
    }
  }
  const everythingFailed = done.length === 0 && running.length === 0;
  for (const s of songs) {
    if (perSong[s.songId]) continue;
    perSong[s.songId] = everythingFailed
      ? { status: "download_failed", code: "download_interrupted" }
      : { status: "verification_needed", code: running.length > 0 ? "download_stalled" : "file_not_matched" };
  }
  const statuses = Object.values(perSong).map((r) => r.status);
  const batchStatus = statuses.every((x) => x === "downloaded") ? "completed"
    : statuses.every((x) => x === "download_failed") ? "failed" : "partial";
  return { batchStatus, perSong, downloadIds: ids, files };
}

function isArchive(files: string[]): boolean {
  return files.length === 1 && /\.(zip|rar|7z|tar|tgz|gz)$/i.test(files[0]!);
}

export async function collectFacts(ids: number[]): Promise<DownloadFact[]> {
  const facts: DownloadFact[] = [];
  for (const id of ids) {
    const [item] = await chrome.downloads.search({ id });
    if (!item) continue;
    facts.push({ id, state: item.state as DownloadFact["state"], filename: item.filename, error: item.error });
  }
  return facts;
}

/** After a restart: find Flow downloads that started in the batch window. */
export async function rediscover(active: ActiveDownloadBatch): Promise<number[]> {
  const items = await chrome.downloads.search({
    startedAfter: new Date(active.clickedAt - 2_000).toISOString(),
    startedBefore: new Date(active.clickedAt + TIMING.downloadAttributionMs).toISOString(),
  });
  return items.filter(isFromFlow).map((i) => i.id);
}
