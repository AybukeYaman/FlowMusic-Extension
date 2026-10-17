import { safeUrl } from "../shared/logger";
import type { PageBlocker, PageKind, PageState } from "../shared/types";
import { find } from "./dom-utils";

export function pageKind(pathname = location.pathname): PageKind {
  if (/^\/session(\/|$)/.test(pathname)) return "session";
  if (/^\/library\/my-songs(\/|$)/.test(pathname)) return "my_songs";
  if (/^\/library\/playlists(\/|$)/.test(pathname)) return "playlists";
  return "other";
}

// Third-party challenge widgets are identified by their well-known hosts,
// which does not depend on Flow Music's own markup.
const CHALLENGE_FRAMES = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="arkoselabs"]',
].join(",");

// Generic accessibility signals (any site, not Flow-specific selectors).
// NOT VERIFIED on Flow Music: no login wall, quota message, error toast or
// modal has been observed there yet. They fail safe: a match pauses work.
const MODAL_SELECTOR = '[role="alertdialog"], [role="dialog"][aria-modal="true"]';
const ALERT_SELECTOR = '[role="alert"]';

/** Classifies the text of a visible role="alert" message. Pure, unit-tested. */
export function classifyAlert(text: string): PageBlocker {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  if (/rate.?limit|too many|limit reached|quota|out of credits|no credits|daily limit|try again later/.test(t)) return "quota";
  if (/sign.?in|log.?in|session (has )?expired|signed out/.test(t)) return "login";
  return "alert";
}

/**
 * Framework screen-reader announcers are not alerts. Observed on Flow
 * (2026-10-14): Next.js renders
 * <next-route-announcer><p id="__next-route-announcer__" role="alert">PAGE TITLE</p>
 * on every page; treating it as an alert paused every job.
 */
export function isRouteAnnouncer(id: string, parentTag: string | undefined, text: string, pageTitle: string): boolean {
  return id === "__next-route-announcer__" ||
    parentTag?.toUpperCase() === "NEXT-ROUTE-ANNOUNCER" ||
    (text.trim() !== "" && text.trim() === pageTitle.trim());
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function detectBlocker(): PageBlocker {
  if (document.querySelector(CHALLENGE_FRAMES)) return "captcha";
  if (/\/(login|sign-?in|auth)(\/|$)/i.test(location.pathname)) return "login";
  if (find("page.loginGate")?.length) return "login";
  if (find("page.quotaNotice")?.length) return "quota";
  if (find("page.blockingModal")?.length) return "modal";
  for (const el of document.querySelectorAll(ALERT_SELECTOR)) {
    if (!visible(el)) continue;
    if (isRouteAnnouncer(el.id, el.parentElement?.tagName, el.textContent ?? "", document.title)) continue;
    const kind = classifyAlert(el.textContent ?? "");
    if (kind) return kind;
  }
  if ([...document.querySelectorAll(MODAL_SELECTOR)].some(visible)) return "modal";
  return null;
}

export function pageState(): PageState {
  return {
    kind: pageKind(),
    url: safeUrl(location.href),
    blocker: detectBlocker(),
    ready: document.readyState === "complete",
  };
}

/**
 * The sidebar balance: the only all-digits button next to the "Invite"
 * button (observed 2026-10-14: "◆ 36 | Invite"). The layout was observed;
 * whether this number is the generation credit balance is NOT verified.
 * Returns null unless exactly one such number is found.
 */
export function readCredits(): number | null {
  const invites = [...document.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Invite");
  if (invites.length !== 1) return null;
  const numbers = [...(invites[0]!.parentElement?.querySelectorAll("button") ?? [])]
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => /^\d+$/.test(t));
  return numbers.length === 1 ? Number(numbers[0]) : null;
}
