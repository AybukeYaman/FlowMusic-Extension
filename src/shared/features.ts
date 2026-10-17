// Build-time feature gates. The default build (`npm run build` -> dist/) keeps
// every live-site side effect off. `npm run build:e2e` (-> dist-e2e/) is the
// end-to-end test build: automatic submission after an on-page form check,
// limited to VERIFIED_MAX_WORKERS workers and MAX_SONGS songs. Downloads and
// playlist placement stay off in both builds until separately approved.

declare const __STUDIO_E2E__: boolean | undefined;
declare const __STUDIO_BUILD_ID__: string | undefined;

/** Unique per build run; lets a supervisor confirm which build is loaded. */
export const BUILD_ID: string = typeof __STUDIO_BUILD_ID__ !== "undefined" ? __STUDIO_BUILD_ID__ : "dev";

export const E2E_TEST: boolean = typeof __STUDIO_E2E__ !== "undefined" && __STUDIO_E2E__ === true;

/**
 * Highest worker count verified by a live stage (E0 = 1). Raised only after
 * a stage passes and the user approves: 1 -> 2 -> 4 -> 8 -> 10.
 */
export const VERIFIED_MAX_WORKERS = 1;

export const FEATURES = {
  /** Extension may click Generate on flowmusic.app (only after verifyFilledForm passes). */
  submission: E2E_TEST,
  /**
   * Per-track manual confirmation (data-studio-confirm). Replaced on
   * 2026-10-14 by the automatic on-page form check; kept, switched off.
   */
  confirmBeforeGenerate: false,
  /** Record the sidebar balance before/after each generation; stop on anomalies. */
  creditMonitoring: E2E_TEST,
  /** Mirror a job snapshot onto worker pages (data-studio-debug) for supervision. */
  debugSnapshot: E2E_TEST,
  /** My Songs selection + Download. Not approved yet. */
  downloads: false,
  /** Add to playlist / create playlist. Not approved yet. */
  playlist: false,
} as const;
