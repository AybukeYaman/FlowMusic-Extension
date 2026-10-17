# Faded Hours Studio --- Implementation Plan

**Document type:** Product + technical implementation specification for
Claude\
**Target:** Local-first Chrome Extension for
`https://www.flowmusic.app/`\
**Primary goal:** Let one user describe an album once, generate a set of
unique song prompts, run several Flow Music sessions in parallel, then
download every generated song from **My Songs** before adding the songs
to a selected playlist.\
**Default playlist mode:** Existing playlist\
**UI principle:** Radical minimalism. No redundant copy, no decorative
cards, no explanatory paragraphs in the product UI.

------------------------------------------------------------------------

## 0. Instructions to the implementer

Build a real, maintainable Chrome Extension---not a mockup. Work in
small phases, keep the extension runnable after each phase, and document
any Flow Music behavior that cannot be verified.

1.  Inspect the repository before changing anything. Preserve existing
    conventions where sensible.
2.  If there is no repository yet, create the project structure
    described below.
3.  Do not invent selectors for Flow Music. Inspect the actual DOM while
    logged in and implement selectors only after verifying them.
4.  Do not claim that an action succeeded merely because a button was
    clicked. Verify the resulting UI state or browser download event.
5.  Do not bypass authentication, CAPTCHAs, access controls, rate
    limits, or Flow Music restrictions. If a human checkpoint appears,
    pause that worker and show a minimal intervention status.
6.  Do not use a paid server or require a hosted backend. The extension
    should run locally.
7.  Do not require an AI API key for the baseline build. Make prompt
    generation provider-pluggable; the baseline must work without a paid
    API, using a local structured prompt planner. If a true LLM
    integration is added later, it must be optional, explicitly
    configured, and never silently incur costs.
8.  Treat Flow Music as an external UI that can change. Isolate
    site-specific DOM access behind an adapter, use resilient selectors,
    and fail safely when the interface is unknown.
9.  Do not implement guessed API calls, reverse-engineer private
    endpoints, or depend on undocumented server APIs. Prefer visible UI
    interactions and documented Chrome APIs.
10. Do not add extra UI explanations that repeat what icons, labels, or
    status indicators already convey.

## 1. Product scope

### 1.1 Core user journey

The user opens the extension from a single Flow Music tab and configures
one album:

-   Writes one natural-language description of the album's vibe, genre,
    ambience, instrumentation, mood, exclusions, and any character/brand
    details.
-   Chooses how many songs to make.
-   Chooses the number of parallel Flow Music workers (4, 6, 8, or 10;
    default 8).
-   Chooses a playlist destination. Default: an existing playlist. The
    user may optionally create a new playlist once and reuse it for
    every song.
-   Starts the job once.

The extension then:

1.  Creates a unique, ordered prompt queue for the album.
2.  Opens/uses the requested number of `flowmusic.app/session` tabs.
3.  Assigns a different prompt to each available worker.
4.  Detects completion of each song as reliably as the visible UI
    allows.
5.  When a worker finishes, records that result and assigns the next
    queued prompt to that same worker without waiting for all other
    workers.
6.  Tracks every generated song in a persistent ledger.
7.  Once generation is complete (or the user explicitly chooses to
    process completed songs), locates those songs in My Songs.
8.  Downloads them from My Songs in chronological order, in groups of no
    more than 100 selected songs.
9.  Only after the download phase has been processed, reselects songs
    and adds them to the selected playlist.
10. Reports completed, failed, and pending items without losing
    progress.

### 1.2 Target pages

-   Session / generation: `https://www.flowmusic.app/session`
-   My Songs / selection, download, add-to-playlist:
    `https://www.flowmusic.app/library/my-songs`
-   Playlists: `https://www.flowmusic.app/library/playlists`

All pages require the user's own logged-in Flow Music session. Do not
store or request the user's password.

### 1.3 Important observed workflow constraints

These constraints are requirements:

-   The user starts from a single session tab. The extension itself
    opens the other worker tabs.
-   Several sessions can be run concurrently, subject to what the Flow
    Music account/site actually permits.
-   Each worker must have its own prompt and state. When one worker
    completes, that worker receives the next prompt; other workers
    continue independently.
-   My Songs supports selecting songs in groups of up to 100.
-   Downloading must happen from My Songs. The playlist screen does not
    provide the required per-song download workflow.
-   The user must download first. If songs are added to a playlist
    first, selection must be done again for downloading; therefore the
    extension must perform downloads before playlist placement.
-   After the download phase, songs are selected again and added to the
    playlist.
-   More than 100 songs must be handled in batches: 237 songs = 100 +
    100 + 37; 200 = 100 + 100; 50 = 50.
