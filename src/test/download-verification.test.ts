import { describe, expect, it } from "vitest";
import { evaluateDownloads, isFromFlow, type DownloadFact } from "../background/download-manager";
import { TIMING } from "../shared/constants";

const done = (id: number, filename: string): DownloadFact => ({ id, state: "complete", filename });
const late = TIMING.downloadAttributionMs + 1;

describe("download verification", () => {
  it("waits while it is too early to decide", () => {
    expect(evaluateDownloads(3, [], 1_000)).toBeNull();
    expect(evaluateDownloads(3, [done(1, "a.mp3")], 1_000)).toBeNull();
    expect(evaluateDownloads(1, [{ id: 1, state: "in_progress", filename: "" }], late)).toBeNull();
  });

  it("verifies one file per selected song", () => {
    const out = evaluateDownloads(2, [done(1, "C:\\Music\\a.mp3"), done(2, "/x/b.mp3")], late);
    expect(out).toEqual({ kind: "verified", downloadIds: [1, 2], files: ["a.mp3", "b.mp3"] });
  });

  it("verifies a single archive for a multi-song batch immediately", () => {
    expect(evaluateDownloads(100, [done(9, "songs.zip")], 5_000)?.kind).toBe("verified");
  });

  it("does not claim success for a single non-archive file covering many songs", () => {
    expect(evaluateDownloads(5, [done(1, "song.mp3")], late)).toMatchObject({ kind: "ambiguous", code: "fewer_files_than_expected" });
  });

  it("reports nothing started (e.g. blocked by the browser) as failed", () => {
    expect(evaluateDownloads(5, [], late)).toMatchObject({ kind: "failed", code: "no_download_started" });
  });

  it("reports interrupted downloads", () => {
    expect(evaluateDownloads(1, [{ id: 1, state: "interrupted", filename: "", error: "NETWORK_FAILED" }], late))
      .toMatchObject({ kind: "failed", code: "download_network_failed" });
    expect(evaluateDownloads(2, [done(1, "a.mp3"), { id: 2, state: "interrupted", filename: "" }], late))
      .toMatchObject({ kind: "ambiguous" });
  });

  it("flags downloads that never finish", () => {
    const stuck: DownloadFact[] = [{ id: 1, state: "in_progress", filename: "" }];
    expect(evaluateDownloads(1, stuck, TIMING.downloadSettleMs + 1)).toMatchObject({ kind: "ambiguous", code: "download_stalled" });
  });

  it("attributes only Flow Music downloads", () => {
    expect(isFromFlow({ url: "https://cdn.example.com/a.mp3", finalUrl: "", referrer: "https://www.flowmusic.app/library/my-songs" })).toBe(true);
    expect(isFromFlow({ url: "blob:https://www.flowmusic.app/123", finalUrl: "", referrer: "" })).toBe(true);
    expect(isFromFlow({ url: "https://other.site/a.mp3", finalUrl: "", referrer: "https://other.site/" })).toBe(false);
  });
});
