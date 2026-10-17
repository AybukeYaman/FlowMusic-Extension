# Faded Hours Studio

Local-first Chrome extension (Manifest V3) for `https://www.flowmusic.app/`.
Describe an album once, pick a song count, parallel sessions and a playlist,
press **Start**. The extension plans unique prompts, drives several Flow Music
session tabs, then downloads the songs from **My Songs** in batches of at most
100 before adding them to the playlist.

No server, no account, no API key. See [PLAN.md](PLAN.md) for the full spec.

## Status

| Area | State |
| --- | --- |
| Project, storage, ledger, migrations | Done |
| Local prompt planner (no LLM, no key) | Done |
| Orchestrator: queue, workers, pause/stop/resume, recovery | Done (logic unit-tested) |
| Download batching and verification via `chrome.downloads` | Done (logic unit-tested) |
| Playlist phase (existing / create once) | Done (logic unit-tested) |
| Popup | Done |
| **Flow Music selectors** | **Partly verified (read-only inspection, 2026-10-14)** |

Verified: Compose panel fields, the in-progress state (`role="status"` →
"Generating …"), result cards and song ids (1 song per Compose Generate in 2
test generations), My Songs rows, selection and toolbar, Add-to-playlist menu,
Playlists page. Still unverified: failed-generation state, login/quota/modal
markers, Download result, what a playlist menu click does, the real selection
limit, list order.

Extension-driven submission is off (`BEHAVIOR.submissionEnabled = false` in
`flow-adapter.ts`) until its own end-to-end path is tested against the live
site with explicit approval. Until then Start shows **Flow UI not verified**
and nothing is typed or clicked.

## Install (developer mode)

```sh
npm install
npm run check      # typecheck + unit tests + build
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Open `https://www.flowmusic.app/session` while logged in, click the extension icon.

`npm run watch` rebuilds scripts on change; reload the extension afterwards.

## Use

1. Describe the album in one field (genre, mood, instruments, ambience, use,
   exclusions such as "no vocals, avoid loud percussion"). English plus common
   Turkish terms are understood; anything unclassified is still carried into
   every prompt as the album concept.
2. Set the song count (1–500) and parallel sessions (4 / 6 / 8 / 10).
3. Choose the playlist: **Existing** (default; ↻ loads your playlists, or type
   the exact name if listing is unavailable) or **New** (created once, reused).
4. Optional: the list icon previews the queue; click a song to edit its prompt.
5. **Start**. The popup can be closed; the job runs in the service worker.

Settings (gear): pause everything on error, download batch size (≤100),
developer log.

## Layout

```
src/background/   service worker, orchestrator, pure job logic, batching,
                  My Songs matching, download attribution, tab helpers
src/content/      content script + Flow adapters (all site selectors in flow-adapter.ts)
src/prompt/       brief parser, local planner, titles, uniqueness validation
src/storage/      repository (serialized writes), schema, migrations
src/popup/        minimal UI
src/test/         vitest unit tests (no Flow account needed)
scripts/          esbuild build, PNG icon renderer
```

Rules the code enforces:

- One writer: only the service worker writes job state, through one serialized
  queue, so a track can never be claimed twice.
- A song is `Generated` only when a *new* result card appears; clicking
  Generate is not success.
- Submit failures before the click re-queue the song. After the click,
  uncertain outcomes become `Needs attention` and are never resent automatically.
- Downloads happen before playlist placement. A download failure never resets
  generation. A playlist failure never resets downloads.
- Each generation's songs (Flow made 2 versions per prompt on inspection) are
  tracked as separate songs by `/song/<uuid>`, never by title, and every
  version is downloaded and added to the playlist.
- Batches are sized by songs, never above 100: 50 prompts × 2 = 100 songs →
  one batch; 125 × 2 = 250 → 100 + 100 + 50.
- A song already downloaded, added, or in a live batch is never queued again.
  `verification_needed` (outcome unknown) is never retried automatically or by
  the Retry button.
- Chronological order must be proven (site timestamps, verified list order, or
  our own generation times). Otherwise the job stops with **Order needs verification**.
- Unknown outcomes become `verification_needed`, never success.
- A new playlist is marked created *before* the attempt, so it is never created twice.

## Verifying the Flow Music UI (remaining work)

Fill each `null` in `src/content/flow-adapter.ts` after inspecting the
logged-in site with DevTools, and add a comment next to it with the date and
what was observed. Needed:

- **Session:** prompt input, Generate button, in-progress indicator, result
  card, result title/link, failed-result marker.
- **Any page:** login wall, quota/limit notice, blocking modal.
- **My Songs:** row, row link (and `songIdFromHref`), title, date (and
  `parseRowDate`), checkbox, selected-count, clear selection, Download, Add
  Playlist, load-more/pagination, default list order (`mySongsOrder`).
- **Playlist chooser:** dialog, option, create button, name input, confirm,
  success feedback.
- **Playlists page:** card, title, link (and `playlistIdFromHref`).
- **Behavior:** the real selection limit, and whether a multi-select download
  gives one file per song or one archive (`downloadShape`).

Then test with one session and 2–3 songs on a test playlist (PLAN.md §12.2)
before scaling up.

## Multiple workers (logic implemented; parallel generation NOT verified on Flow)

- One popup controls up to 10 Flow session tabs (1, 2, 4, 6, 8 or 10 workers).
  The service worker opens the tabs, and every worker claims the next queued
  track through one serialized queue, so no track is ever handed out twice.
- **Gradual start:** each worker's first submission waits 15–30 s after the
  previous one. This is a safety measure, not evidence that Flow accepts
  parallel generations.
- **Result check:** success needs a new `/song/<uuid>` in that tab's own
  session *and* the exact title the extension typed. A title mismatch, a
  missing id, an extra card, or "Generating…" clearing without a new song
  within 90 s → needs attention. Nothing uncertain is ever resubmitted.
- **Backoff:** a login / CAPTCHA / quota / rate-limit / blocking-dialog signal
  pauses all new assignments at once. Two failures among the last three
  results pause and lower the worker count one step (running songs continue).
  Flow-specific blocker markers were never observed; detection uses generic
  ARIA alerts and dialogs and fails safe (pauses).
- **Worker recovery:** a closed, crashed (3 silent checks), or navigated-away
  worker tab loses its in-flight track to needs-attention (never reassigned)
  and is replaced at most 3 times per job. Worker tabs are excluded from
  Chrome's Memory Saver discarding.
- **Downloads (still disabled):** batches follow album order (track number,
  then version); generation/detection times stay on each record and this order
  is not Flow's creation order. My Songs is scrolled only until every wanted
  UUID is loaded. Files are tied to songs by exact title, or one archive for
  the whole batch; a song whose own file was interrupted is a definite failure,
  everything unmatched is "check". Flow's real download format is not verified.

## Known limits

- Flow auto-plays each finished song in that tab's player (observed
  2026-10-14). The extension does not control playback, so with several
  session tabs, several songs may play at the same time whenever Chrome lets
  background tabs play audio. Muting the tabs (right-click tab → Mute site)
  is a manual workaround; whether background tabs actually play was not tested.

- Background tabs are throttled by Chrome. Completion detection uses
  MutationObserver plus slow polling, which still works but may report late.
- Chrome may ask "Download multiple files?" the first time. Until allowed,
  the batch reports **Downloads incomplete** and the job pauses.
- Flow Music's prompt length limit is unknown; prompts are about 400 characters.
- Whether Flow uses the planned title is unknown; both `plannedTitle` and
  `flowTitle` are kept.
- Account quotas, CAPTCHAs and logins are never bypassed. The affected session
  pauses until you resolve it in the tab.
