import { describe, expect, it } from "vitest";
import {
  applyBackoff, assessCredits, claimNextTrack, markSubmitted, recordCredits, recordSubmitFailure, resumeJob,
  submissionsUsed, validateStart,
} from "../background/job-logic";
import { isRouteAnnouncer } from "../content/page-state-detector";
import { migrateJob, splitJob } from "../storage/migrations";
import { verifyFilledForm, type FormSnapshot } from "../content/generation-rules";
import { CREDIT_POLICY } from "../shared/constants";
import { FEATURES, VERIFIED_MAX_WORKERS } from "../shared/features";
import { NOT_SUBMITTED_CODES } from "../shared/messages";
import { makeJob } from "./fixtures/jobs";

// Automatic mode (replaces per-track approval). Logic only: nothing here
// shows the live site behaves as observed; E0 must still verify it.

const TITLE = "Hallway in the Garden";
const SOUND = "Dusty beat-tape lo-fi instrumental in E Dorian at 73 BPM. Exclude: loud percussion.";
const good: FormSnapshot = {
  titles: [TITLE], sounds: [SOUND], instrumental: ["true"],
  generateTotal: 1, generateUsable: 1, indicatorActive: false, blocker: null,
};
const expect1 = { title: TITLE, sound: SOUND, instrumental: true };

describe("pre-click form check", () => {
  it("passes only when the page shows exactly the planned form", () => {
    expect(verifyFilledForm(good, expect1)).toBeNull();
  });

  it.each([
    [{ blocker: "captcha" }, "blocker:captcha"],
    [{ indicatorActive: true }, "generation_running"],
    [{ sounds: [] }, "sound_field_count"],
    [{ sounds: [SOUND, SOUND] }, "sound_field_count"],
    [{ sounds: [`${SOUND} `] }, "sound_mismatch"],
    [{ titles: [] }, "title_field_count"],
    [{ titles: ["Hallway in the garden"] }, "title_mismatch"],
    [{ instrumental: ["false"] }, "instrumental_mismatch"],
    [{ instrumental: [] }, "instrumental_switch_count"],
    [{ generateTotal: 0 }, "generate_count"],
    [{ generateTotal: 2 }, "generate_count"],
    [{ generateUsable: 0 }, "generate_not_usable"],
  ] as const)("%j -> %s", (patch, failure) => {
    expect(verifyFilledForm({ ...good, ...patch } as FormSnapshot, expect1)).toBe(failure);
  });

  it("a failed check is a pre-click failure: the prompt was never sent", () => {
    expect(NOT_SUBMITTED_CODES.has("form_check_failed")).toBe(true);
    const job = makeJob(1, 1);
    const t = claimNextTrack(job, "w1")!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "needs_attention", code: "form_check_failed" }, true, false);
    expect(t.trackStatus).toBe("queued");
    expect(job.submittedCount ?? 0).toBe(0);
    expect(job.workerStates[0]!.status).toBe("paused"); // no automatic retry into the same page
  });
});

describe("hard limits for E0 (1 worker, 1 song)", () => {
  it("only verified worker counts may start while submission is possible", () => {
    expect(VERIFIED_MAX_WORKERS).toBe(1);
    const base = { description: "x", songCount: 1, playlistMode: "existing" as const };
    expect(validateStart({ ...base, workerCount: 1 }, false, VERIFIED_MAX_WORKERS)).toBeNull();
    for (const n of [2, 4, 8, 10]) {
      expect(validateStart({ ...base, workerCount: n }, false, VERIFIED_MAX_WORKERS)).toBe("workers_unverified");
    }
  });

  it("the submission ceiling holds even when more tracks are queued", () => {
    const job = makeJob(3, 1);
    const t = claimNextTrack(job, "w1", 1, { maxSubmissions: 1 })!;
    expect(submissionsUsed(job)).toBe(1);
    markSubmitted(job, "w1", t.trackId, 2);
    job.workerStates[0]!.status = "ready";
    job.workerStates[0]!.currentTrackId = undefined;
    expect(claimNextTrack(job, "w1", 3, { maxSubmissions: 1 })).toBeNull();
    expect(job.tracks.filter((x) => x.trackStatus === "queued")).toHaveLength(2);
  });

  it("an uncertain submission counts against the ceiling; a pre-click refusal does not", () => {
    const job = makeJob(2, 1);
    let t = claimNextTrack(job, "w1", 1, { maxSubmissions: 1 })!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "retryable_failure", code: "input_mismatch" }, true, false);
    expect(submissionsUsed(job)).toBe(0);
    t = claimNextTrack(job, "w1", 2, { maxSubmissions: 1 })!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "needs_attention", code: "accept_unconfirmed" }, false, false);
    expect(submissionsUsed(job)).toBe(1);
    job.workerStates[0]!.status = "ready";
    expect(claimNextTrack(job, "w1", 3, { maxSubmissions: 1 })).toBeNull();
  });
});

