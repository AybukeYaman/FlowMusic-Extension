import type { NormalizedAlbumBrief, TrackPlan, VariationAxes } from "../shared/types";
import { affirmativePart, exclusionWords } from "./brief-parser";
import { keyFitsHarmony, needsDrums } from "./track-composer";

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

export function arrangementKey(axes: VariationAxes): string {
  return [axes.leadInstrument, axes.rhythm, axes.harmony, axes.texture, axes.ambience, axes.energy]
    .map((v) => v ?? "")
    .join("|");
}

// Indices (after the first occurrence) whose key repeats an earlier one.
function repeats<T>(items: T[], key: (t: T) => string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) out.push(i);
    else seen.add(k);
  });
  return out;
}

export interface ValidationReport {
  duplicateTitles: number[];
  duplicatePrompts: number[];
  duplicateArrangements: number[];
  emptyPrompts: number[];
  missingConstraints: { index: number; missing: string[] }[];
  distinctArrangements: number;
}

/** Constraint phrases that every prompt must contain. */
export function requiredPhrases(brief: NormalizedAlbumBrief): string[] {
  const out: string[] = [];
  if (brief.instrumentalOnly) out.push("instrumental");
  for (const a of brief.avoid) out.push(a);
  return out;
}

export function validatePlan(tracks: TrackPlan[], brief: NormalizedAlbumBrief): ValidationReport {
  const required = requiredPhrases(brief);
  const missingConstraints: ValidationReport["missingConstraints"] = [];
  tracks.forEach((t, index) => {
    const p = t.prompt.toLowerCase();
    const missing = required.filter((r) => !p.includes(r.toLowerCase()));
    if (missing.length > 0) missingConstraints.push({ index, missing });
  });
  return {
    duplicateTitles: repeats(tracks, (t) => normalizeTitle(t.title)),
    duplicatePrompts: repeats(tracks, (t) => normalizePrompt(t.prompt)),
    duplicateArrangements: repeats(tracks, (t) => arrangementKey(t.variationAxes)),
    emptyPrompts: tracks.flatMap((t, i) => (t.prompt.trim() ? [] : [i])),
    missingConstraints,
    distinctArrangements: new Set(tracks.map((t) => arrangementKey(t.variationAxes))).size,
  };
}

const VOCAL = /(?<![\p{L}])(vocal|vocals|voice|choir|singing|sung|rap)(?![\p{L}])/iu;

/**
 * Checks every track's structured decisions against the album's hard
 * constraints. Returns problems as warnings (expected to be empty).
 */
export function validateDesigns(tracks: TrackPlan[], brief: NormalizedAlbumBrief): string[] {
  const problems: string[] = [];
  tracks.forEach((t, i) => {
    const d = t.design;
    if (!d) return;
    const decided = [
      d.subgenre, ...d.influences, d.lead, ...d.supports, d.bass, d.percussion, d.groove, d.harmony,
      d.melody, d.arrangement, d.ambience ?? "", d.production, d.space, d.dynamics, d.mood, d.context,
    ].map(affirmativePart).join(" | ");
    for (const a of brief.avoid) {
      if (exclusionWords(a).some((w) => decided.includes(w))) {
        problems.push(`Track ${i + 1} contradicts the exclusion "${a}"`);
      }
    }
    if (brief.instrumentalOnly && VOCAL.test(decided)) problems.push(`Track ${i + 1} includes a vocal element`);
    if (t.prompt.length > 3000) problems.push(`Track ${i + 1} prompt exceeds 3000 characters`);
    if (!keyFitsHarmony(d.key, d.harmony)) problems.push(`Track ${i + 1}: key "${d.key}" does not fit harmony "${d.harmony}"`);
    if (d.percussionLevel === "none") {
      if (needsDrums(d.groove)) problems.push(`Track ${i + 1}: drumless track with a drum groove`);
      if (needsDrums(d.arrangement)) problems.push(`Track ${i + 1}: drumless track with a drum arrangement`);
      const rest = [d.melody, d.production, d.space, d.dynamics, d.mood, d.ambience ?? "", ...d.supports, d.lead, d.bass];
      if (rest.some((v) => needsDrums(affirmativePart(v)))) problems.push(`Track ${i + 1}: drumless track mentions drums elsewhere`);
      if (!d.exclusions.some((x) => x.toLowerCase() === "drums")) problems.push(`Track ${i + 1}: drumless track does not exclude drums`);
    }
  });
  return problems;
}

export function isClean(r: ValidationReport): boolean {
  return (
    r.duplicateTitles.length === 0 &&
    r.duplicatePrompts.length === 0 &&
    r.duplicateArrangements.length === 0 &&
    r.emptyPrompts.length === 0 &&
    r.missingConstraints.length === 0
  );
}
