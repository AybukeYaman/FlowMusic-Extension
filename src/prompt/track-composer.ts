import type { Energy, NormalizedAlbumBrief, TrackDesign } from "../shared/types";
import { bansPercussion, capsPercussion, conflictsWithAvoid, isVocal } from "./brief-parser";
import { DEFAULT_CONTEXT, FAMILIES, USE_CONTEXT, type Family, type Level, type Leveled } from "./families";
import type { Rng } from "./rng";

// Makes every musical decision for every track of an album, deterministically.
//
// - All options come from the album's genre family (plus a few from an
//   optional second family), filtered by the user's exclusions, the
//   instrumental requirement and the album's energy. Variety therefore never
//   leaves the album's style.
// - Within those pools, each dimension is picked by least use (balanced
//   coverage), never repeating the previous track, with bonuses for the
//   user's preferred sounds.
// - A preferred instrument becomes the album's signature: lead on ~40% of
//   tracks and a supporting colour on about half of the rest, instead of the
//   lead on every track. Preferred ambience is a motif on ~50% of tracks
//   unless the user asked for it everywhere.
// - A candidate track that is too similar to an earlier one is re-picked.

const LEVEL_RANK: Record<Level, number> = { none: 0, soft: 1, medium: 2, strong: 3 };
const ENERGY_CAP: Record<Energy, number> = { low: 1, medium: 2, high: 3 };

export const CORE_DIMENSIONS = [
  "subgenre", "influences", "lead", "supports", "bass", "percussion", "groove", "key",
  "harmony", "melody", "arrangement", "ambience", "production", "space",
] as const;
export type CoreDimension = (typeof CORE_DIMENSIONS)[number];

export function coreValue(d: TrackDesign, dim: CoreDimension): string {
  switch (dim) {
    case "influences": return d.influences.join(" + ");
    case "supports": return d.supports.join(" + ");
    case "ambience": return d.ambience ?? "∅";
    default: return String(d[dim]);
  }
}

export function designDistance(a: TrackDesign, b: TrackDesign): number {
  return CORE_DIMENSIONS.filter((dim) => coreValue(a, dim) !== coreValue(b, dim)).length;
}

// ------------------------------------------------------- key / harmony fit

export type HarmonyMode = "major" | "minor" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "neutral";

// ------------------------------------------------------ drums / no drums

const DRUM_WORDS = /\b(drums?|beat|beats|kick|snare|snares|hi-?hats?|hats|cymbals?|rimshots?|boom-bap|head-nod|four-on-the-floor|backbeat|claps?|808)\b/i;

/** True when a groove/arrangement phrase only makes sense with drums. */
export function needsDrums(phrase: string): boolean {
  return DRUM_WORDS.test(phrase);
}

const DRUMLESS_GROOVE = "free, gently breathing time";
const DRUMLESS_ARRANGEMENT = "intro on the lead alone, the full texture enters midway, gentle ending on a held chord";

/** Tonal character of a harmony description (checked from most to least specific). */
export function harmonyMode(harmony: string): HarmonyMode {
  const h = harmony.toLowerCase();
  // "mixolydian" contains "lydian": test it first.
  if (/mixolydian/.test(h)) return "mixolydian";
  if (/dorian/.test(h)) return "dorian";
  if (/phrygian/.test(h)) return "phrygian";
  if (/lydian/.test(h)) return "lydian";
  // Starts in minor even if it later lifts to major.
  if (/\bminor\b/.test(h)) return "minor";
  if (/\bmajor\b|borrowed iv\b|ii–v–i|\bi and iv\b|\bi–iv–v\b/.test(h)) return "major";
  return "neutral";
}

const MODE_QUALITY: Record<HarmonyMode, "major" | "minor" | undefined> = {
  major: "major", lydian: "major", mixolydian: "major",
  minor: "minor", dorian: "minor", phrygian: "minor",
  neutral: undefined,
};

export function keyQuality(key: string): "major" | "minor" | undefined {
  return /\bmajor$/i.test(key) ? "major" : /\bminor$/i.test(key) ? "minor" : undefined;
}