-   Do not assume a multi-selection Download click produces one file.
    Verify the site's actual behavior and the Chrome download events.
-   A playlist destination is chosen before starting. Existing playlist
    is the default. If new playlist mode is selected, create it once,
    remember its identity, then reuse it for all subsequent batches.
-   Playlist additions must not be repeated if already confirmed
    successful.
-   A failure in download must not force regeneration of a song. A
    failure in playlist placement must not force re-download of a song.
-   The UI must be extremely minimalist: one primary screen, few
    controls, icons where self-explanatory, no repeated explanations, no
    redundant cards.

### 1.4 Out of scope for initial MVP

-   No remote server or account system.
-   No cloud database.
-   No automatic YouTube upload.
-   No audio mastering, editing, normalization, or merging.
-   No unsupported/private Flow Music API integration.
-   No guarantee of unlimited or free Flow Music generation. Respect the
    user's actual account limits.
-   No automatic recovery from CAPTCHAs or authentication challenges.

------------------------------------------------------------------------

## 2. UX and visual design

### 2.1 Design principles

-   Radical minimalism; use whitespace rather than explanatory panels.
-   One compact panel; no dashboard full of cards.
-   One primary action: **Start** before the job, **Pause / Resume**
    while running, and **Stop** where appropriate.
-   Use short labels and recognizable Lucide-style icons. Do not state
    in text what the adjacent icon already clearly communicates.
-   Show details only when needed: prompt editor, queue, worker errors,
    and batch progress can be collapsible or secondary views.
-   Avoid redundant status information. A song's status must have one
    canonical display.
-   Avoid celebratory animations and noisy progress effects.
-   Provide accessible tooltips for icon-only controls and accessible
    names for screen readers.
-   Keyboard navigation and visible focus states are required.
-   Do not show fake live data in production UI.

### 2.2 Main panel layout

Header: - Small brand mark/icon and `Studio`. - Settings icon for
advanced settings only.

Main controls: 1. Album description textarea. This is the primary input;
it should accept natural-language instructions in one field. 2. Song
count numeric input. Default 50; validate minimum 1 and set a sensible
maximum in configuration (default 500, but do not imply Flow Music can
generate that many within its limits). 3. Parallel workers selector: 4 /
6 / 8 / 10; default 8. 4. Playlist destination: - `Existing playlist`
selected by default. - Dropdown populated from Flow Music only after
verified UI integration. - Optional `+ New playlist` mode with a name
field; create once. 5. One primary button: `Start`.

After starting: - Replace editable controls with a compact job view or
lock the settings that would invalidate the running job. - Show
aggregate progress (e.g. `12 / 50`) once, not repeated in multiple
places. - Show worker rows in a compact list: worker number, current
song title, and state icon/status. - Show concise queue and failure
indicators. - Offer Pause, Resume, Stop, and an explicit action to
process already completed songs if implemented. - Do not display every
full prompt in the main view; click a song row to inspect/edit its
prompt. - If the user tries to close the popup, the job must continue in
the service worker / stored state where technically possible. Do not
depend on the popup staying open.

### 2.3 Status vocabulary

Use a small consistent set of statuses:

**Prompt/job** - Draft - Queued - Assigned - Generating - Generated -
Generation failed - Needs attention - Cancelled

**Download** - Not started - Selecting - Downloading - Downloaded -
Download failed - Verification needed

**Playlist** - Not started - Selecting - Adding - Added - Add failed -
Verification needed

Prefer icons plus short labels. Avoid paragraphs in status rows.

### 2.4 Minimal settings

Only expose these settings initially: - Parallel worker count (4 / 6 / 8
/ 10) - Existing playlist / create new playlist - Optional output naming
pattern if actual filenames can be controlled reliably - Pause on error
vs. continue other workers - Download batch size, default 100, maximum
100

Do not expose selectors, internal timing, DOM debug information, or
retry internals in the normal UI. Put diagnostics in a developer-only
console/log view.

------------------------------------------------------------------------

## 3. Prompt planning and song uniqueness

### 3.1 Inputs

The user's single album description should be parsed into a structured
album brief:

-   Album concept
-   Genre / subgenre
-   Mood and energy
-   Ambient setting / environmental sounds
-   Instrument palette
-   Tempo range / rhythmic density
-   Harmonic character
-   Production texture
-   Intended use (study, coding, relaxation, sleep, etc.)
-   Vocal policy (e.g. instrumental only)
-   Avoid list (e.g. sharp transitions, loud percussion, vocals,
    distracting melodies)
-   Brand/character references, if present
-   Desired variation level