describe("credit guard", () => {
  it.each([
    [36, 36, "ok"],
    [36, 34, "ok"],
    [36, 30, "unexpected_spend"],
    [6, 4, "below_floor"],
    [null, 36, "unreadable"],
    [36, null, "unreadable"],
    [undefined, 36, "unreadable"],
  ] as const)("%s -> %s = %s", (before, after, status) => {
    expect(assessCredits(before, after, CREDIT_POLICY).status).toBe(status);
  });

  it("a stop before submitting never sends the prompt", () => {
    for (const code of ["credits_unreadable", "credits_below_floor"]) {
      expect(NOT_SUBMITTED_CODES.has(code)).toBe(true);
      const job = makeJob(1, 1);
      const t = claimNextTrack(job, "w1")!;
      recordCredits(job, t.trackId, "before", null);
      recordSubmitFailure(job, "w1", t.trackId, { kind: "needs_attention", code }, true, false);
      expect(t.trackStatus).toBe("queued");
      expect(t.creditsBefore).toBeNull();
      expect(job.submittedCount ?? 0).toBe(0);
    }
  });

  it("an unchanged balance is reported as a measured zero, not as verified cost", () => {
    const r = assessCredits(36, 36, CREDIT_POLICY);
    expect(r).toEqual({ status: "ok", delta: 0 });
  });
});

describe("permissions stay separate", () => {
  it("in the default build nothing on the live site is enabled", () => {
    // Unit tests run without the e2e define, i.e. as the default build.
    expect(FEATURES.submission).toBe(false);
    expect(FEATURES.creditMonitoring).toBe(false);
    expect(FEATURES.confirmBeforeGenerate).toBe(false);
    expect(FEATURES.downloads).toBe(false);
    expect(FEATURES.playlist).toBe(false);
  });
});

describe("E0 incident fixes (2026-10-14)", () => {
  it("Next.js route announcer is not treated as an alert", () => {
    expect(isRouteAnnouncer("__next-route-announcer__", "NEXT-ROUTE-ANNOUNCER", "Google Flow Music", "Google Flow Music")).toBe(true);
    expect(isRouteAnnouncer("", "next-route-announcer", "x", "y")).toBe(true);
    expect(isRouteAnnouncer("", "DIV", "Google Flow Music", "Google Flow Music")).toBe(true);
    expect(isRouteAnnouncer("toast", "DIV", "Daily limit reached", "Google Flow Music")).toBe(false);
  });

  it("refuses to generate a title already shown in the session, and never requeues it", () => {
    expect(verifyFilledForm({ ...good, existingTitles: ["Other", TITLE] }, expect1)).toBe("title_already_on_page");
    expect(verifyFilledForm({ ...good, existingTitles: ["Other"] }, expect1)).toBeNull();
    // Treated as "may have been submitted": not a pre-click code.
    expect(NOT_SUBMITTED_CODES.has("title_already_on_page")).toBe(false);
    const job = makeJob(2, 1);
    const t = claimNextTrack(job, "w1", 1, { maxSubmissions: 1 })!;
    recordSubmitFailure(job, "w1", t.trackId, { kind: "needs_attention", code: "title_already_on_page" }, false, false);
    expect(t.trackStatus).toBe("needs_attention");
    expect(submissionsUsed(job)).toBe(1);
    expect(applyBackoff(job, false, "title_already_on_page")).toEqual({ pauseCode: "title_already_on_page" });
  });

  it("migration v3: a legacy unconfirmed fill is uncertain, never queued again", () => {
    const job = makeJob(1, 1);
    const { meta, tracks, songs } = splitJob(job);
    const legacyMeta = { ...meta, schemaVersion: 2, phase: "needs_attention", attentionCode: "test_not_confirmed" };
    const legacyTracks = tracks.map((t) => ({ ...t, trackStatus: "queued", attempts: 1, lastErrorCode: "test_not_confirmed" }));
    const m = migrateJob(legacyMeta, legacyTracks, songs);
    expect(m.schemaVersion).toBe(3);
    expect(m.tracks[0]!.trackStatus).toBe("needs_attention");
    expect(m.tracks[0]!.lastErrorCode).toBe("unconfirmed_fill_left_on_page");
    expect(m.attentionCode).toBe("unconfirmed_fill_left_on_page");
    expect(m.submittedCount).toBe(1);
    // Even after Resume, the uncertain prompt is never handed out again.
    resumeJob(m);
    m.workerStates[0]!.status = "ready";
    expect(claimNextTrack(m, "w1", 1, { maxSubmissions: 1 })).toBeNull();
  });

  it("migration v3 leaves normal queued tracks alone", () => {
    const job = makeJob(2, 1);
    const { meta, tracks, songs } = splitJob(job);
    const m = migrateJob({ ...meta, schemaVersion: 2 }, tracks, songs);
    expect(m.tracks.every((t) => t.trackStatus === "queued")).toBe(true);
    expect(m.submittedCount ?? 0).toBe(0);
  });
});
