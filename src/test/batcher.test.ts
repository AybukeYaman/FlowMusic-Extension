import { describe, expect, it } from "vitest";
import { chunk, clampBatchSize } from "../background/batcher";
import { applyDownloadOutcome, planBatches } from "../background/job-logic";
import { allSongIds, generateAll, makeJob, markAllDownloaded } from "./fixtures/jobs";

const sizes = (n: number, size = 100) => chunk([...Array(n).keys()], size).map((b) => b.length);

describe("batch partitioning", () => {
  it.each([
    [0, []],
    [1, [1]],
    [50, [50]],
    [100, [100]],
    [101, [100, 1]],
    [200, [100, 100]],
    [237, [100, 100, 37]],
  ])("%i songs -> %j", (n, expected) => {
    expect(sizes(n)).toEqual(expected);
  });

  it("never exceeds 100 even if configured higher", () => {
    expect(clampBatchSize(250)).toBe(100);
    expect(sizes(237, 500)).toEqual([100, 100, 37]);
  });

  it("respects smaller configured sizes", () => {
    expect(sizes(237, 60)).toEqual([60, 60, 60, 57]);
    expect(clampBatchSize(0)).toBe(1);
  });

  it("keeps order and never repeats an item across batches", () => {
    const items = [...Array(237).keys()];
    expect(chunk(items, 100).flat()).toEqual(items);
  });
});

describe("song batches (sized by songs, not prompts)", () => {
  it.each([
    [50, 2, [100]],
    [125, 2, [100, 100, 50]],
    [51, 2, [100, 2]],
    [237, 1, [100, 100, 37]],
  ])("%i prompts x %i versions -> %j", (prompts, versions, expected) => {
    const job = makeJob(prompts);
    generateAll(job, versions);
    expect(job.songs).toHaveLength(prompts * versions);
    const created = planBatches(job, "download", allSongIds(job));
    expect(created.map((b) => b.songIds.length)).toEqual(expected);
    expect(created.map((b) => b.index)).toEqual(expected.map((_, i) => i));
  });

  it("puts every version of every prompt in exactly one batch", () => {
    const job = makeJob(125);
    generateAll(job, 2);
    const created = planBatches(job, "download", allSongIds(job));
    const flat = created.flatMap((b) => b.songIds);
    expect(flat).toHaveLength(250);
    expect(new Set(flat).size).toBe(250);
    expect(created.every((b) => b.songIds.length <= 100)).toBe(true);
  });

  it("continues indexes and never re-queues songs already in a live batch", () => {
    const job = makeJob(125);
    generateAll(job, 2);
    const ids = allSongIds(job);
    const first = planBatches(job, "download", ids.slice(0, 200));
    const again = planBatches(job, "download", ids); // overlaps the first 200
    expect(first.map((b) => b.songIds.length)).toEqual([100, 100]);
    expect(again.map((b) => [b.index, b.songIds.length])).toEqual([[2, 50]]);
    expect(new Set(job.downloadBatches.flatMap((b) => b.songIds)).size).toBe(250);
  });

  it("drops duplicate, unknown and already-downloaded ids", () => {
    const job = makeJob(3);
    generateAll(job, 2);
    const [a, b] = allSongIds(job);
    const [done] = planBatches(job, "download", [a!]);
    applyDownloadOutcome(job, done!.index, { kind: "verified", downloadIds: [1], files: ["a.mp3"] });
    const created = planBatches(job, "download", [a!, b!, b!, "not-a-known-uuid"]);
    expect(created.flatMap((x) => x.songIds)).toEqual([b]);
  });

  it("plans playlist batches the same way, only for downloaded songs", () => {
    const job = makeJob(125);
    generateAll(job, 2);
    expect(planBatches(job, "playlist", allSongIds(job))).toEqual([]);
    markAllDownloaded(job);
    expect(planBatches(job, "playlist", allSongIds(job)).map((b) => b.songIds.length)).toEqual([100, 100, 50]);
  });
});
