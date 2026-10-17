import type { ActionResult } from "../shared/types";
import { SELECTORS, type SelectorKey, type SelectorSpec } from "./flow-adapter";

export const unsupported = (key: SelectorKey | string): ActionResult<never> => ({
  kind: "unsupported", code: "selector_unverified", detail: key,
});

function accessibleName(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").trim();
}

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  // The closed Compose panel keeps its fields in the DOM at zero width.
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

export function isEnabled(el: Element): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
}

export function queryAll(spec: SelectorSpec, root: ParentNode = document): Element[] {
  return [...root.querySelectorAll(spec.css)].filter(
    (el) =>
      (!spec.name || spec.name.test(accessibleName(el))) &&
      (!spec.parentText || spec.parentText.test((el.parentElement?.textContent ?? "").trim())),
  );
}

/** Visible matches for a registry key; null if the key is unverified. */
export function find(key: SelectorKey, root: ParentNode = document): Element[] | null {
  const spec = SELECTORS[key];
  if (!spec) return null;
  return queryAll(spec, root).filter(isVisible);
}

/**
 * Exactly one visible, enabled target, or a typed failure. Zero or several
 * matches are never clicked (plan §9.3).
 */
export function findExactlyOne(key: SelectorKey, root: ParentNode = document, requireEnabled = true): ActionResult<Element> {
  const found = find(key, root);
  if (!found) return unsupported(key);
  if (found.length === 0) return { kind: "needs_attention", code: "target_missing", detail: key };
  if (found.length > 1) return { kind: "needs_attention", code: "target_ambiguous", detail: `${key}:${found.length}` };
  const el = found[0]!;
  if (requireEnabled && !isEnabled(el)) return { kind: "retryable_failure", code: "target_disabled", detail: key };
  return { kind: "success", data: el };
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Resolves with the first truthy value of `probe`, re-evaluated on DOM
 * mutations and on a bounded polling interval. Always cleans up.
 */
export function waitFor<T>(probe: () => T | null | undefined | false, opts: WaitOptions): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const check = () => {
      try {
        const v = probe();
        if (v) finish(v);
      } catch {
        // Transient DOM states are retried on the next tick.
      }
    };
    const onAbort = () => finish(null);
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const poll = setInterval(check, opts.pollMs ?? 500);
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort);
    check();
  });
}

/** Writes text into an input/textarea/contenteditable the way a user would. */
export function setFieldValue(el: Element, value: string): void {
  (el as HTMLElement).focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    // Use the prototype setter so framework-controlled inputs see the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if ((el as HTMLElement).isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // insertText goes through the editor's own input handling.
    document.execCommand("insertText", false, value);
    return;
  }
  throw new Error("unsupported_field");
}

export function fieldValue(el: Element): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el as HTMLElement).innerText ?? el.textContent ?? "";
}

export function sameText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

export function click(el: Element): void {
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  (el as HTMLElement).click();
}

export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}
