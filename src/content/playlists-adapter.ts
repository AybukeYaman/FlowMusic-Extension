import type { ActionResult, PlaylistRef } from "../shared/types";
import { find, text, unsupported, waitFor } from "./dom-utils";
import { BEHAVIOR, missingSelectors, SELECTORS } from "./flow-adapter";
import { detectBlocker, pageKind } from "./page-state-detector";

// Reads existing playlists from the visible Playlists page. Never a
// hard-coded list.
export async function list(): Promise<ActionResult<PlaylistRef[]>> {
  const missing = missingSelectors("playlists.card", "playlists.cardTitle");
  if (missing.length > 0) return unsupported(missing.join(","));
  if (pageKind() !== "playlists") return { kind: "retryable_failure", code: "wrong_page" };
  const blocker = detectBlocker();
  if (blocker) return { kind: "needs_attention", code: "blocked", detail: blocker };

  await waitFor(() => (find("playlists.card") ?? []).length > 0, { timeoutMs: 10_000 });
  const refs = (find("playlists.card") ?? []).map((card) => {
    const name = text(find("playlists.cardTitle", card)?.[0]);
    const linkSpec = SELECTORS["playlists.cardLink"];
    const link = linkSpec && card.matches(linkSpec.css) ? card : find("playlists.cardLink", card)?.[0];
    const href = link?.getAttribute("href") ?? "";
    const id = BEHAVIOR.playlistIdFromHref ? href.match(BEHAVIOR.playlistIdFromHref)?.[1] : undefined;
    return { identity: id ?? `name:${name}`, name };
  }).filter((p) => p.name);

  // Identical names cannot be told apart by name alone; mark them.
  const counts = new Map<string, number>();
  for (const p of refs) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return {
    kind: "success",
    data: refs.map((p) => (counts.get(p.name)! > 1 && p.identity.startsWith("name:") ? { ...p, detail: "duplicate name" } : p)),
  };
}
