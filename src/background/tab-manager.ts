import { FLOW_ORIGIN, FLOW_URLS, TIMING } from "../shared/constants";
import type { PageRequest, PageResponses } from "../shared/messages";
import type { PageKind, PageState } from "../shared/types";

export class TransportError extends Error {}

/** Sends a request to the content script in a tab. Throws TransportError if unreachable. */
export async function sendToTab<K extends PageRequest["type"]>(
  tabId: number,
  req: Extract<PageRequest, { type: K }>,
): Promise<PageResponses[K]> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, req);
    if (res === undefined) throw new TransportError("no_response");
    return res as PageResponses[K];
  } catch (err) {
    throw err instanceof TransportError ? err : new TransportError(String(err));
  }
}

export async function pageStateOf(tabId: number): Promise<PageState | null> {
  try {
    return await sendToTab(tabId, { type: "page.state" });
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the tab's content script reports a loaded page of `kind`. */
export async function waitForPage(tabId: number, kind: PageKind, timeoutMs: number = TIMING.tabReadyTimeoutMs): Promise<PageState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pageStateOf(tabId);
    if (state && state.ready && (state.kind === kind || state.blocker)) return state;
    await sleep(1_000);
  }
  return null;
}

export async function openTab(url: string, active = false): Promise<number> {
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id === undefined) throw new Error("tab_create_failed");
  await keepAlive(tab.id);
  return tab.id;
}

/**
 * Asks Chrome not to discard a worker tab (Memory Saver) while it waits for
 * a song in the background. A browser setting, not a Flow Music control.
 */
export async function keepAlive(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
}

export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

export async function liveFlowTabIds(): Promise<Set<number>> {
  const tabs = await chrome.tabs.query({ url: `${FLOW_ORIGIN}/*` });
  return new Set(tabs.flatMap((t) => (t.id === undefined ? [] : [t.id])));
}

const KIND_URL: Record<Exclude<PageKind, "other">, string> = {
  session: FLOW_URLS.session,
  my_songs: FLOW_URLS.mySongs,
  playlists: FLOW_URLS.playlists,
};

/**
 * Returns a tab showing `kind`, reusing `preferTabId` (navigating it if
 * needed) or opening a background tab. Never touches worker session tabs
 * unless asked to.
 */
export async function ensurePageTab(
  kind: Exclude<PageKind, "other">,
  preferTabId?: number,
): Promise<{ tabId: number; state: PageState | null; opened: boolean }> {
  let tabId = preferTabId !== undefined && (await tabExists(preferTabId)) ? preferTabId : undefined;
  let opened = false;
  if (tabId === undefined) {
    tabId = await openTab(KIND_URL[kind]);
    opened = true;
  } else {
    const state = await pageStateOf(tabId);
    if (state?.kind === kind && state.ready) return { tabId, state, opened };
    await chrome.tabs.update(tabId, { url: KIND_URL[kind] });
  }
  return { tabId, state: await waitForPage(tabId, kind), opened };
}
