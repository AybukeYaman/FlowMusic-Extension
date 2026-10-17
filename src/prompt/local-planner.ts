import { MAX_SONGS, MIN_SONGS } from "../shared/constants";
import type { AlbumInput, AlbumPlan, TrackDesign, TrackPlan, VariationAxes } from "../shared/types";
import { extractAlbumTitle, parseBrief } from "./brief-parser";
import type { PromptPlanner } from "./prompt-planner";
import { writePrompt } from "./prompt-writer";
import { createRng, hashString } from "./rng";
import { TitleGenerator, albumTitleFrom } from "./title-generator";
import { TrackComposer } from "./track-composer";
import { isClean, validateDesigns, validatePlan } from "./uniqueness-validator";

// Rule-based (non-LLM) album planner. The description is parsed into a brief
// (constraints + preferences + inferred direction); the composer makes every
// musical decision per track; the writer turns each decision set into a Flow
// prompt. Same description + song count => same plan.

export interface LocalPlannerOptions {
  seed?: number;
  albumId?: string;
}

export class LocalPromptPlanner implements PromptPlanner {
  readonly id = "local";

  constructor(private readonly options: LocalPlannerOptions = {}) {}

  async createAlbumPlan(input: AlbumInput, songCount: number): Promise<AlbumPlan> {
    return planAlbum(input, songCount, this.options);
  }
}

/** Legacy flat axes, kept for storage/uniqueness checks. */
export function axesOf(d: TrackDesign): VariationAxes {
  return {
    leadInstrument: [d.lead, ...d.supports].join(" with "),
    rhythm: `${d.percussion}; ${d.groove}`,
    harmony: `${d.key}: ${d.harmony}`,
    texture: `${d.production}; ${d.space}`,
    ambience: d.ambience ?? undefined,
    energy: d.mood,
  };
}

export function planAlbum(input: AlbumInput, songCount: number, options: LocalPlannerOptions = {}): AlbumPlan {
  const description = input.description.trim();
  if (!description) throw new Error("empty_description");
  if (!Number.isInteger(songCount) || songCount < MIN_SONGS || songCount > MAX_SONGS) {
    throw new Error("invalid_song_count");
  }

  const rng = createRng(options.seed ?? hashString(`${description}#${songCount}`));
  const brief = parseBrief(description);
  const albumId = options.albumId ?? `alb_${Date.now().toString(36)}_${rng.int(1e6).toString(36)}`;
  const albumTitle = input.albumTitle?.trim() || extractAlbumTitle(description) || albumTitleFrom(rng, brief);
  const composer = new TrackComposer(brief, rng, songCount);
  const titles = new TitleGenerator(rng, brief);

  const tracks: TrackPlan[] = [];
  for (let i = 0; i < songCount; i++) {
    const design = composer.compose(i);
    tracks.push({
      trackId: `${albumId}_t${String(i + 1).padStart(3, "0")}`,
      index: i,
      title: titles.next(),
      prompt: writePrompt(design, brief),
      variationAxes: axesOf(design),
      design,
    });
  }

  const warnings = [...brief.conflicts, ...composer.warnings];
  const report = validatePlan(tracks, brief);
  for (const i of report.duplicateTitles) tracks[i] = { ...tracks[i]!, title: titles.next() };
  const final = validatePlan(tracks, brief);
  if (!isClean(final)) {
    if (final.duplicatePrompts.length > 0) warnings.push("Some prompts repeat");
    if (final.duplicateArrangements.length > 0) {
      warnings.push(`${final.distinctArrangements} distinct arrangements for ${songCount} songs`);
    }
    if (final.missingConstraints.length > 0 || final.emptyPrompts.length > 0) warnings.push("Some prompts miss album constraints");
  }
  warnings.push(...validateDesigns(tracks, brief));

  return { albumId, albumTitle, brief, tracks, warnings, notes: [...brief.inferences] };
}
