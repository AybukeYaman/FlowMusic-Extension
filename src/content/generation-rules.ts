// Pure decision rules for one Compose generation, kept free of DOM access so
// they can be unit-tested. The session adapter feeds them what the page shows.

export interface CardView {
  /** Song UUID from the card's /song/<uuid> link; undefined if none. */
  id?: string;
  title?: string;
  failed: boolean;
}

export interface PageView {
  /** The verified role="status" "Generating <title>..." region is showing. */
  indicatorActive: boolean;
  cards: CardView[];
}

export type GenerationState =
  | { kind: "pending" }
  | { kind: "success"; ids: string[]; title?: string }
  | { kind: "failed" }
  | {
      kind: "needs_attention";
      code: "result_unidentified" | "result_ambiguous" | "title_mismatch" | "indicator_cleared_without_result";
    };

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** Cards not present at submit time. Compared by UUID: DOM nodes may be re-rendered. */
export function freshCards(view: PageView, baselineIds: ReadonlySet<string>): CardView[] {
  return view.cards.filter((c) => !c.id || !baselineIds.has(c.id));
}

/**
 * Generation outcome. Success needs: no active indicator, at least one new
 * card, every new card identified by a UUID, no more distinct new UUIDs than
 * one generation produces, and (when a title was set) every new card carrying
 * exactly that title. Anything else is pending or needs attention; nothing
 * here ever leads to another submit.
 */
export function evaluateGeneration(
  view: PageView, baselineIds: ReadonlySet<string>, maxSongs: number, expectedTitle?: string,
): GenerationState {
  if (view.indicatorActive) return { kind: "pending" };
  const fresh = freshCards(view, baselineIds);
  if (fresh.length === 0) return { kind: "pending" };
  if (fresh.some((c) => c.failed)) return { kind: "failed" };
  if (fresh.some((c) => !c.id)) return { kind: "needs_attention", code: "result_unidentified" };
  const ids = [...new Set(fresh.map((c) => c.id!))];
  if (ids.length > maxSongs) return { kind: "needs_attention", code: "result_ambiguous" };
  if (expectedTitle !== undefined && fresh.some((c) => norm(c.title ?? "") !== norm(expectedTitle))) {
    return { kind: "needs_attention", code: "title_mismatch" };
  }
  return { kind: "success", ids, title: fresh[0]!.title };
}

/** After the click: the site accepted the submission once either signal appears. */
export function submissionAccepted(view: PageView, baselineIds: ReadonlySet<string>): boolean {
  return view.indicatorActive || freshCards(view, baselineIds).length > 0;
}

export interface WatchState {
  sawIndicator: boolean;
  clearedAt?: number;
  /** When a new card without its /song/<uuid> link was first seen. */
  unidentifiedSince?: number;
}

/**
 * Observed in E0 (2026-10-15): Flow first renders the new song card without
 * its /song/<uuid> link and adds the link a moment later. A card without a
 * link is therefore "still loading" for this long before it counts as
 * unidentified.
 */
export const UNIDENTIFIED_GRACE_MS = 30_000;

/** Applies the unidentified-card grace to an outcome; returns the adjusted outcome. */
export function withUnidentifiedGrace(
  outcome: GenerationState, since: number | undefined, now: number, graceMs = UNIDENTIFIED_GRACE_MS,
): { outcome: GenerationState; since: number | undefined } {
  if (outcome.kind !== "needs_attention" || outcome.code !== "result_unidentified") {
    return { outcome, since: undefined };
  }
  const first = since ?? now;
  return now - first < graceMs ? { outcome: { kind: "pending" }, since: first } : { outcome, since: first };
}

/**
 * One watch step. Observed (2026-10-14): "Generating…" shows while Flow
 * works and clears when the song card appears. If it clears and no new card
 * shows up within `graceMs`, the generation most likely failed silently;
 * that is reported for attention long before the overall timeout.
 */
export function advanceWatch(
  state: WatchState, view: PageView, baselineIds: ReadonlySet<string>, maxSongs: number,
  expectedTitle: string | undefined, now: number, graceMs: number,
): { state: WatchState; outcome: GenerationState } {
  const next: WatchState = { ...state };
  if (view.indicatorActive) {
    next.sawIndicator = true;
    next.clearedAt = undefined;
  } else if (next.sawIndicator && next.clearedAt === undefined) {
    next.clearedAt = now;
  }
  const graced = withUnidentifiedGrace(evaluateGeneration(view, baselineIds, maxSongs, expectedTitle), next.unidentifiedSince, now);
  next.unidentifiedSince = graced.since;
  const outcome = graced.outcome;
  // A link-less card is a result in progress, not "no result": the
  // indicator-cleared rule only applies when no new card is there at all.
  if (outcome.kind === "pending" && graced.since === undefined && !view.indicatorActive && next.clearedAt !== undefined && now - next.clearedAt >= graceMs) {
    return { state: next, outcome: { kind: "needs_attention", code: "indicator_cleared_without_result" } };
  }
  return { state: next, outcome };
}

// ------------------------------------------------- pre-click form check

/** What the Compose form shows right before the Generate click. */
export interface FormSnapshot {
  titles: string[];
  sounds: string[];
  /** aria-checked of every Instrumental switch. */
  instrumental: (string | null)[];
  /** Buttons whose text is exactly "Generate". */
  generateTotal: number;
  /** Of those: visible and enabled. */
  generateUsable: number;
  indicatorActive: boolean;
  blocker: string | null;
  /** Titles of song cards already shown in this session. */
  existingTitles?: string[];
}

export interface FormExpectation {
  title?: string;
  sound: string;
  instrumental?: boolean;
}

/**
 * The automatic replacement for per-track manual confirmation. Generate may
 * be clicked only when this returns null: exactly one title and sound field
 * holding exactly the planned text, the Instrumental switch as planned,
 * exactly one usable Generate button, nothing generating, no blocker.
 * Returns the name of the first failed check otherwise.
 */
export function verifyFilledForm(s: FormSnapshot, e: FormExpectation): string | null {
  if (s.blocker) return `blocker:${s.blocker}`;
  if (s.indicatorActive) return "generation_running";
  // A song with this exact title is already here: it may have been
  // generated outside the extension's record. Never generate it again.
  if (e.title !== undefined && (s.existingTitles ?? []).some((t) => t === e.title)) return "title_already_on_page";
  if (s.sounds.length !== 1) return "sound_field_count";
  if (s.sounds[0] !== e.sound) return "sound_mismatch";
  if (e.title !== undefined) {
    if (s.titles.length !== 1) return "title_field_count";
    if (s.titles[0] !== e.title) return "title_mismatch";
  }
  if (e.instrumental !== undefined) {
    if (s.instrumental.length !== 1) return "instrumental_switch_count";
    if (s.instrumental[0] !== String(e.instrumental)) return "instrumental_mismatch";
  }
  if (s.generateTotal !== 1) return "generate_count";
  if (s.generateUsable !== 1) return "generate_not_usable";
  return null;
}