Do not force the user to fill out many separate fields. Derive these
from the main text; allow optional advanced overrides only if useful.

### 3.2 Prompt-generation architecture

Implement a `PromptPlanner` interface, with a baseline local
implementation:

``` ts
interface PromptPlanner {
  createAlbumPlan(input: AlbumInput, songCount: number): Promise<AlbumPlan>;
}

interface AlbumPlan {
  albumId: string;
  albumTitle: string;
  brief: NormalizedAlbumBrief;
  tracks: TrackPlan[];
}

interface TrackPlan {
  trackId: string;
  index: number;
  title: string;
  prompt: string;
  variationAxes: {
    leadInstrument?: string;
    rhythm?: string;
    harmony?: string;
    texture?: string;
    ambience?: string;
    energy?: string;
  };
}
```

The no-key implementation must not claim to be an LLM. It should: -
Create titles from a title-pattern library and theme vocabulary. -
Assign controlled variation axes so tracks are musically distinct. -
Rotate instrument combinations, rhythm, chord color, texture, ambience,
and energy within the user's constraints. - Include the shared album
brief in each prompt so tracks stay in the same vibe. - Avoid duplicate
titles and duplicate/near-identical prompt templates. - Avoid
contradictory instructions. - Validate that the prompt isn't empty and
that required constraints are included.

Optional later provider: - Add an interface for a user-configured AI
provider only if requested. - Never embed API keys in source code. -
Store user-provided secrets only locally and explain the security
tradeoff. - Do not call a paid API unless the user explicitly configures
it. - Never silently use a billable service.

### 3.3 Uniqueness validation

Before starting generation: - Normalize titles (lowercase, trim
punctuation) and ensure all titles are unique. - Check prompt text for
exact duplicates. - Compare variation axes to ensure tracks are not all
assigned the same arrangement. - If duplicates occur, regenerate those
entries locally using unused patterns/axes. - Display a concise warning
only if the planner cannot satisfy uniqueness.

Uniqueness does not mean random changes for their own sake. Every track
should remain within the album's shared sound identity.

### 3.4 Title handling

-   Keep the track title and prompt in the local ledger.
-   Do not assume Flow Music allows a generated track's title to be set
    from the prompt. Verify actual behavior.
-   After generation, match the generated result to the assigned job
    using available metadata and time/order evidence.
-   If the site-generated title differs from the planned title and the
    UI supports renaming, use the visible UI. Otherwise retain both
    `plannedTitle` and `flowTitle`; do not silently claim the Flow Music
    title was changed.
-   Never match a song by title alone if multiple identical titles are
    possible. Prefer a unique track ID or other available metadata;
    otherwise combine title, creation order, and generation time.

------------------------------------------------------------------------

## 4. Parallel generation engine

### 4.1 Architecture

Use a central job orchestrator and independent worker records. Each
worker owns one Flow Music session tab at a time.

``` ts
interface WorkerState {
  workerId: string;
  tabId?: number;
  status: "idle" | "loading" | "ready" | "submitting" |
          "generating" | "verifying" | "paused" | "error";
  currentTrackId?: string;
  lastError?: string;
  lastHeartbeatAt?: number;
}
```

The orchestrator: - Maintains the queue of unassigned tracks. - Assigns
one track to each idle worker. - Ensures a track can be assigned to only
one worker. - Tracks each worker's state independently. - On confirmed
completion, records the result and assigns the next queued track to that
worker. - Continues other workers when one worker errors, unless the
user enabled global pause-on-error. - Persists state so a popup closing
does not destroy the queue. - Supports pause/resume/stop. - Does not
re-submit a track merely because a worker timed out; first inspect
whether the song actually generated.

### 4.2 Starting from one tab

When the user opens the extension on `flowmusic.app/session` and presses
Start: 1. Validate that the current tab is a valid Flow Music session.
2. Confirm the user is logged in, using visible page evidence. 3. Use
the current tab as one worker. 4. Open the remaining `N - 1` session
tabs using `chrome.tabs.create`. 5. Wait for each tab to finish loading
and for the verified session UI to be ready. 6. Register each tab as a
worker. 7. Start assigning prompts.

If the user is on another Flow Music page, either open one session tab
automatically or ask them to open Session; prefer the least surprising
behavior.

### 4.3 Worker lifecycle

Expected worker state sequence:

`idle → loading → ready → submitting → generating → verifying → ready`

On confirmed success: - Persist the generated result. - Mark the
assigned track `Generated`. - Release the worker. - Immediately assign
the next queued track, if any.

