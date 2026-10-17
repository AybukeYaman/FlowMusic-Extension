import { TIMING } from "../shared/constants";
import { FEATURES } from "../shared/features";
import type { ActionResult, GenerationEvidence } from "../shared/types";
import { click, fieldValue, find, findExactlyOne, sameText, setFieldValue, text, unsupported, waitFor } from "./dom-utils";
import { BEHAVIOR, missingSelectors } from "./flow-adapter";
import {
  advanceWatch, evaluateGeneration, submissionAccepted, verifyFilledForm, withUnidentifiedGrace,
  type FormExpectation, type FormSnapshot, type GenerationState, type PageView, type WatchState,
} from "./generation-rules";
import { detectBlocker, pageKind } from "./page-state-detector";

// Session page: prompt submission through the Compose panel (verified
// 2026-10-14) and completion detection. Generation is only reported as
// successful when *new* result cards that were not present before submission
// are visible, not in a failed state, and no in-progress indicator remains.

// generatingIndicator is required too: without a verified in-progress state a
// freshly inserted (still rendering) card could be mistaken for a finished one.
const REQUIRED = [
  "session.composeToggle", "session.promptInput", "session.generateButton",
  "session.generatingIndicator", "session.resultCard", "session.resultLink",
] as const;

const SOUND_MAX = 3000;
const TITLE_MAX = 100;

interface Watch {
  trackId: string;
  controller: AbortController;
}

/**
 * The prompt this page last clicked Generate for, with the song UUIDs that
 * were already visible at that moment. Only this prompt's result can be
 * attributed here; a reload clears it (results then need attention).
 */
let lastSubmit: { trackId: string; baselineIds: Set<string>; expectedTitle?: string; unidentifiedSince?: number } | null = null;
const watches = new Map<string, Watch>();

function resultCards(): Element[] {
  return find("session.resultCard") ?? [];
}

function songIdOf(card: Element): string | undefined {
  const href = find("session.resultLink", card)?.[0]?.getAttribute("href") ?? "";
  return BEHAVIOR.songIdFromHref ? href.match(BEHAVIOR.songIdFromHref)?.[1] : undefined;
}

function indicatorActive(): boolean {
  return (find("session.generatingIndicator")?.length ?? 0) > 0;
}

function pageView(): PageView {
  return {
    indicatorActive: indicatorActive(),
    cards: resultCards().map((c) => ({
      id: songIdOf(c),
      title: text(find("session.resultTitle", c)?.[0]) || undefined,
      failed: (find("session.resultFailed", c)?.length ?? 0) > 0,
    })),
  };
}

function visibleIds(): Set<string> {
  return new Set(pageView().cards.flatMap((c) => (c.id ? [c.id] : [])));
}

function evidence(state: Extract<GenerationState, { kind: "success" }>): GenerationEvidence {
  return { flowSongId: state.ids[0], flowSongIds: state.ids, flowTitle: state.title };
}

function precheck(): ActionResult | null {
  const missing = missingSelectors(...REQUIRED);
  if (missing.length > 0) return unsupported(missing.join(","));
  if (!BEHAVIOR.submissionEnabled) return unsupported("submission_not_enabled");
  if (pageKind() !== "session") return { kind: "retryable_failure", code: "wrong_page" };
  const blocker = detectBlocker();
  if (blocker) return { kind: "needs_attention", code: "blocked", detail: blocker };
  // One generation per page at a time: a still-running earlier generation
  // (e.g. after a timeout) would otherwise be attributed to the next prompt.
  if (watches.size > 0 || indicatorActive()) return { kind: "retryable_failure", code: "busy" };
  return null;
}

/** The Compose fields stay in the DOM at zero width while the panel is closed. */
async function ensureComposeOpen(): Promise<ActionResult<Element>> {
  const visible = () => {
    const r = findExactlyOne("session.promptInput");
    return r.kind === "success" ? r.data : null;
  };
  const open = visible();
  if (open) return { kind: "success", data: open };
  const toggle = findExactlyOne("session.composeToggle");
  if (toggle.kind !== "success") return toggle;
  click(toggle.data);
  const input = await waitFor(visible, { timeoutMs: 5_000 });
  return input ? { kind: "success", data: input } : { kind: "retryable_failure", code: "target_missing", detail: "compose panel" };
}

async function setInstrumental(on: boolean): Promise<ActionResult | null> {
  if (missingSelectors("session.instrumentalSwitch").length > 0) return null;
  const sw = findExactlyOne("session.instrumentalSwitch");
  if (sw.kind !== "success") return sw;
  const isOn = () => sw.data.getAttribute("aria-checked") === "true";
  if (isOn() === on) return null;
  click(sw.data);
  const ok = await waitFor(() => isOn() === on, { timeoutMs: 3_000 });
  return ok ? null : { kind: "retryable_failure", code: "input_mismatch", detail: "instrumental" };
}

