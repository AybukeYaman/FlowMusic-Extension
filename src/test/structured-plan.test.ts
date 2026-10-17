import { describe, expect, it } from "vitest";
import { affirmativePart, parseBrief } from "../prompt/brief-parser";
import { planAlbum } from "../prompt/local-planner";
import { createRng } from "../prompt/rng";
import { CORE_DIMENSIONS, TrackComposer, coreValue, designDistance, harmonyMode, keyFitsHarmony, needsDrums } from "../prompt/track-composer";
import type { AlbumPlan, TrackDesign } from "../shared/types";

// Structured-plan tests: they judge the musical decisions (TrackDesign), not
// just whether prompt strings differ.

const BRIEFS = {
  short: "Cozy background music for studying on rainy evenings.",
  detailed: "Calm lo-fi hip hop for late-night studying. Warm Rhodes, soft rain, vinyl crackle. Instrumental only. Avoid loud percussion.",
  turkish: "Yağmurlu akşamlarda ders çalışmak için sakin, sıcak bir albüm. Vokal olmasın.",
  instrumental: "Dreamy café jazz for reading. Instrumental only.",
  restrictive: "Relaxing piano album for sleep. No drums, no strings, no rain, no reverb. Instrumental.",
  meditation: "Music for meditation and sleep.",
  cinematic: "Epic orchestral music for a fantasy adventure game.",
  conflict: "Energetic upbeat sleep music with vocals. Instrumental only. Warm Rhodes but no Rhodes.",
  rainEverywhere: "Lo-fi study beats with soft rain in every track.",
} as const;

const plan = (d: string, n: number) => planAlbum({ description: d }, n, { albumId: "alb" });
const designs = (p: AlbumPlan) => p.tracks.map((t) => t.design);
const pools = (d: string, n: number) => new TrackComposer(parseBrief(d), createRng(1), n).pools;
const share = (ds: TrackDesign[], f: (d: TrackDesign) => boolean) => ds.filter(f).length / ds.length;

/** Everything a track decided, minus negated clauses ("no drums"). */
function affirmed(d: TrackDesign): string {
  return [d.subgenre, ...d.influences, d.lead, ...d.supports, d.bass, d.percussion, d.groove, d.harmony,
    d.melody, d.arrangement, d.ambience ?? "", d.production, d.space, d.dynamics, d.mood, d.context]
    .map(affirmativePart).join(" | ");
}