On error: - Capture a short error code and diagnostic detail. - Mark the
current track as failed or needs attention, depending on whether
generation might have succeeded. - Do not blindly retry if the result
may already exist. - Keep other workers running unless global
pause-on-error is enabled.

### 4.4 Completion detection

Do not use a fixed sleep as the only completion test.

Build a site adapter that detects: - Session page ready - Prompt input
ready - Generate button ready/enabled - Submission accepted -
Generation-in-progress state - Generation-complete state / resulting
song card - Error / quota / login / CAPTCHA / unexpected modal states

Use `MutationObserver` where appropriate, bounded polling as a fallback,
and timeouts with explicit failure states. Ensure observers and timers
are cleaned up when a worker is disposed.

A worker may only be marked `Generated` when the UI gives sufficient
evidence of a resulting song. Clicking Generate alone is not success.

If completion cannot be detected reliably in the current site UI: -
Pause that worker. - Set `Needs attention`. - Show one short status in
the extension. - Include a diagnostics mode for development. - Do not
invent success or automatically send another prompt into an uncertain
page.

### 4.5 Parallelism and site limits

-   Allow the user to select 4 / 6 / 8 / 10 workers.
-   Start with a conservative configurable concurrency limit.
-   Do not bypass account quotas, rate limits, CAPTCHAs, or service
    restrictions.
-   If the site indicates quota/rate limiting, pause new submissions and
    expose the relevant state.
-   Provide a simple way to lower concurrency without losing the queue.
-   Do not promise that 10 simultaneous generations will work on every
    account.

### 4.6 Prompt submission

Use the real visible input controls only after inspection: - Identify
the correct prompt input. - Fill it in a way compatible with the page
framework. - Trigger the expected input/change events if required by the
framework. - Verify that the intended prompt is visible in the input
before submitting. - Submit through the visible Generate/Create
control. - Verify the site accepted the submission. - Record submission
time and worker ID.

Do not use brittle coordinates or hard-coded screen positions.

------------------------------------------------------------------------

## 5. My Songs: discovery, chronological ordering, and download batches

### 5.1 Hard requirements

-   Download songs only from
    `https://www.flowmusic.app/library/my-songs`.
-   Download before adding to a playlist.
-   Maximum selected songs per batch: 100.
-   For `N` eligible songs, use `ceil(N / 100)` batches.
-   Sort oldest to newest using the most reliable available evidence.
-   After a batch download, verify results before proceeding.
-   If a download fails, retry only failed/unverified items; do not
    regenerate the song.
-   Keep a stable manifest of the selected song identities so the next
    batch does not repeat the first batch.

### 5.2 Identify the correct songs

Prefer, in order: 1. A stable song identifier available in visible DOM
attributes or supported UI state. 2. A unique link or element identity
visible in the page. 3. A combination of title, creation timestamp, and
other visible metadata. 4. If none is reliable, use the ordered visible
list and mark the match as lower confidence.

Do not call private/undocumented endpoints to discover songs.

### 5.3 Chronological order

Desired order: oldest generated song first, then newest.

Determine the actual My Songs ordering only after inspecting the
logged-in UI: - If the page exposes creation timestamps, sort by
timestamp. - If the page has a verified sort control, use it. - If the
page consistently displays oldest/newest in a known order, record and
test that behavior. - Do not assume the first visible card is the
oldest. - If chronological order cannot be proven, stop before bulk
selection and show a concise `Order needs verification` status rather
than risking the wrong batch.

Use the generated job ledger to match tracks from the current album to
the site's My Songs entries. Avoid downloading unrelated songs from
earlier sessions unless the user explicitly chooses them.

### 5.4 Batch algorithm

``` ts
const batchSize = 100;
const songs = eligibleSongsSortedOldestFirst();
const batches = chunk(songs, batchSize);

for (const batch of batches) {
  // 1. Navigate to / confirm My Songs
  // 2. Clear existing selection if the UI supports it
  // 3. Select exactly the batch's song identities
  // 4. Verify selected count equals batch.length
  // 5. Click the verified Download action
  // 6. Observe Chrome download events and page feedback
  // 7. Reconcile expected songs with completed downloads
  // 8. Persist the batch result
  // 9. Continue only when state is safe
}
```

Do not literally ship the pseudocode as the implementation; add
cancellation, timeouts, idempotency, and recovery.

Examples: - 50 songs → 1 batch of 50 - 100 songs → 1 batch of 100 - 200
songs → 2 batches of 100 - 237 songs → batches of 100, 100, 37

### 5.5 Download verification

Use `chrome.downloads` events where permitted by extension permissions
and browser settings. Determine the actual download behavior during
implementation: - One file per selected song? - One ZIP for the whole
batch? - A mix of download prompts or browser confirmation? - Does the
page expose progress/error feedback?