async function setTitle(title: string): Promise<ActionResult | null> {
  if (missingSelectors("session.titleInput").length > 0) return null;
  const visibleTitle = () => {
    const r = findExactlyOne("session.titleInput");
    return r.kind === "success" ? r.data : null;
  };
  if (!visibleTitle()) {
    const expand = findExactlyOne("session.detailsExpand");
    if (expand.kind !== "success") return expand;
    click(expand.data);
  }
  const input = await waitFor(visibleTitle, { timeoutMs: 3_000 });
  if (!input) return { kind: "retryable_failure", code: "target_missing", detail: "title" };
  const value = title.slice(0, TITLE_MAX);
  setFieldValue(input, value);
  return sameText(fieldValue(input), value) ? null : { kind: "retryable_failure", code: "input_mismatch", detail: "title" };
}

// --- Optional manual confirmation (switched off since 2026-10-14) ---------
// When FEATURES.confirmBeforeGenerate is on, the adapter publishes what it
// filled on <html data-studio-armed="{...}"> and waits until a supervisor sets
// <html data-studio-confirm="<trackId>">. The automatic form check
// (verifyFilledForm) runs in every case and replaced this for normal use.

const ARMED_ATTR = "data-studio-armed";
const CONFIRM_ATTR = "data-studio-confirm";
const CONFIRM_TIMEOUT_MS = 3 * 60_000;