export function keyTonic(key: string): string {
  return key.replace(/\s+(major|minor|dorian|phrygian|lydian|mixolydian)$/i, "");
}

/** True when the stated key agrees with the harmony's tonal character. */
export function keyFitsHarmony(key: string, harmony: string): boolean {
  const mode = harmonyMode(harmony);
  if (mode === "neutral") return true;
  if (mode === "major" || mode === "minor") return keyQuality(key) === mode;
  return key.toLowerCase().endsWith(` ${mode}`);
}

/** Lowercase identifying word(s) used to match preferences against pool entries. */
function prefKey(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("rhodes")) return "rhodes";
  if (n.includes("wurlitzer")) return "wurlitzer";
  if (n.includes("felt piano")) return "felt piano";
  if (n.includes("nylon")) return "nylon";
  if (n.includes("upright bass")) return "upright bass";
  if (n.includes("synth")) return "synth";
  return n.replace(/^(soft|warm|clean|muted|analog)\s+/, "");
}

export function mentions(value: string, preference: string): boolean {
  return value.toLowerCase().includes(prefKey(preference));
}

/** Spread `count` marks evenly over `n` positions (deterministic). */
export function spreadIndices(n: number, count: number): Set<number> {
  const out = new Set<number>();
  if (count <= 0 || n <= 0) return out;
  for (let k = 0; k < Math.min(count, n); k++) out.add(Math.min(n - 1, Math.floor(((k + 0.5) * n) / count)));
  return out;
}

interface Pools {
  subgenres: string[];
  influences: string[];
  leads: string[];
  supports: string[];
  bass: string[];
  percussion: Leveled[];
  grooves: Leveled[];
  keys: string[];
  harmony: string[];
  melody: string[];
  arrangement: string[];
  ambience: string[];
  production: string[];
  space: string[];
  dynamics: string[];
  moodShades: string[];
  contexts: string[];
}

export class TrackComposer {
  readonly family: Family;
  readonly secondary?: Family;
  readonly pools: Pools;
  readonly signature?: string;
  readonly warnings: string[] = [];
  private readonly usage = new Map<string, Map<string, number>>();
  private readonly designs: TrackDesign[] = [];
  private readonly leadSignatureTracks: Set<number>;
  private readonly ambienceMotifTracks: Set<number>;
  private readonly bpmSlots: number[];

  constructor(private readonly brief: NormalizedAlbumBrief, private readonly rng: Rng, private readonly n: number) {
    this.family = FAMILIES[brief.family] ?? FAMILIES.lofi!;
    this.secondary = brief.secondaryFamily ? FAMILIES[brief.secondaryFamily] : undefined;
    this.pools = this.buildPools();
    // The signature is the first preferred melodic instrument (bass
    // preferences only weight the bass part).
    this.signature = [...brief.requiredInstruments, ...brief.instruments].find((i) => !/bass/i.test(i));
    this.leadSignatureTracks = this.signature ? spreadIndices(n, Math.max(1, Math.round(n * 0.4))) : new Set();
    const motifs = brief.ambience.filter((a) => !brief.requiredAmbience.includes(a));
    this.ambienceMotifTracks = motifs.length > 0 ? spreadIndices(n, Math.max(1, Math.round(n * 0.5))) : new Set();

    // BPM: evenly spaced over the album's range, shuffled so tempo is not a
    // function of track order.
    const { min, max } = brief.tempo;
    const slots = Array.from({ length: n }, (_, i) => (n === 1 ? Math.round((min + max) / 2) : Math.round(min + ((max - min) * i) / (n - 1))));
    this.bpmSlots = rng.shuffle(slots);
  }

  // ----------------------------------------------------------------- pools

  private allowed(v: string): boolean {
    if (conflictsWithAvoid(v, this.brief)) return false;
    if (this.brief.instrumentalOnly && isVocal(v)) return false;
    return true;
  }