Never assume the answer before testing.

Track: - Expected song IDs - Download start time - Chrome download IDs
where available - Suggested/actual filename - Completion state - Failure
reason - Whether user action is required

Do not silently auto-rename files unless the browser/site allows it and
the resulting names can be mapped reliably. Avoid overwriting files.
Handle duplicate filenames safely.

If browser settings or multiple-download permission blocks progress,
pause and ask the user to allow the required browser permission; do not
try to bypass the browser prompt.

### 5.6 Batch recovery

Persist each batch's state: - `pending` - `selecting` - `downloading` -
`verifying` - `completed` - `partial` - `failed`

On restart: - Inspect whether the previous batch actually completed. -
Do not mark all songs downloaded just because some files exist. -
Reconcile available download events/files with expected items where
possible. - Retry only failed or unverified items. - If exact mapping
from files to songs is impossible, mark `Verification needed` instead of
guessing.

------------------------------------------------------------------------

## 6. Playlist workflow

### 6.1 Required order

The sequence is mandatory:

1.  Finish or explicitly pause the download phase.
2.  Return to My Songs.
3.  Reselect the intended songs because the prior selection may have
    been cleared.
4.  Click `Add Playlist`.
5.  Select the chosen existing playlist, or create a new playlist once
    if that mode was chosen.
6.  Verify the action succeeded.
7.  Persist the playlist status per song or per confirmed batch.

Do not add songs to a playlist before the download stage has run for
those songs.

### 6.2 Existing playlist (default)

-   Load playlist choices from the visible Flow Music UI, not a
    hard-coded list.
-   Require one explicit selection before Start.
-   Persist the playlist's stable visible identity if one exists;
    otherwise persist its exact name and disambiguating visible
    metadata.
-   If the playlist cannot be found later, pause and ask the user to
    select a replacement.
-   For every batch, select songs again and add them to the same
    existing playlist.
-   Verify the resulting UI state; a click alone is insufficient.
-   Avoid duplicate additions when the site exposes membership state. If
    membership cannot be verified, mark `Verification needed` and do not
    blindly repeat the add operation.

### 6.3 Create new playlist (optional mode)

Although the default is existing playlist, support a second mode: - Ask
for the playlist name. - Create the playlist once, before the first add
operation or at the point required by the actual UI. - Verify that
creation succeeded. - Save its stable identity/name. - Reuse that same
playlist for every later batch. - Never create a new playlist per
batch. - If creation fails, stop playlist processing while preserving
download results.

### 6.4 Playlist batches

If the site has a selection limit, use the same verified batch size
(maximum 100, or lower if the actual UI imposes a smaller limit).
Playlist operations must have their own progress states, separate from
downloads.

Examples: - 237 songs: download 100/100/37 first; then add 100/100/37 to
the same playlist. - If downloads succeed for all 237 but playlist
addition fails for batch 2, retry playlist batch 2 only.

------------------------------------------------------------------------

## 7. Persistent data model

Use `chrome.storage.local` for the job ledger and settings. Keep storage
writes serialized or otherwise race-safe. Do not rely on in-memory popup
state.

Suggested types:

``` ts
type TrackStatus =
  | "draft" | "queued" | "assigned" | "generating"
  | "generated" | "generation_failed" | "needs_attention"
  | "cancelled";

type DownloadStatus =
  | "not_started" | "selecting" | "downloading"
  | "downloaded" | "download_failed" | "verification_needed";

type PlaylistStatus =
  | "not_started" | "selecting" | "adding"
  | "added" | "add_failed" | "verification_needed";

interface TrackRecord {
  trackId: string;
  albumId: string;
  index: number;
  plannedTitle: string;
  prompt: string;
  variationAxes: Record<string, string | undefined>;
  trackStatus: TrackStatus;
  workerId?: string;
  sessionTabId?: number;
  submittedAt?: number;
  generatedAt?: number;
  flowSongId?: string;
  flowTitle?: string;
  flowCreatedAt?: number;
  identityConfidence?: "high" | "medium" | "low";
  downloadStatus: DownloadStatus;
  downloadIds?: number[];
  downloadedFiles?: string[];
  playlistStatus: PlaylistStatus;
  playlistIdentity?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt: number;
}

interface AlbumJob {
  albumId: string;
  createdAt: number;
  updatedAt: number;
  inputDescription: string;
  songCount: number;
  workerCount: 4 | 6 | 8 | 10;
  playlistMode: "existing" | "new";
  playlistIdentity?: string;
  playlistName?: string;
  phase: "draft" | "generating" | "downloads" | "playlist" |
         "completed" | "paused" | "stopped" | "needs_attention";
  tracks: TrackRecord[];
  workerStates: WorkerState[];
  downloadBatchSize: number;
  lastProcessedDownloadBatch?: number;
  lastProcessedPlaylistBatch?: number;
}
```

