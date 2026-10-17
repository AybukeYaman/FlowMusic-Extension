import type { MySongsOrder } from "../shared/messages";
import type { FlowSong, SongRecord } from "../shared/types";

export interface SongMatch {
  songId: string;
  song: FlowSong;
}

export interface MatchResult {
  matches: SongMatch[];
  /** Ledger songs whose UUID is not visible on My Songs. */
  unmatched: string[];
}

/**
 * Maps ledger songs to visible My Songs rows by song UUID only. Titles are
 * never used: both versions of a generation share a title, and matching by
 * title or list position could pull unrelated library songs into a batch.
 */
export function matchSongs(songs: SongRecord[], visible: FlowSong[]): MatchResult {
  const byId = new Map<string, FlowSong>();
  for (const v of visible) if (v.flowSongId && !byId.has(v.flowSongId)) byId.set(v.flowSongId, v);
  const matches: SongMatch[] = [];
  const unmatched: string[] = [];
  for (const s of songs) {
    const v = byId.get(s.songId);
    if (v) matches.push({ songId: s.songId, song: v });
    else unmatched.push(s.songId);
  }
  return { matches, unmatched };
}

export class OrderUnverifiedError extends Error {
  constructor() {
    super("order_unverified");
  }
}

/**
 * Oldest-first ordering from the strongest available evidence: site
 * timestamps, then a verified list order, then the ledger's own generation
 * times (versions of one generation keep their page order). Throws when none
 * of these can order every match.
 */
export function sortOldestFirst(
  matches: SongMatch[],
  order: MySongsOrder,
  songs: Map<string, SongRecord>,
): SongMatch[] {
  if (matches.every((m) => typeof m.song.createdAt === "number")) {
    return [...matches].sort((a, b) => a.song.createdAt! - b.song.createdAt! || a.song.listIndex - b.song.listIndex);
  }
  if (order === "oldest_first") return [...matches].sort((a, b) => a.song.listIndex - b.song.listIndex);
  if (order === "newest_first") return [...matches].sort((a, b) => b.song.listIndex - a.song.listIndex);
  const rec = (m: SongMatch) => songs.get(m.songId);
  if (matches.every((m) => typeof rec(m)?.generatedAt === "number")) {
    return [...matches].sort((a, b) => rec(a)!.generatedAt - rec(b)!.generatedAt || rec(a)!.version - rec(b)!.version);
  }
  throw new OrderUnverifiedError();
}
