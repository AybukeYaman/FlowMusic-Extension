import { describe, expect, it } from "vitest";
import { parseBrief } from "../prompt/brief-parser";
import { LocalPromptPlanner, planAlbum } from "../prompt/local-planner";
import { normalizePrompt, normalizeTitle, validatePlan } from "../prompt/uniqueness-validator";

const LOFI =
  "Cozy lofi hip hop album for studying on rainy nights. Warm Rhodes and soft guitar, vinyl crackle, " +
  "nostalgic and calm. Instrumental only. Avoid sharp transitions, loud percussion and distracting melodies.";

describe("brief parser", () => {
  it("extracts genre, instruments, ambience, use and avoid terms", () => {
    const b = parseBrief(LOFI);
    expect(b.genres).toContain("lo-fi hip hop");
    expect(b.instruments).toContain("Rhodes electric piano");
    expect(b.ambience).toEqual(expect.arrayContaining(["soft rain", "vinyl crackle"]));
    expect(b.intendedUse).toContain("studying");
    expect(b.moods).toEqual(expect.arrayContaining(["cozy", "nostalgic", "calm"]));
    expect(b.instrumentalOnly).toBe(true);
    expect(b.avoid).toEqual(expect.arrayContaining(["sharp transitions", "loud percussion", "distracting melodies"]));
  });

  it("does not treat negated instruments as requested", () => {
    const b = parseBrief("Jazz with saxophone, no piano, without drums.");
    expect(b.instruments).toContain("saxophone");
    expect(b.instruments).not.toContain("piano");
    expect(b.avoid).toEqual(expect.arrayContaining(["piano", "drums"]));
  });

  it("detects vocals exclusion as instrumental", () => {
    expect(parseBrief("Ambient pads, no vocals").instrumentalOnly).toBe(true);
    expect(parseBrief("Ambient pads with soft singing").instrumentalOnly).toBe(false);
  });

  it("reads explicit tempo", () => {
    expect(parseBrief("lofi at 70-80 bpm").tempo).toEqual({ min: 70, max: 80, explicit: true });
  });

  it("understands common Turkish terms", () => {
    const b = parseBrief("Yağmurlu gecelerde ders çalışmak için sakin piyanolu lofi. Vokal olmasın.");
    expect(b.ambience).toContain("soft rain");
    expect(b.intendedUse).toContain("studying");
    expect(b.instruments).toContain("piano");
    expect(b.instrumentalOnly).toBe(true);
  });
});

describe("local planner", () => {
  it("creates the requested number of tracks", async () => {
    const plan = await new LocalPromptPlanner().createAlbumPlan({ description: LOFI }, 50);
    expect(plan.tracks).toHaveLength(50);
    expect(plan.tracks.map((t) => t.index)).toEqual([...Array(50).keys()]);
    expect(new Set(plan.tracks.map((t) => t.trackId)).size).toBe(50);
  });

  it("produces unique titles, prompts and arrangements", () => {
    for (const count of [1, 10, 50, 237, 500]) {
      const plan = planAlbum({ description: LOFI }, count);
      expect(new Set(plan.tracks.map((t) => normalizeTitle(t.title))).size).toBe(count);
      expect(new Set(plan.tracks.map((t) => normalizePrompt(t.prompt))).size).toBe(count);
      const report = validatePlan(plan.tracks, plan.brief);
      expect(report.duplicateArrangements).toEqual([]);
      expect(plan.warnings).toEqual([]);
    }
  });

  it("keeps album constraints in every prompt", () => {
    const plan = planAlbum({ description: LOFI }, 30);
    for (const t of plan.tracks) {
      expect(t.prompt).toMatch(/instrumental/i);
      expect(t.prompt).toMatch(/no vocals/i);
      expect(t.prompt).toContain("sharp transitions");
      expect(t.prompt).toContain("loud percussion");
      expect(t.prompt.trim().length).toBeGreaterThan(40);
    }
  });

  it("never contradicts the avoid list in variation axes", () => {
    const plan = planAlbum({ description: "Calm piano album without drums and without vinyl noise." }, 40);
    for (const t of plan.tracks) {
      const axes = Object.values(t.variationAxes).join(" ").toLowerCase();
      expect(axes).not.toMatch(/drum/);
      expect(axes).not.toMatch(/vinyl/);
    }
  });

  it("is deterministic for the same input", () => {
    const a = planAlbum({ description: LOFI }, 20, { albumId: "a" });
    const b = planAlbum({ description: LOFI }, 20, { albumId: "a" });
    expect(a.tracks).toEqual(b.tracks);
  });

  it("warns instead of duplicating when the space is too small", () => {
    const plan = planAlbum(
      { description: "Solo piano, very consistent, no drums, no reverb, no tape, no texture." },
      500,
    );
    expect(new Set(plan.tracks.map((t) => normalizeTitle(t.title))).size).toBe(500);
    // Either satisfied or honestly warned.
    const report = validatePlan(plan.tracks, plan.brief);
    if (report.duplicateArrangements.length > 0) expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("rejects invalid input", () => {
    expect(() => planAlbum({ description: "  " }, 5)).toThrow("empty_description");
    expect(() => planAlbum({ description: "x" }, 0)).toThrow("invalid_song_count");
    expect(() => planAlbum({ description: "x" }, 501)).toThrow("invalid_song_count");
  });
});
