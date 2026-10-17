import type { NormalizedAlbumBrief, TrackDesign } from "../shared/types";

// Writes the Flow "Sound description" from a track's structured design. One
// sentence per dimension, in a fixed order, so every prompt is complete and
// easy to audit. The album description itself is never pasted in; its
// constraints arrive through the design (exclusions, instrumental, moods).

export const FLOW_SOUND_LIMIT = 3000;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function writePrompt(d: TrackDesign, brief: NormalizedAlbumBrief): string {
  const albumMoods = brief.moods.filter((m) => !d.mood.includes(m)).slice(0, 3);
  const parts = [
    `${cap(d.subgenre)}${brief.instrumentalOnly ? " instrumental" : ""} in ${d.key} at ${d.bpm} BPM`,
    `Influences: ${list(d.influences)}`,
    `Lead: ${d.lead}${d.supports.length ? `, supported by ${list(d.supports)}` : ""}; bass: ${d.bass}`,
    `Rhythm: ${d.percussion}; ${d.groove}`,
    `Harmony: ${d.harmony}. Melody: ${d.melody}`,
    `Arrangement: ${d.arrangement}`,
    d.ambience ? `Ambience: ${d.ambience}, kept low in the mix` : "Ambience: none, a clean and quiet background",
    `Production: ${d.production}; ${d.space}; ${d.dynamics}`,
    `Mood: ${d.mood}${albumMoods.length ? `, within the album's ${list(albumMoods)} feel` : ""}; ${d.context}`,
  ];
  if (brief.references.length > 0) parts.push(`Theme: ${list(brief.references)}`);
  // Vocals are stated up front for instrumental albums, so the exclusion list
  // does not repeat the planner's own "vocals" entry (user wording is kept).
  const exclusions = brief.instrumentalOnly ? d.exclusions.filter((x) => x !== "vocals") : d.exclusions;
  if (brief.instrumentalOnly) parts.push("Instrumental only, no vocals");
  if (exclusions.length > 0) parts.push(`Exclude: ${exclusions.join(", ")}`);
  const join = (ps: string[]) => ps.map((p) => p.replace(/\s+/g, " ").trim()).join(". ") + ".";
  let text = join(parts);
  // Never truncate (that could cut the exclusions): drop optional sections
  // instead. A prompt still over the limit is reported by validatePlan.
  if (text.length > FLOW_SOUND_LIMIT) {
    text = join(parts.filter((p) => !p.startsWith("Theme:") && !p.startsWith("Influences:")));
  }
  return text;
}