Implementation note: if storing a large track list in one storage key
risks write races or quota issues, split settings, album metadata,
tracks, and worker state into separate keys. Keep updates atomic at the
logical operation level and debounce noncritical UI writes.

Never store authentication cookies, passwords, or other credentials.

------------------------------------------------------------------------

## 8. Chrome Extension architecture

Use Manifest V3.

Suggested project layout:

``` text
faded-hours-studio/
├── manifest.json
├── package.json
├── README.md
├── PLAN.md
├── src/
│   ├── background/
│   │   ├── service-worker.ts
│   │   ├── orchestrator.ts
│   │   ├── tab-manager.ts
│   │   ├── download-manager.ts
│   │   └── job-recovery.ts
│   ├── content/
│   │   ├── content-script.ts
│   │   ├── flow-adapter.ts
│   │   ├── session-adapter.ts
│   │   ├── my-songs-adapter.ts
│   │   ├── playlists-adapter.ts
│   │   ├── dom-utils.ts
│   │   └── page-state-detector.ts
│   ├── prompt/
│   │   ├── prompt-planner.ts
│   │   ├── local-planner.ts
│   │   ├── title-generator.ts
│   │   └── uniqueness-validator.ts
│   ├── storage/
│   │   ├── schema.ts
│   │   ├── repository.ts
│   │   └── migrations.ts
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.ts
│   │   ├── styles.css
│   │   └── components/
│   ├── shared/
│   │   ├── messages.ts
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   └── logger.ts
│   └── test/
│       ├── prompt-planner.test.ts
│       ├── batcher.test.ts
│       ├── state-machine.test.ts
│       ├── recovery.test.ts
│       └── fixtures/
└── dist/
```

Adjust to the chosen build tooling, but keep clear boundaries between
UI, orchestration, storage, prompt generation, and Flow-specific DOM
behavior.

### 8.1 Responsibilities

**Popup UI** - Collect configuration. - Display job state. - Send
commands to the service worker. - Never own the only copy of job
state. - Keep the layout minimal.

**Manifest V3 service worker** - Own job orchestration. - Open and
manage tabs. - Persist progress. - Receive download events. - Recover
state after service worker suspension. - Use alarms or event-driven
recovery only where appropriate; do not depend on long-lived timers
surviving suspension.

**Content scripts** - Inspect and interact with the visible Flow Music
page. - Send page state and results to the background worker. - Keep
site-specific selectors inside adapters. - Do not independently assign
prompts without the orchestrator's approval.

**Flow adapters** - `SessionAdapter`: session readiness, prompt field,
submit, generation status/result. - `MySongsAdapter`: song discovery,
sorting evidence, selection, download action, add-playlist action. -
`PlaylistsAdapter`: existing playlist discovery and new playlist
creation/verification.

**Storage repository** - Persist jobs, tracks, workers, batches, and
settings. - Provide safe state transitions and migration support. -
Prevent two workers from claiming the same track.

### 8.2 Manifest permissions

Request only permissions needed by the actual implementation. Likely
candidates: - `storage` - `tabs` - `downloads` - `alarms` if used - Host
permission for `https://www.flowmusic.app/*`

Do not request broad `*://*/*` host access. Explain any permission
request briefly at first use. Use the smallest set of permissions that
supports verified functionality.

------------------------------------------------------------------------

## 9. Flow Music DOM integration strategy

This is the highest-risk implementation area and must be approached
deliberately.

### 9.1 Inspect first

Before writing final selectors, inspect the logged-in site with Chrome
DevTools: - Session input and submit control. - Loading and generation
status. - Result card metadata and links. - My Songs song-card
structure. - Selection control and selected count. - Download action and
any confirmation dialog. - Add Playlist action and playlist chooser. -
Existing playlist names and identity. - Create playlist dialog/form. -
Pagination or infinite scrolling. - Sorting controls and date metadata.

Record verified selectors and behavior in `src/content/flow-adapter.ts`
comments or a small internal adapter document.

### 9.2 Selector priority

Use, in order: 1. Stable accessible roles/names and labels. 2. Stable
`data-*` attributes. 3. Stable semantic DOM structure. 4. Scoped CSS
selectors based on verified markup.

Avoid: - Generated CSS class hashes as the only selector. - nth-child
chains without verification. - Coordinate-based clicking. - Text matches
that can accidentally select multiple controls. - Direct access to
framework internals. - Private backend endpoints.

