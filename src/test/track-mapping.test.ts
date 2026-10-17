import { describe, expect, it } from "vitest";
import { createJob, validateStart } from "../background/job-logic";
import { planAlbum } from "../prompt/local-planner";
import { normalizeTitle } from "../prompt/uniqueness-validator";

const DESCRIPTION = "Calm lo-fi hip hop for late-night studying. Warm Rhodes, soft rain, vinyl crackle. Instrumental only. Avoid loud percussion.";

describe("Songs = N gives N tracks, each with its own unique title and prompt", () => {
  it.each([1, 10, 50, 125, 500])("%i tracks", (n) => {
    const plan = planAlbum({ description: DESCRIPTION }, n, { albumId: "alb" });
    expect(plan.tracks).toHaveLength(n);
    // Exactly one title and one prompt per track, in order.
    expect(plan.tracks.map((t) => t.index)).toEqual([...Array(n).keys()]);
    expect(new Set(plan.tracks.map((t) => t.trackId)).size).toBe(n);
    expect(new Set(plan.tracks.map((t) => normalizeTitle(t.title))).size).toBe(n);
    expect(new Set(plan.tracks.map((t) => t.prompt)).size).toBe(n);
    for (const t of plan.tracks) {
      expect(t.title.trim()).not.toBe("");
      expect(t.prompt.trim()).not.toBe("");
    }
  });

  it("keeps the title/prompt pairing when the plan becomes a job", () => {
    const plan = planAlbum({ description: DESCRIPTION }, 50, { albumId: "alb" });
    const job = createJob(plan, {
      description: DESCRIPTION, workerCount: 8, playlistMode: "existing",
      playlistIdentity: "pl-1", playlistName: "My Album Playlist", downloadBatchSize: 100,
    });
    expect(job.tracks).toHaveLength(50);
    job.tracks.forEach((t, i) => {
      const p = plan.tracks[i]!;
      expect([t.trackId, t.index, t.plannedTitle, t.prompt]).toEqual([p.trackId, p.index, p.title, p.prompt]);
    });
    // Titles are per track; the playlist is one separate destination for the album.
    expect(job.playlistName).toBe("My Album Playlist");
    expect(job.tracks.some((t) => t.plannedTitle === job.playlistName)).toBe(false);
    expect(job.tracks.map((t) => t.plannedTitle)).not.toContain(job.albumTitle);
  });

  it("titles do not depend on the playlist choice", () => {
    const plan = (name?: string) => createJob(planAlbum({ description: DESCRIPTION }, 50, { albumId: "alb" }), {
      description: DESCRIPTION, workerCount: 8, playlistMode: name ? "new" : "existing", playlistName: name, downloadBatchSize: 100,
    }).tracks.map((t) => t.plannedTitle);
    expect(plan("Brand New Playlist")).toEqual(plan());
  });
});

describe("playlist destination at Start", () => {
  const base = { description: DESCRIPTION, songCount: 50 };

  it("requires one existing playlist or one new name while playlist placement is on", () => {
    expect(validateStart({ ...base, playlistMode: "existing" }, true)).toBe("playlist_required");
    expect(validateStart({ ...base, playlistMode: "existing", playlist: { identity: "id", name: "Mix" } }, true)).toBeNull();
    expect(validateStart({ ...base, playlistMode: "new", newPlaylistName: "  " }, true)).toBe("playlist_name_required");
    expect(validateStart({ ...base, playlistMode: "new", newPlaylistName: "Album 1" }, true)).toBeNull();
  });

  it("allows an empty playlist for a generation-only run", () => {
    expect(validateStart({ ...base, playlistMode: "existing" }, false)).toBeNull();
    expect(validateStart({ ...base, playlistMode: "new", newPlaylistName: "" }, false)).toBeNull();
  });

  it("still validates the album input", () => {
    expect(validateStart({ ...base, description: " ", playlistMode: "existing" }, false)).toBe("empty_description");
    expect(validateStart({ ...base, songCount: 0, playlistMode: "existing" }, false)).toBe("invalid_song_count");
    expect(validateStart({ ...base, songCount: 501, playlistMode: "existing" }, false)).toBe("invalid_song_count");
  });
});
