import { describe, expect, it } from "vitest";
import {
  advanceWatch, evaluateGeneration, submissionAccepted, UNIDENTIFIED_GRACE_MS, withUnidentifiedGrace,
  type CardView, type WatchState,
} from "../content/generation-rules";

// Mirrors what the live test showed (2026-10-14): one new card per Compose
// generation, identified by /song/<uuid>, after role="status" "Generating ..."
// cleared.
const OLD = "f305fe6b-2ab4-4f92-97d3-778d7b9b401c";
const NEW = "43db581d-5259-454c-afb9-1710edd02b24";
const card = (id?: string, failed = false): CardView => ({ id, title: "Studio Test", failed });
const baseline = new Set([OLD]);

describe("generation result rules", () => {
  it("is pending while the Generating indicator shows, even if a card appeared", () => {
    expect(evaluateGeneration({ indicatorActive: true, cards: [card(OLD), card(NEW)] }, baseline, 1)).toEqual({ kind: "pending" });
  });

  it("is pending when no new UUID has appeared yet", () => {
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(OLD)] }, baseline, 1)).toEqual({ kind: "pending" });
  });

  it("succeeds with exactly the new UUID", () => {
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(OLD), card(NEW)] }, baseline, 1))
      .toEqual({ kind: "success", ids: [NEW], title: "Studio Test" });
  });

  it("compares by UUID, so re-rendered old cards are not new", () => {
    // Same UUID, different DOM node: still old.
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(OLD), card(OLD)] }, baseline, 1)).toEqual({ kind: "pending" });
  });

  it("flags a new card without a UUID", () => {
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(OLD), card(undefined)] }, baseline, 1))
      .toEqual({ kind: "needs_attention", code: "result_unidentified" });
  });

  it("flags more new songs than one generation makes", () => {
    const extra = "11111111-2222-4333-8444-555555555555";
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(NEW), card(extra)] }, new Set(), 1))
      .toEqual({ kind: "needs_attention", code: "result_ambiguous" });
  });

  it("reports a failed card as failed, never success", () => {
    expect(evaluateGeneration({ indicatorActive: false, cards: [card(NEW, true)] }, baseline, 1)).toEqual({ kind: "failed" });
  });

  it("accepts the submission on the indicator or a new UUID", () => {
    expect(submissionAccepted({ indicatorActive: true, cards: [] }, baseline)).toBe(true);
    expect(submissionAccepted({ indicatorActive: false, cards: [card(OLD), card(NEW)] }, baseline)).toBe(true);
    expect(submissionAccepted({ indicatorActive: false, cards: [card(OLD)] }, baseline)).toBe(false);
  });
});

describe("card rendered before its /song/ link (E0 race, 2026-10-15)", () => {
  const S = 1_000;
  const linkless = { indicatorActive: false, cards: [card(OLD), { id: undefined, title: "Studio Test", failed: false }] };
  const linked = { indicatorActive: false, cards: [card(OLD), card(NEW)] };

  it("a link-less new card is still loading, then succeeds once the link appears", () => {
    let st: WatchState = { sawIndicator: true };
    let step = advanceWatch(st, linkless, baseline, 1, "Studio Test", 0, 90 * S);
    expect(step.outcome).toEqual({ kind: "pending" });
    st = step.state;
    step = advanceWatch(st, linkless, baseline, 1, "Studio Test", 20 * S, 90 * S);
    expect(step.outcome).toEqual({ kind: "pending" });
    step = advanceWatch(step.state, linked, baseline, 1, "Studio Test", 22 * S, 90 * S);
    expect(step.outcome).toEqual({ kind: "success", ids: [NEW], title: "Studio Test" });
  });

  it("a card that never gets a link is flagged after the grace period, never guessed", () => {
    let step = advanceWatch({ sawIndicator: true }, linkless, baseline, 1, "Studio Test", 0, 90 * S);
    step = advanceWatch(step.state, linkless, baseline, 1, "Studio Test", UNIDENTIFIED_GRACE_MS - 1, 90 * S);
    expect(step.outcome.kind).toBe("pending");
    step = advanceWatch(step.state, linkless, baseline, 1, "Studio Test", UNIDENTIFIED_GRACE_MS, 90 * S);
    expect(step.outcome).toEqual({ kind: "needs_attention", code: "result_unidentified" });
  });

  it("a link-less card does not trigger 'cleared without result'", () => {
    let st: WatchState = { sawIndicator: true, clearedAt: 0 };
    const step = advanceWatch(st, linkless, baseline, 1, "Studio Test", 100 * S, 90 * S);
    expect(step.outcome).toEqual({ kind: "pending" });
    st = step.state;
    expect(st.unidentifiedSince).toBe(100 * S);
  });

  it("the grace helper leaves every other outcome untouched", () => {
    expect(withUnidentifiedGrace({ kind: "pending" }, 5, 10)).toEqual({ outcome: { kind: "pending" }, since: undefined });
    expect(withUnidentifiedGrace({ kind: "needs_attention", code: "title_mismatch" }, undefined, 10).outcome)
      .toEqual({ kind: "needs_attention", code: "title_mismatch" });
  });
});