function formSnapshot(): FormSnapshot {
  const allGenerate = [...document.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Generate");
  return {
    titles: (find("session.titleInput") ?? []).map((e) => fieldValue(e)),
    sounds: (find("session.promptInput") ?? []).map((e) => fieldValue(e)),
    instrumental: (find("session.instrumentalSwitch") ?? []).map((e) => e.getAttribute("aria-checked")),
    generateTotal: allGenerate.length,
    generateUsable: (find("session.generateButton") ?? []).filter((b) => !(b as HTMLButtonElement).disabled).length,
    indicatorActive: indicatorActive(),
    blocker: detectBlocker(),
    existingTitles: pageView().cards.flatMap((c) => (c.title ? [c.title] : [])),
  };
}

/**
 * Empties the title and Sound fields this adapter filled. Called whenever it
 * stops after filling but before clicking, so no filled form is left behind
 * for a later (untracked) Generate click. An empty Sound field disables
 * Generate (verified 2026-10-14).
 */
function clearFilledFields(): void {
  for (const key of ["session.promptInput", "session.titleInput"] as const) {
    for (const el of find(key) ?? []) {
      if (fieldValue(el) !== "") setFieldValue(el, "");
    }
  }
}

async function awaitManualConfirm(trackId: string, opts: SubmitOptions, sound: string): Promise<ActionResult> {
  const root = document.documentElement;
  const expected = { title: opts.title?.slice(0, TITLE_MAX), sound, instrumental: opts.instrumental };
  root.removeAttribute(CONFIRM_ATTR);
  root.setAttribute(ARMED_ATTR, JSON.stringify({ trackId, expected, actual: formSnapshot(), at: Date.now() }));
  const confirmed = await waitFor(() => root.getAttribute(CONFIRM_ATTR) === trackId, { timeoutMs: CONFIRM_TIMEOUT_MS, pollMs: 500 });
  root.removeAttribute(ARMED_ATTR);
  root.removeAttribute(CONFIRM_ATTR);
  if (!confirmed) return { kind: "unsupported", code: "test_not_confirmed" };
  // The automatic form check runs again right after this, before the click.
  return { kind: "success", data: undefined };
}

export interface SubmitOptions {
  title?: string;
  instrumental?: boolean;
}

export async function submit(trackId: string, prompt: string, opts: SubmitOptions = {}): Promise<ActionResult> {
  const pre = precheck();
  if (pre) return pre;
  const result = await fillAndClick(trackId, prompt, opts);
  // Stopped after (possibly) filling but before the click: leave no filled form.
  if (!clicked) clearFilledFields();
  return result;
}

let clicked = false;

async function fillAndClick(trackId: string, prompt: string, opts: SubmitOptions): Promise<ActionResult> {
  clicked = false;

  const input = await ensureComposeOpen();
  if (input.kind !== "success") return input;
  if (opts.instrumental !== undefined) {
    const r = await setInstrumental(opts.instrumental);
    if (r) return r;
  }
  if (opts.title) {
    const r = await setTitle(opts.title);
    if (r) return r;
  }
  const sound = prompt.slice(0, SOUND_MAX);
  setFieldValue(input.data, sound);
  if (!sameText(fieldValue(input.data), sound)) {
    return { kind: "retryable_failure", code: "input_mismatch" };
  }

  // Wait briefly for the framework to enable the control after input.
  const button = await waitFor(() => {
    const r = findExactlyOne("session.generateButton");
    return r.kind === "success" ? r.data : null;
  }, { timeoutMs: 5_000 });
  if (!button) {
    const r = findExactlyOne("session.generateButton");
    return r.kind === "success" ? { kind: "retryable_failure", code: "target_disabled" } : r;
  }

  if (FEATURES.confirmBeforeGenerate) {
    const confirmed = await awaitManualConfirm(trackId, opts, sound);
    if (confirmed.kind !== "success") return confirmed;
  }

  // Automatic pre-click check (replaces per-track approval): the page must
  // show exactly what was planned, with exactly one usable Generate button.
  const expectation: FormExpectation = { title: opts.title?.slice(0, TITLE_MAX), sound, instrumental: opts.instrumental };
  const snapshot = formSnapshot();
  const failed = verifyFilledForm(snapshot, expectation);
  if (FEATURES.debugSnapshot) {
    document.documentElement.setAttribute("data-studio-precheck", JSON.stringify({ trackId, at: Date.now(), passed: failed === null, failed, expected: expectation, snapshot }));
  }
  // Title already shown here: treat as possibly generated (never requeued).
  if (failed === "title_already_on_page") return { kind: "needs_attention", code: "title_already_on_page", detail: expectation.title };
  if (failed) return { kind: "needs_attention", code: "form_check_failed", detail: failed };

  const baselineIds = visibleIds();
  // The title we typed is the expected title of the result card.
  lastSubmit = { trackId, baselineIds, expectedTitle: opts.title ? opts.title.slice(0, TITLE_MAX) : undefined };
  // The only Generate click in this module. It runs once per submit() call,
  // and submit() runs once per claimed prompt. The Compose form is not
  // cleared afterwards, so nothing here may click again.
  clicked = true;
  click(button);
  // ---- From here on the prompt may have reached the site. ----

  const accepted = await waitFor(() => {
    if (detectBlocker()) return "blocked";
    return submissionAccepted(pageView(), baselineIds) ? "accepted" : null;
  }, { timeoutMs: TIMING.submitAcceptTimeoutMs });

  if (accepted === "accepted") return { kind: "success", data: undefined };
  if (accepted === "blocked") return { kind: "needs_attention", code: "blocked_after_submit", detail: detectBlocker() ?? "" };
  return { kind: "needs_attention", code: "accept_unconfirmed" };
}

/**
 * Watches for completion and reports through `report`. Resolves immediately;
 * the outcome arrives later as a session.result event.
 */
export function watch(
  trackId: string,
  timeoutMs: number,
  report: (r: ActionResult<GenerationEvidence>) => void,
): ActionResult {
  if (missingSelectors(...REQUIRED).length > 0) return unsupported("session");
  // Only the prompt this page actually submitted can be watched; its baseline
  // is what makes a new card attributable.
  if (lastSubmit?.trackId !== trackId) return { kind: "needs_attention", code: "no_baseline" };
  const { baselineIds, expectedTitle } = lastSubmit;
  let watchState: WatchState = { sawIndicator: false };
  watches.get(trackId)?.controller.abort();
  const w: Watch = { trackId, controller: new AbortController() };
  watches.set(trackId, w);

  void waitFor((): ActionResult<GenerationEvidence> | null => {
    const blocker = detectBlocker();
    if (blocker) return { kind: "needs_attention", code: blocker, detail: blocker };
    const step = advanceWatch(watchState, pageView(), baselineIds, BEHAVIOR.songsPerGeneration, expectedTitle, Date.now(), TIMING.resultGraceMs);
    watchState = step.state;
    const state = step.outcome;
    switch (state.kind) {
      case "pending": return null;
      case "success": return { kind: "success", data: evidence(state) };
      case "failed": return { kind: "retryable_failure", code: "generation_failed_on_site" };
      case "needs_attention": return { kind: "needs_attention", code: state.code };
    }
  }, { timeoutMs, signal: w.controller.signal, pollMs: 2_000 }).then((result) => {
    if (w.controller.signal.aborted) return;
    watches.delete(trackId);
    report(result ?? { kind: "needs_attention", code: "generation_timeout" });
  });

  return { kind: "success", data: undefined };
}

/**
 * Answers "what happened to the submission?" (after a service-worker restart
 * or a lost watch) without submitting anything. A result is only attributed
 * when this page still holds the baseline of that same prompt; otherwise the
 * answer is null (needs attention) once nothing is running any more.
 */
export function probe(trackId: string): ActionResult<GenerationEvidence | null | "still_generating"> {
  if (watches.has(trackId)) return { kind: "success", data: "still_generating" };
  if (missingSelectors(...REQUIRED).length > 0) return unsupported("session");
  if (indicatorActive()) return { kind: "success", data: "still_generating" };
  if (lastSubmit?.trackId !== trackId) return { kind: "success", data: null };
  const graced = withUnidentifiedGrace(
    evaluateGeneration(pageView(), lastSubmit.baselineIds, BEHAVIOR.songsPerGeneration, lastSubmit.expectedTitle),
    lastSubmit.unidentifiedSince, Date.now(),
  );
  lastSubmit.unidentifiedSince = graced.since;
  const state = graced.outcome;
  if (state.kind === "pending") return { kind: "success", data: "still_generating" };
  return { kind: "success", data: state.kind === "success" ? evidence(state) : null };
}

export function dispose(): void {
  for (const w of watches.values()) w.controller.abort();
  watches.clear();
}