function spearman(xs: number[]): number {
  const n = xs.length;
  const rank = (arr: number[]) => {
    const order = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const d2 = rx.reduce((s, r, i) => s + (r - i) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

describe("completeness: every track decides every dimension", () => {
  for (const [name, d] of Object.entries(BRIEFS)) {
    for (const n of [1, 5, 50]) {
      it(`${name}, ${n} track(s)`, () => {
        const p = plan(d, n);
        expect(p.tracks).toHaveLength(n);
        for (const t of p.tracks) {
          const x = t.design;
          for (const v of [x.family, x.subgenre, x.lead, x.bass, x.percussion, x.groove, x.key, x.harmony,
            x.melody, x.arrangement, x.production, x.space, x.dynamics, x.mood, x.context]) {
            expect(v.trim().length).toBeGreaterThan(0);
            expect(v).not.toMatch(/melodic lead instrument|neutral/); // no fallback placeholders
          }
          expect(x.influences.length).toBeGreaterThan(0);
          expect(x.bpm).toBeGreaterThanOrEqual(p.brief.tempo.min);
          expect(x.bpm).toBeLessThanOrEqual(p.brief.tempo.max);
          // The prompt states each decision.
          for (const v of [x.lead, x.bass, x.percussion, x.groove, x.harmony, x.melody, x.arrangement,
            x.production, x.space, x.dynamics, x.mood, x.key, `${x.bpm} BPM`, ...x.influences, ...x.supports]) {
            expect(t.prompt).toContain(v);
          }
          if (x.ambience) expect(t.prompt).toContain(x.ambience);
          expect(t.prompt.length).toBeLessThanOrEqual(3000);
        }
      });
    }
  }
});

describe("variety: meaningful differences, scaled to album size", () => {
  const DIMS = ["subgenre", "bass", "percussion", "groove", "key", "harmony", "melody", "arrangement", "production", "space"] as const;
  const poolOf: Record<(typeof DIMS)[number], (p: ReturnType<typeof pools>) => number> = {
    subgenre: (p) => p.subgenres.length, bass: (p) => p.bass.length, percussion: (p) => p.percussion.length,
    // Keys follow the harmony's major/minor character, so a track chooses
    // from one half of the key list.
    groove: (p) => p.grooves.length, key: (p) => Math.floor(p.keys.length / 2), harmony: (p) => p.harmony.length,
    melody: (p) => p.melody.length, arrangement: (p) => p.arrangement.length,
    production: (p) => p.production.length, space: (p) => p.space.length,
  };

  for (const name of ["short", "detailed", "turkish", "instrumental", "restrictive", "cinematic"] as const) {
    for (const n of [3, 12, 50]) {
      it(`${name}, ${n} tracks`, () => {
        const d = BRIEFS[name];
        const ds = designs(plan(d, n));
        const pl = pools(d, n);
        for (const dim of DIMS) {
          const values = ds.map((x) => coreValue(x, dim));
          const size = poolOf[dim](pl);
          // Balanced use of the album's palette: every option once before repeats…
          expect(new Set(values).size, dim).toBeGreaterThanOrEqual(Math.min(size, n));
          // …and no option dominates.
          const top = Math.max(...[...new Set(values)].map((v) => values.filter((x) => x === v).length));
          // (Small slack: distance retries can nudge a 2-option split to e.g. 27/23.)
          expect(top, dim).toBeLessThanOrEqual(Math.ceil(n / Math.min(size, n)) + Math.max(1, Math.ceil(n * 0.05)));
        }
        // Tracks differ in several core dimensions, neighbours even more.
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            expect(designDistance(ds[i]!, ds[j]!), `${i}/${j}`).toBeGreaterThanOrEqual(4);
          }
          if (i > 0) expect(designDistance(ds[i - 1]!, ds[i]!)).toBeGreaterThanOrEqual(5);
        }
        // No two tracks share lead + groove + harmony while the palette allows it.
        const space = pl.leads.length * pl.grooves.length * pl.harmony.length;
        const triples = ds.map((x) => `${x.lead}|${x.groove}|${x.harmony}`);
        if (n <= space) expect(new Set(triples).size).toBe(n);
      });
    }
  }

  it("spreads BPM across the album range independently of track order", () => {
    const p = plan(BRIEFS.short, 50);
    const bpms = designs(p).map((x) => x.bpm);
    const span = p.brief.tempo.max - p.brief.tempo.min;
    expect(new Set(bpms).size).toBeGreaterThanOrEqual(Math.min(span + 1, Math.ceil(50 / 3)));
    expect(Math.min(...bpms)).toBe(p.brief.tempo.min);
    expect(Math.max(...bpms)).toBe(p.brief.tempo.max);
    expect(Math.abs(spearman(bpms))).toBeLessThan(0.5);
  });

  it("does not repeat filler sentences across the album", () => {
    const p = plan(BRIEFS.detailed, 50);
    const counts = new Map<string, number>();
    for (const t of p.tracks) {
      for (const s of t.prompt.split(/(?<=\.)\s+/)) {
        if (/^(Instrumental only|Exclude:)/.test(s)) continue; // constraints repeat on purpose
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.ceil(50 * 0.4));
  });
});

describe("coherence: one album, one style", () => {
  for (const name of ["short", "detailed", "restrictive", "cinematic", "meditation"] as const) {
    it(`${name}: every decision comes from the album's palette`, () => {
      const d = BRIEFS[name];
      const pl = pools(d, 50);
      for (const x of designs(plan(d, 50))) {
        expect(pl.subgenres).toContain(x.subgenre);
        expect(pl.leads).toContain(x.lead);
        expect(pl.bass).toContain(x.bass);
        expect(pl.percussion.map((q) => q.text)).toContain(x.percussion);
        expect(pl.grooves.map((q) => q.text)).toContain(x.groove);
        expect(pl.harmony).toContain(x.harmony);
        expect(pl.production).toContain(x.production);
        for (const i of x.influences) expect(pl.influences).toContain(i);
      }
    });
  }

  it("infers a style from a short brief without genre words", () => {
    expect(plan(BRIEFS.short, 3).brief.family).toBe("lofi");
    expect(plan(BRIEFS.meditation, 3).brief.family).toBe("ambient");
    expect(plan(BRIEFS.restrictive, 3).brief.family).toBe("piano");
    expect(plan(BRIEFS.cinematic, 3).brief.family).toBe("cinematic");
    expect(plan(BRIEFS.short, 3).notes.join(" ")).toMatch(/inferred/);
  });

  it("infers low energy for cozy study background music", () => {
    expect(parseBrief(BRIEFS.short).energy).toBe("low");
    expect(parseBrief(BRIEFS.turkish).energy).toBe("low");
    expect(parseBrief("Upbeat summer chillhop for a road trip.").energy).toBe("high");
    expect(parseBrief("Upbeat summer chillhop for a road trip.").conflicts).toEqual([]);
  });

  it("low-energy albums never get strong percussion", () => {
    for (const name of ["short", "detailed", "meditation"] as const) {
      expect(designs(plan(BRIEFS[name], 50)).every((x) => x.percussionLevel === "none" || x.percussionLevel === "soft")).toBe(true);
    }
  });
});

describe("preferences are motifs, not locks", () => {
  it("a preferred instrument becomes a recurring signature, not every lead", () => {
    const ds = designs(plan(BRIEFS.detailed, 50));
    const rhodes = (s: string) => /rhodes/i.test(s);
    expect(share(ds, (x) => rhodes(x.lead) || x.supports.some(rhodes))).toBeGreaterThanOrEqual(0.5);
    expect(share(ds, (x) => rhodes(x.lead))).toBeLessThanOrEqual(0.6);
    expect(new Set(ds.filter((x) => !rhodes(x.lead)).map((x) => x.lead)).size).toBeGreaterThanOrEqual(3);
  });

  it("a one-track album still carries the preferred sound", () => {
    const [x] = designs(plan(BRIEFS.detailed, 1));
    expect(/rhodes/i.test([x!.lead, ...x!.supports].join(" "))).toBe(true);
  });

  it("preferred ambience is a weighted motif", () => {
    const ds = designs(plan(BRIEFS.short, 50));
    const rain = share(ds, (x) => /rain/i.test(x.ambience ?? ""));
    expect(rain).toBeGreaterThanOrEqual(0.25);
    expect(rain).toBeLessThanOrEqual(0.7);
    expect(new Set(ds.map((x) => x.ambience ?? "none")).size).toBeGreaterThanOrEqual(3);
  });

  it("ambience required in every track is applied to every track", () => {
    const ds = designs(plan(BRIEFS.rainEverywhere, 20));
    expect(ds.every((x) => /rain/i.test(x.ambience ?? ""))).toBe(true);
  });
});

describe("hard constraints are never contradicted", () => {
  it("restrictive brief: no drums, strings, rain or reverb anywhere", () => {
    const p = plan(BRIEFS.restrictive, 50);
    for (const t of p.tracks) {
      const a = affirmed(t.design);
      expect(a).not.toMatch(/drum|percussion|kick|snare|cymbal|timpani|shaker/);
      expect(a).not.toMatch(/string|violin|viola|cello|bowed|orchestra/);
      expect(a).not.toMatch(/rain/);
      expect(a).not.toMatch(/reverb|hall|plate/);
      expect(t.design.percussionLevel).toBe("none");
      for (const term of ["drums", "strings", "rain", "reverb"]) expect(t.prompt).toContain(term);
    }
    expect(p.warnings).toEqual([]);
  });

  it("instrumental-only albums contain no vocal elements and say so", () => {
    for (const name of ["detailed", "turkish", "instrumental", "restrictive", "conflict"] as const) {
      const p = plan(BRIEFS[name], 30);
      expect(p.brief.instrumentalOnly, name).toBe(true);
      for (const t of p.tracks) {
        expect(affirmed(t.design)).not.toMatch(/vocal|voice|choir|singing/);
        expect(t.prompt).toMatch(/no vocals/i);
      }
    }
  });

  it("every user exclusion is restated in every prompt", () => {
    const p = plan(BRIEFS.detailed, 50);
    for (const t of p.tracks) expect(t.prompt).toContain("loud percussion");
  });

  it("the album description is a brief, not text pasted into every prompt", () => {
    for (const name of ["short", "detailed"] as const) {
      const concept = parseBrief(BRIEFS[name]).concept;
      for (const t of plan(BRIEFS[name], 20).tracks) expect(t.prompt).not.toContain(concept);
    }
  });
});

describe("conflicting requirements are resolved conservatively and reported", () => {
  it("energetic + sleep, vocals + instrumental, Rhodes + no Rhodes", () => {
    const p = plan(BRIEFS.conflict, 30);
    expect(p.brief.energy).toBe("low");
    expect(p.brief.instrumentalOnly).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/sleep/);
    expect(p.warnings.join(" ")).toMatch(/instrumental/i);
    expect(p.warnings.join(" ")).toMatch(/Rhodes/);
    for (const x of designs(p)) expect(affirmed(x)).not.toMatch(/rhodes/);
  });

  it("well-formed briefs produce no warnings", () => {
    for (const name of ["short", "detailed", "turkish", "instrumental", "restrictive", "meditation", "rainEverywhere"] as const) {
      expect(plan(BRIEFS[name], 50).warnings, name).toEqual([]);
    }
  });
});

describe("short input gives production-ready prompts", () => {
  it.each(["short", "detailed", "turkish", "instrumental"] as const)("%s: 600–1100 characters", (name) => {
    for (const t of plan(BRIEFS[name], 50).tracks) {
      expect(t.prompt.length).toBeGreaterThanOrEqual(600);
      expect(t.prompt.length).toBeLessThanOrEqual(1100);
    }
  });

  it("is deterministic for the same brief and size", () => {
    expect(plan(BRIEFS.short, 20).tracks).toEqual(plan(BRIEFS.short, 20).tracks);
  });

  it("covers every core dimension in the distance measure", () => {
    expect(CORE_DIMENSIONS.length).toBeGreaterThanOrEqual(12);
  });
});

describe("key and harmony agree", () => {
  it.each([
    ["Dorian minor with suspended voicings", "dorian"],
    ["modal folk progression in Mixolydian", "mixolydian"],
    ["a Lydian drone with gentle colour changes", "lydian"],
    ["modal mixture with a Phrygian edge", "phrygian"],
    ["minor-ninth vamp over a two-chord loop", "minor"],
    ["minor ii–V turns into a bright major chorus", "minor"],
    ["warm major-seventh chords with added ninths", "major"],
    ["a borrowed iv chord for a bittersweet turn", "major"],
    ["a two-chord sway between I and IV", "major"],
    ["descending bass line under add9 chords", "neutral"],
    ["slowly shifting suspended chords", "neutral"],
  ])("%s -> %s", (harmony, mode) => {
    expect(harmonyMode(harmony)).toBe(mode);
  });

  it("every track's key fits its harmony, in every family", () => {
    for (const d of Object.values(BRIEFS)) {
      for (const x of designs(plan(d, 50))) {
        expect(keyFitsHarmony(x.key, x.harmony), `${x.key} / ${x.harmony}`).toBe(true);
      }
    }
  });

  it("modal harmony names its mode in the key, e.g. 'D Dorian'", () => {
    const dorian = designs(plan(BRIEFS.detailed, 50)).filter((x) => harmonyMode(x.harmony) === "dorian");
    expect(dorian.length).toBeGreaterThan(0);
    for (const x of dorian) expect(x.key).toMatch(/^[A-G](-flat|-sharp)? Dorian$/);
  });

  it("rejects the reported F major + Dorian minor combination", () => {
    expect(keyFitsHarmony("F major", "Dorian minor with suspended voicings")).toBe(false);
    expect(keyFitsHarmony("D Dorian", "Dorian minor with suspended voicings")).toBe(true);
  });
});

describe("drumless tracks are consistent", () => {
  it.each([
    ["dusty boom-bap kit with a soft kick", true],
    ["half-time head-nod feel", true],
    ["cold start on the full beat, tape-stop ending", true],
    ["intro on keys alone, drums enter at bar 9", true],
    ["relaxed pocket with a light 55% swing", false],
    ["starts on the main loop, adds a counter-melody in the second half", false],
  ])("needsDrums(%s) = %s", (phrase, expected) => {
    expect(needsDrums(phrase)).toBe(expected);
  });

  it("no drumless track has a drum groove or arrangement, and each excludes drums", () => {
    let drumless = 0;
    for (const d of Object.values(BRIEFS)) {
      for (const x of designs(plan(d, 50))) {
        if (x.percussionLevel !== "none") continue;
        drumless++;
        expect(needsDrums(x.groove), x.groove).toBe(false);
        expect(needsDrums(x.arrangement), x.arrangement).toBe(false);
        for (const v of [x.melody, x.production, x.space, x.dynamics, x.mood, x.lead, x.bass, ...x.supports]) {
          expect(needsDrums(affirmativePart(v)), v).toBe(false);
        }
        expect(x.exclusions).toContain("drums");
      }
    }
    expect(drumless).toBeGreaterThan(50);
  });

  it("regression: E0 'Second take' brief (drumless + 'loud percussion' excluded)", () => {
    const d = `${BRIEFS.detailed} Second take.`;
    // Exactly as the extension calls it (no fixed album id).
    const live = planAlbum({ description: d }, 1);
    const [x] = designs(live);
    expect(x!.percussionLevel).toBe("none");
    expect(needsDrums(x!.groove)).toBe(false);
    expect(needsDrums(x!.arrangement)).toBe(false);
    expect(needsDrums(x!.production)).toBe(false);
    expect(x!.exclusions).toEqual(expect.arrayContaining(["loud percussion", "drums"]));
    expect(live.warnings).toEqual([]);
  });
});