  private merge(primary: string[], secondary: string[] | undefined, extra: string[] = []): string[] {
    return [...new Set([...primary, ...(secondary ?? []).slice(0, 2), ...extra])].filter((v) => this.allowed(v));
  }

  private buildPools(): Pools {
    const f = this.family;
    const s = this.secondary;
    const b = this.brief;
    const prefInstruments = [...b.requiredInstruments, ...b.instruments];
    const missingFromLeads = prefInstruments.filter((p) => !f.leads.some((l) => mentions(l, p)) && !/bass/i.test(p));
    const missingBass = prefInstruments.filter((p) => /bass/i.test(p) && !f.bass.some((x) => mentions(x, p)));

    const levelCap = bansPercussion(b) ? 0 : Math.min(ENERGY_CAP[b.energy], capsPercussion(b) ? 1 : 3);
    const byLevel = (items: Leveled[]) => items.filter((x) => LEVEL_RANK[x.level] <= levelCap && this.allowed(x.text));
    let percussion = byLevel(f.percussion);
    if (!percussion.some((p) => p.level === "none") && levelCap === 0) percussion = [{ text: "no percussion", level: "none" }];
    if (percussion.length === 0) percussion = [{ text: "no percussion", level: "none" }];
    let grooves = byLevel(f.grooves);
    if (grooves.length === 0) grooves = [{ text: "free, gently breathing time", level: "none" }];

    const contexts = b.intendedUse.flatMap((u) => USE_CONTEXT[u] ?? []);

    const pools: Pools = {
      subgenres: this.merge(f.subgenres, s?.subgenres),
      influences: this.merge(f.influences, s?.influences),
      leads: this.merge(f.leads, s?.leads, missingFromLeads),
      supports: this.merge(f.supports, s?.supports, missingFromLeads),
      bass: this.merge(f.bass, undefined, missingBass.map((x) => `${x} with a soft, rounded tone`)),
      percussion,
      grooves,
      keys: this.merge(f.keys, undefined),
      harmony: this.merge(f.harmony, s?.harmony),
      melody: this.merge(f.melody, undefined),
      arrangement: this.merge(f.arrangement, undefined),
      ambience: this.merge(f.ambience, s?.ambience, b.ambience),
      production: this.merge(f.production, undefined, b.textures),
      space: this.merge(f.space, undefined),
      dynamics: this.merge(f.dynamics[b.energy], undefined),
      moodShades: this.merge(f.moodShades[b.energy], undefined),
      contexts: (contexts.length > 0 ? contexts : DEFAULT_CONTEXT).filter((v) => this.allowed(v)),
    };
    for (const [name, pool] of Object.entries(pools)) {
      if ((pool as unknown[]).length === 0) {
        this.warnings.push(`Exclusions leave no options for ${name}; using a neutral description.`);
      }
    }
    return pools;
  }

  // --------------------------------------------------------------- picking

  private count(dim: string, value: string): number {
    return this.usage.get(dim)?.get(value) ?? 0;
  }