### 9.3 Safe action wrapper

Every action should: 1. Confirm the expected page and state. 2. Find
exactly one intended target. 3. Confirm it is visible and enabled. 4.
Perform the action. 5. Wait for a meaningful state change. 6. Return a
typed result (`success`, `retryable_failure`, `needs_attention`,
`unsupported`). 7. Capture concise diagnostics when unsuccessful.

If the target count is zero or more than one, do not click. Pause the
affected operation and report a selector/UI mismatch.

### 9.4 Site changes

If Flow Music changes its markup: - Fail safely. - Do not continue
selecting or downloading potentially incorrect songs. - Mark the
operation `Needs attention`. - Log the current page URL, detected state,
and missing control (without sensitive account data). - Keep the job
ledger intact so the user can resume after the adapter is fixed.

------------------------------------------------------------------------

## 10. Job state machine and idempotency

### 10.1 Phases

`draft → generating → downloads → playlist → completed`

Possible side states: `paused`, `stopped`, `needs_attention`.

Generation can be marked complete while individual tracks have failures.
The job must expose those failures and not pretend the whole album
succeeded.

### 10.2 Idempotency rules

-   A track can be assigned to only one worker at a time.
-   A track cannot be submitted twice unless a prior attempt is
    confirmed failed or the user explicitly retries.
-   A download batch is not complete until its expected download result
    is verified.
-   A completed download must not be restarted automatically.
-   A playlist addition must not be repeated if the UI confirms
    membership.
-   If success is ambiguous, use `verification_needed` instead of
    guessing.
-   Re-running a phase must operate only on items that are pending,
    failed, or unverified for that phase.
-   Playlist failure never resets download status.
-   Download failure never resets generation status.

### 10.3 Pause, stop, and resume

**Pause** - Do not start new prompts. - Let active generations finish if
safe, or pause them only if the site supports it. - Do not close tabs
automatically. - Keep download/playlist batches at a safe checkpoint.

**Stop** - Stop scheduling new work. - Persist all states. - Do not
delete downloaded files or job records. - Ask for confirmation only if
stopping would discard an active operation that cannot be resumed.

**Resume** - Reconcile tabs with stored worker records. - Check for
results from uncertain prior submissions before retrying. - Continue
from the first safe pending action.

------------------------------------------------------------------------

## 11. Error handling

Use short user-facing errors, with detailed diagnostics only in a
developer log.

Handle: - User not logged in - Session page failed to load - Prompt
field not found - Generate button disabled - Submission not accepted -
Generation timed out / unknown result - Quota or rate limit - CAPTCHA or
human verification - Unexpected modal - My Songs list failed to load -
Song identity ambiguous - Chronological order not verified - Selection
count mismatch - Download blocked by browser permission - Download
started but failed - Download filename cannot be mapped to song -
Playlist not found - New playlist creation failed - Playlist addition
ambiguous - Extension service worker restarted - Flow Music tab closed -
Flow Music UI changed

Do not loop indefinitely. Use bounded retries with backoff for transient
UI failures, and stop retries for unknown/ambiguous outcomes.

------------------------------------------------------------------------

## 12. Testing plan

### 12.1 Unit tests (no Flow Music account required)

-   Prompt planner creates requested count.
-   Titles are unique.
-   Exact duplicate prompts are rejected.
-   Album constraints are present in every prompt.
-   Track queue never assigns a track twice.
-   A completed worker receives the next queued track.
-   One worker failure does not block other workers.
-   Batch partitioning:
    -   0 → 0 batches
    -   1 → 1 batch
    -   50 → 1 batch
    -   100 → 1 batch
    -   101 → 100 + 1
    -   200 → 100 + 100
    -   237 → 100 + 100 + 37
-   Resume does not repeat completed downloads.
-   Playlist failure does not reset download status.
-   Download failure does not reset generation status.
-   Ambiguous outcomes become `verification_needed`.
-   State migrations preserve existing job data.

### 12.2 Integration tests (logged-in test session)

Start with one worker and a small count (2--3 songs): 1. Start extension
from Session. 2. Generate a prompt. 3. Confirm completion detection. 4.
Confirm the next prompt is assigned. 5. Inspect My Songs matching. 6.
Download one song and verify the download event. 7. Add one song to an
existing test playlist after download. 8. Reload extension and resume.
9. Confirm no duplicate generation/download/playlist addition.

Then test: - 2 workers. - 4 workers. - 8 workers. - 10 workers only if
the account/site reliably supports it. - A batch of more than 100
eligible songs, or test the batcher with fixtures. - A deliberately
failed download. - A missing playlist. - A simulated DOM selector
mismatch. - Service worker suspension/restart.

