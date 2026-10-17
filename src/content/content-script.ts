import type { PageEvent, PageRequest } from "../shared/messages";
import { MAX_SONGS, WORKER_OPTIONS } from "../shared/constants";
import { BUILD_ID, E2E_TEST, FEATURES } from "../shared/features";
import { createLogger } from "../shared/logger";
import * as mySongs from "./my-songs-adapter";
import { pageState, readCredits } from "./page-state-detector";
import * as playlists from "./playlists-adapter";
import * as session from "./session-adapter";

// Message router for flowmusic.app pages. It only acts on explicit requests
// from the service worker and never assigns prompts on its own.

const log = createLogger("content");
const FLAG = "__fadedHoursStudio";

let pathTimer: ReturnType<typeof setInterval> | undefined;

/**
 * After the extension is reloaded, this script keeps running in tabs that
 * were already open but is cut off from the extension; chrome.runtime calls
 * then throw "Extension context invalidated" synchronously. Detect that and
 * shut this orphaned copy down quietly (the reloaded tab gets a fresh one).
 */
function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function shutdownOrphan(): void {
  if (pathTimer !== undefined) clearInterval(pathTimer);
  pathTimer = undefined;
  session.dispose();
}

function emit(event: PageEvent): void {
  if (!extensionAlive()) return shutdownOrphan();
  try {
    chrome.runtime.sendMessage(event).catch(() => {
      // Service worker may be restarting; it re-probes on its next tick.
    });
  } catch {
    shutdownOrphan();
  }
}

async function handle(req: PageRequest): Promise<unknown> {
  switch (req.type) {
    case "page.state":
      return pageState();
    case "page.credits":
      return { value: readCredits() };
    case "session.submit":
      return session.submit(req.trackId, req.prompt, { title: req.title, instrumental: req.instrumental });
    case "session.watch":
      return session.watch(req.trackId, req.timeoutMs, (result) =>
        emit({ type: "session.result", trackId: req.trackId, result }),
      );
    case "session.probe":
      return session.probe(req.trackId);
    case "mySongs.scan":
      return mySongs.scan(req.wanted);
    case "mySongs.clearSelection":
      return mySongs.clearSelection();
    case "mySongs.select":
      return mySongs.select(req.songs);
    case "mySongs.download":
      return mySongs.download(req.expected);
    case "mySongs.addToPlaylist":
      return mySongs.addToPlaylist(req.playlist, req.create, req.expected);
    case "playlists.list":
      return playlists.list();
    case "debug.snapshot":
      // e2e build only; ignored otherwise.
      if (FEATURES.debugSnapshot) document.documentElement.setAttribute("data-studio-debug", JSON.stringify(req.snapshot));
      return { kind: "success", data: undefined };
  }
}

if (!(window as unknown as Record<string, unknown>)[FLAG]) {
  (window as unknown as Record<string, unknown>)[FLAG] = true;

  // e2e build only: publish which build is loaded and its test limits, so a
  // supervisor can verify them from the page. Read-only information.
  if (E2E_TEST) {
    document.documentElement.setAttribute("data-studio-build", BUILD_ID);
    document.documentElement.setAttribute("data-studio-config", JSON.stringify({
      workerOptions: WORKER_OPTIONS, maxSongs: MAX_SONGS, features: FEATURES,
    }));
  }

  chrome.runtime.onMessage.addListener((msg: PageRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof msg?.type !== "string") return false;
    handle(msg).then(sendResponse, (err: unknown) => {
      log.error("handler threw", { type: msg.type, err: String(err) });
      sendResponse({ kind: "needs_attention", code: "content_exception", detail: String(err) });
    });
    return true;
  });

  const announce = (navigation: "load" | "spa") => emit({ type: "content.ready", page: pageState(), navigation });
  if (document.readyState === "complete") announce("load");
  else window.addEventListener("load", () => announce("load"), { once: true });

  // Single-page navigation keeps this script and its watchers alive. Flow
  // does this on the first Generate of a new session (/session -> /session/<uuid>).
  let lastPath = location.pathname;
  pathTimer = setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      announce("spa");
    }
  }, 1_000);

  window.addEventListener("pagehide", () => session.dispose());
}