  private pick(
    dim: string, pool: string[],
    opts: { bonus?: (v: string) => number; forbid?: Set<string>; exclude?: (v: string) => boolean } = {},
  ): string | undefined {
    const prev = this.designs.length > 0 ? this.prevValue(dim) : undefined;
    let best: string | undefined;
    let bestScore = Infinity;
    for (const v of pool) {
      if (opts.exclude?.(v)) continue;
      const score = this.count(dim, v)
        + (v === prev ? 3 : 0)
        + (opts.forbid?.has(v) ? 50 : 0)
        - (opts.bonus?.(v) ?? 0)
        + this.rng.next() * 0.9;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private prevValue(dim: string): string | undefined {
    const d = this.designs[this.designs.length - 1]!;
    const map: Record<string, string | undefined> = {
      subgenre: d.subgenre, influence: d.influences[0], lead: d.lead, support: d.supports[0], bass: d.bass,
      percussion: d.percussion, groove: d.groove, key: d.key, harmony: d.harmony, melody: d.melody,
      arrangement: d.arrangement, ambience: d.ambience ?? "∅", production: d.production, space: d.space,
      dynamics: d.dynamics, mood: d.mood, context: d.context,
    };
    return map[dim];
  }

  /** Preferred sounds other than the signature get picked more often (never forced). */
  private preferenceBonus(v: string): number {
    return this.brief.instruments.some((p) => p !== this.signature && mentions(v, p)) ? 1.5 : 0;
  }

  // ------------------------------------------------------------- composing

  compose(index: number): TrackDesign {
    let best: TrackDesign | undefined;
    let bestScore = -Infinity;
    let forbid = new Map<string, Set<string>>();
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = this.candidate(index, forbid);
      const { ok, score, closest, tripleTwin } = this.assess(d);
      if (ok) {
        best = d;
        break;
      }
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
      // Re-pick the dimensions shared with the most similar earlier track.
      forbid = new Map();
      const block = (dim: string, v: string) => forbid.set(dim, new Set([...(forbid.get(dim) ?? []), v]));
      if (closest) {
        for (const dim of ["lead", "percussion", "groove", "harmony", "melody", "arrangement", "production", "bass", "key", "space"]) {
          block(dim, this.valueOf(closest, dim));
        }
      }
      // A repeated lead/groove/harmony combination: block that exact combination.
      if (tripleTwin) {
        block("lead", tripleTwin.lead);
        block("groove", tripleTwin.groove);
        block("harmony", tripleTwin.harmony);
      }
    }
    this.commit(best!);
    return best!;
  }

  private valueOf(d: TrackDesign, dim: string): string {
    return dim === "influences" ? d.influences[0]! : dim === "supports" ? d.supports[0] ?? "" : String((d as unknown as Record<string, unknown>)[dim]);
  }

  /** Rules: ≥4 differing core dimensions from every track, ≥5 from the previous one, unique lead/groove/harmony. */
  private assess(d: TrackDesign): { ok: boolean; score: number; closest?: TrackDesign; tripleTwin?: TrackDesign } {
    let min = Infinity;
    let closest: TrackDesign | undefined;
    for (const other of this.designs) {
      const dist = designDistance(d, other);
      if (dist < min) {
        min = dist;
        closest = other;
      }
    }
    const prev = this.designs[this.designs.length - 1];
    const adjacentOk = !prev || designDistance(d, prev) >= 5;
    const triple = (x: TrackDesign) => `${x.lead}|${x.groove}|${x.harmony}`;
    const tripleSpace = this.pools.leads.length * this.pools.grooves.length * this.pools.harmony.length;
    const tripleTwin = this.designs.length >= tripleSpace ? undefined : this.designs.find((o) => triple(o) === triple(d));
    const tripleOk = !tripleTwin;
    const ok = (this.designs.length === 0 || min >= 4) && adjacentOk && tripleOk;
    // Triple uniqueness weighs most: a repeated combination is the clearest "same track" signal.
    return { ok, score: (Number.isFinite(min) ? min : 99) + (adjacentOk ? 1 : 0) + (tripleOk ? 10 : 0), closest, tripleTwin };
  }

  private candidate(index: number, forbid: Map<string, Set<string>>): TrackDesign {
    const p = this.pools;
    const b = this.brief;
    const sig = this.signature;
    const f = (dim: string) => ({ forbid: forbid.get(dim) });

    // Lead: the signature on its scheduled tracks; otherwise the rest of the
    // palette. If every lead *is* the signature (a piano album), rotate them.
    const sigLeads = sig ? p.leads.filter((l) => mentions(l, sig)) : [];
    const otherLeads = p.leads.filter((l) => !sigLeads.includes(l));
    const leadIsSignature = sigLeads.length > 0 && this.leadSignatureTracks.has(index);
    const lead = (leadIsSignature
      ? this.pick("lead", sigLeads, f("lead"))
      : this.pick("lead", otherLeads.length > 0 ? otherLeads : p.leads, { ...f("lead"), bonus: (v) => this.preferenceBonus(v) }))
      ?? "melodic lead instrument";

    // Supports: 1–2 colours; the signature appears as a support on about half
    // of the tracks it does not lead (always, when it is required).
    const sameAsLead = (v: string) => mentions(v, lead) || mentions(lead, v);
    const supports: string[] = [];
    const sigRequired = !!sig && b.requiredInstruments.includes(sig);
    if (sig && !mentions(lead, sig) && (sigRequired || index % 2 === 1)) {
      const s = p.supports.find((v) => mentions(v, sig)) ?? sig;
      if (!sameAsLead(s)) supports.push(s);
    }
    const supportCount = this.rng.next() < 0.55 ? 2 : 1;
    while (supports.length < supportCount) {
      const s = this.pick("support", p.supports, {
        bonus: (v) => this.preferenceBonus(v),
        exclude: (v) => sameAsLead(v) || supports.includes(v) || (!!sig && mentions(v, sig) && supports.some((x) => mentions(x, sig))),
      });
      if (!s) break;
      supports.push(s);
    }

    const perc = this.pickLeveled("percussion", p.percussion, forbid.get("percussion"));
    // A drumless track gets only grooves and arrangements that need no drums.
    const drumless = perc.level === "none";
    const grooves = drumless
      ? p.grooves.filter((g) => LEVEL_RANK[g.level] <= 1 && !needsDrums(g.text))
      : p.grooves;
    const groove = grooves.length > 0
      ? this.pickLeveled("groove", grooves, forbid.get("groove"))
      : { text: DRUMLESS_GROOVE, level: "none" as const };
    const arrangements = drumless ? p.arrangement.filter((a) => !needsDrums(a)) : p.arrangement;
    // Every other dimension of a drumless track must not mention drums either.
    const noDrumText = (v: string) => drumless && needsDrums(v);
    const arrangement = arrangements.length > 0
      ? this.pick("arrangement", arrangements, f("arrangement")) ?? DRUMLESS_ARRANGEMENT
      : DRUMLESS_ARRANGEMENT;

    const ambience = this.pickAmbience(index);
    const influenceCount = this.rng.next() < 0.4 && p.influences.length > 1 ? 2 : 1;
    const influences: string[] = [];
    for (let k = 0; k < influenceCount; k++) {
      const v = this.pick("influence", p.influences, { exclude: (x) => influences.includes(x) });
      if (v) influences.push(v);
    }

    const percussionText = perc.text;
    // Choose the harmony so lead + groove + harmony is a combination the album
    // has not used yet, whenever the palette still has one.
    const used = new Set(this.designs.map((o) => `${o.lead}|${o.groove}|${o.harmony}`));
    const fresh = p.harmony.filter((h) => !used.has(`${lead}|${groove.text}|${h}`));
    const harmony = this.pick("harmony", fresh.length > 0 ? fresh : p.harmony, f("harmony")) ?? "simple diatonic harmony";
    // The key follows the harmony's tonal character (never "F major" with
    // "Dorian minor"); modal harmony states its mode, e.g. "D Dorian".
    const key = this.pickKeyFor(harmony, f("key").forbid);
    const design: TrackDesign = {
      family: this.family.label,
      subgenre: this.pick("subgenre", p.subgenres) ?? this.family.label,
      influences,
      lead,
      supports,
      bass: this.pick("bass", p.bass, { ...f("bass"), bonus: (v) => this.preferenceBonus(v) }) ?? "soft, rounded bass",
      percussion: percussionText,
      percussionLevel: perc.level,
      groove: groove.text,
      bpm: this.bpmSlots[index] ?? b.tempo.min,
      key,
      harmony,
      melody: this.pick("melody", p.melody, { ...f("melody"), exclude: noDrumText }) ?? "a simple, gentle melody",
      arrangement,
      ambience,
      production: this.pick("production", p.production, { ...f("production"), exclude: noDrumText }) ?? "clean, warm mix",
      space: this.pick("space", p.space, { ...f("space"), exclude: noDrumText }) ?? "natural room reverb",
      dynamics: this.pick("dynamics", p.dynamics, { exclude: noDrumText }) ?? "even dynamics",
      mood: this.pick("mood", p.moodShades, { exclude: noDrumText }) ?? "calm",
      context: this.pick("context", p.contexts) ?? "for relaxed listening",
      exclusions: [],
    };
    design.exclusions = this.exclusionsFor(design);
    if (sig && (mentions(lead, sig) || supports.some((s) => mentions(s, sig)))) design.signature = sig;
    return design;
  }

  private pickKeyFor(harmony: string, forbid?: Set<string>): string {
    const mode = harmonyMode(harmony);
    const want = MODE_QUALITY[mode];
    const compatible = want ? this.pools.keys.filter((k) => keyQuality(k) === want) : this.pools.keys;
    const pool = compatible.length > 0 ? compatible : this.pools.keys;
    const base = this.pick("key", pool, { forbid }) ?? (want === "minor" ? "A minor" : "C major");
    // Modal harmony: name the mode on that key's tonic ("D minor" -> "D Dorian").
    return mode === "dorian" || mode === "phrygian" || mode === "lydian" || mode === "mixolydian"
      ? `${keyTonic(base)} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
      : base;
  }

  private pickLeveled(dim: string, pool: Leveled[], forbid?: Set<string>): Leveled {
    const text = this.pick(dim, pool.map((x) => x.text), { forbid });
    return pool.find((x) => x.text === text) ?? pool[0]!;
  }

  private pickAmbience(index: number): string | null {
    const b = this.brief;
    if (b.requiredAmbience.length > 0) return b.requiredAmbience.join(" and ");
    const motifs = b.ambience;
    if (motifs.length > 0 && this.ambienceMotifTracks.has(index)) {
      // Rotate between the user's ambience motifs.
      const order = [...this.ambienceMotifTracks].sort((x, y) => x - y).indexOf(index);
      return motifs[order % motifs.length]!;
    }
    // Other tracks: the family's other ambiences or none at all, never the
    // user's motif (so it stays a motif rather than a constant).
    const pool = [...this.pools.ambience.filter((a) => !motifs.includes(a)), "∅"];
    const v = this.pick("ambience", pool);
    return !v || v === "∅" ? null : v;
  }

  private exclusionsFor(d: TrackDesign): string[] {
    const b = this.brief;
    const out: string[] = [...b.avoid];
    const has = (re: RegExp) => out.some((x) => re.test(x));
    if (b.instrumentalOnly && !has(/vocal|sing|lyric|voice|vokal|söz/i)) out.push("vocals");
    // A drumless track always says so, even when e.g. "loud percussion" is
    // already excluded (that alone would still allow soft drums).
    if (d.percussionLevel === "none" && !out.some((x) => x.toLowerCase() === "drums")) out.push("drums");
    if (b.energy === "low" && !has(/sudden|abrupt|transition/i)) out.push("abrupt volume jumps");
    return out;
  }

  private commit(d: TrackDesign): void {
    const bump = (dim: string, v: string | undefined) => {
      if (v === undefined) return;
      const m = this.usage.get(dim) ?? new Map<string, number>();
      m.set(v, (m.get(v) ?? 0) + 1);
      this.usage.set(dim, m);
    };
    bump("subgenre", d.subgenre);
    d.influences.forEach((x) => bump("influence", x));
    bump("lead", d.lead);
    d.supports.forEach((x) => bump("support", x));
    bump("bass", d.bass);
    bump("percussion", d.percussion);
    bump("groove", d.groove);
    bump("key", d.key);
    bump("harmony", d.harmony);
    bump("melody", d.melody);
    bump("arrangement", d.arrangement);
    bump("ambience", d.ambience ?? "∅");
    bump("production", d.production);
    bump("space", d.space);
    bump("dynamics", d.dynamics);
    bump("mood", d.mood);
    bump("context", d.context);
    this.designs.push(d);
  }
}