Do not test bulk destructive or irreversible actions on the user's only
important playlist. Use a test playlist if possible.

### 12.3 Acceptance criteria

The MVP is acceptable only if: - User can configure album description,
song count, concurrency, and existing playlist in one compact panel. -
Extension opens the requested number of session tabs (within
browser/site limits). - Each worker uses a different queued prompt. - A
worker receives the next prompt after verified completion, independently
of other workers. - Prompt/title queue and progress survive popup
closure and browser/service-worker restarts as far as Chrome permits. -
My Songs songs are matched to this album without accidentally processing
unrelated library songs. - Chronological order is verified or the
extension stops safely. - Download batches never exceed 100
selections. - Downloads always precede playlist additions. - More than
100 songs are processed in correct batches. - Existing playlist is the
default destination; new playlist mode creates only one playlist. -
Failed operations can be retried independently. - No false success
states. - No API key or paid service is required for the baseline. - The
UI remains minimal and does not add redundant explanatory text.

------------------------------------------------------------------------

## 13. Implementation milestones

### Milestone 1 --- Project foundation

-   Create MV3 project and build scripts.
-   Implement minimal popup.
-   Implement storage schema and repository.
-   Add unit tests for batches and state machine.
-   Confirm extension loads via `chrome://extensions` developer mode.

**Exit criteria:** Extension loads, saves settings, and can create a
mock album job locally.

### Milestone 2 --- Prompt planner

-   Parse the single album description into a normalized brief.
-   Generate requested titles/prompts locally.
-   Validate uniqueness and shared constraints.
-   Display the generated queue in a compact secondary view.
-   Allow editing a prompt before generation.

**Exit criteria:** A 50-track plan is generated and validated without a
paid API.

### Milestone 3 --- One-session adapter

-   Inspect actual Flow Music Session DOM.
-   Implement verified prompt input and submission.
-   Detect accepted submission and generated result.
-   Store track-to-result association.
-   Add manual intervention state when uncertain.

**Exit criteria:** One track can be submitted and confirmed without
false completion.

### Milestone 4 --- Parallel orchestration

-   Open additional tabs.
-   Add independent worker state machines.
-   Implement queue dispatch and next-prompt scheduling.
-   Implement pause/resume/recovery.
-   Add concurrency limits and quota detection.

**Exit criteria:** At least 2 workers run independently; scale to 4/8/10
only after reliable tests.

### Milestone 5 --- My Songs and download batching

-   Inspect My Songs DOM and actual selection behavior.
-   Match generated songs to visible song records.
-   Verify chronological order.
-   Implement exact batch selection (maximum 100).
-   Trigger Download and reconcile browser download events.
-   Persist batch state and retry failures.

**Exit criteria:** A test set of more than 100 records partitions and
processes correctly, with real UI tested on a small batch first.

### Milestone 6 --- Playlist integration

-   Inspect existing playlist chooser.
-   Load playlist options.
-   Add downloaded songs after reselecting them.
-   Verify addition and prevent duplicates.
-   Implement optional one-time playlist creation.

**Exit criteria:** A song is downloaded first, then added to the
selected existing playlist, with independent recovery.

### Milestone 7 --- Hardening and documentation

-   Complete unit/integration tests.
-   Add concise developer diagnostics.
-   Verify permissions are minimal.
-   Add README installation/use/troubleshooting instructions.
-   Test popup closure and service worker restart.
-   Remove mock data and placeholder UI from production.

**Exit criteria:** No placeholder success states; all unsupported
behaviors are documented honestly.

------------------------------------------------------------------------

## 14. Deliverables expected from Claude

1.  Complete source code for the extension.
2.  `manifest.json` using Manifest V3.
3.  Build scripts and lockfile.
4.  `PLAN.md` (this plan) and a concise `README.md`.
5.  Unit tests for prompt uniqueness, worker queue, batching, state
    transitions, and recovery.
6.  A clear list of Flow Music selectors/behaviors that were verified
    against the actual logged-in UI.
7.  A clear list of any remaining manual steps or unsupported site
    behaviors.
8.  No secrets, paid API dependencies, or fake completed workflows.
9.  Final response summarizing files created, installation steps, tests
    run, and what remains unverified.

## 15. Final product principle

The user describes the music once, chooses the number of tracks,
concurrency, and playlist, then presses Start. The extension manages the
queue and records every step.

The product UI should say as little as possible while making the current
state obvious. The internal implementation, however, must be explicit,
testable, recoverable, and conservative around uncertain Flow Music
behavior.
