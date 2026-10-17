import { FLOW_ORIGIN, MAX_BATCH_SIZE, MAX_SONGS, MIN_SONGS, WORKER_OPTIONS } from "../shared/constants";
import { FEATURES } from "../shared/features";
import { clearDiagnostics, readDiagnostics } from "../shared/logger";
import type { Command, CommandResponse } from "../shared/messages";
import type { AlbumJob, PlaylistRef, Settings, WorkerCount } from "../shared/types";
import { migrateJob, migrateSettings } from "../storage/migrations";
import { STORAGE_KEYS } from "../storage/schema";
import { icon } from "./components/icons";
import {
  attentionLabel, countsLine, issueCount, jobProgress, PHASE_LABEL, songStatus, trackStatusView, workerStatus,
  type StatusView,
} from "./components/status";

// The popup only renders stored state and sends commands. It never writes
// job state, so closing it has no effect on a running job.

type View = "main" | "queue" | "settings" | "log";

interface Form {
  description: string;
  songCount: number;
  workerCount: WorkerCount;
  playlistMode: "existing" | "new";
  playlist?: PlaylistRef;
  newName: string;
  manualName: string;
}

const FORM_KEY = "studio.form";
const PLAYLISTS_KEY = "studio.playlists";

const state = {
  view: "main" as View,
  job: null as AlbumJob | null,
  settings: null as Settings | null,
  form: null as Form | null,
  playlists: [] as PlaylistRef[],
  playlistsStatus: "idle" as "idle" | "loading" | "manual" | "error",
  expanded: undefined as string | undefined,
  error: "",
  busy: false,
  log: "",
};

const app = document.getElementById("app")!;

// ---------------------------------------------------------------- helpers

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function readLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Per-viewer convenience only.
  }
}

async function send<T = unknown>(cmd: Command): Promise<CommandResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(cmd)) as CommandResponse<T>;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function errorText(code: string): string {
  return attentionLabel(code) ?? code.replace(/_/g, " ");
}

function statusChip(s: StatusView): string {
  const spin = s.icon === "loader" ? "spin" : "";
  return `<span class="s tone-${s.tone}" title="${esc(s.label)}">${icon(s.icon, spin)}<span>${esc(s.label)}</span></span>`;
}

function iconButton(action: string, name: string, label: string, extra = ""): string {
  return `<button class="icon ghost" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(name)}</button>`;
}

function seg<T extends string | number>(action: string, options: readonly T[], current: T, labels?: Record<string, string>, groupLabel = ""): string {
  return `<div class="seg" role="group" aria-label="${esc(groupLabel)}">${options
    .map((o) => `<button data-action="${action}" data-value="${o}" aria-pressed="${o === current}">${esc(labels?.[String(o)] ?? String(o))}</button>`)
    .join("")}</div>`;
}

// ---------------------------------------------------------------- loading

async function load(): Promise<void> {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.jobMeta, STORAGE_KEYS.jobTracks, STORAGE_KEYS.jobSongs]);
  state.settings = migrateSettings(raw[STORAGE_KEYS.settings]);
  const meta = raw[STORAGE_KEYS.jobMeta] as Record<string, unknown> | undefined;
  state.job = meta
    ? migrateJob(meta, (raw[STORAGE_KEYS.jobTracks] as unknown[]) ?? [], (raw[STORAGE_KEYS.jobSongs] as unknown[]) ?? [])
    : null;
  if (!state.form) {
    const s = state.settings;
    state.form = {
      description: s.draftDescription,
      songCount: s.draftSongCount,
      workerCount: s.workerCount,
      playlistMode: s.playlistMode,
      playlist: s.playlist,
      newName: s.newPlaylistName ?? "",
      manualName: "",
      ...readLocal<Partial<Form>>(FORM_KEY),
    };
    state.playlists = readLocal<PlaylistRef[]>(PLAYLISTS_KEY) ?? (s.playlist ? [s.playlist] : []);
  }
}

function saveForm(): void {
  writeLocal(FORM_KEY, state.form);
}

// ---------------------------------------------------------------- views

function header(title = "Studio", back = false): string {
  return `<header>
    ${back ? iconButton("nav-main", "back", "Back") : ""}
    <h1>${back ? "" : icon("music")}${esc(title)}</h1>
    ${back ? "" : iconButton("nav-settings", "settings", "Settings")}
  </header>`;
}

function setupView(): string {
  const f = state.form!;
  const draft = state.job?.phase === "draft" ? state.job : null;
  const playlistControl = f.playlistMode === "new"
    ? `<input type="text" data-field="newName" placeholder="New playlist name" aria-label="New playlist name" value="${esc(f.newName)}">`
    : state.playlistsStatus === "manual"
      ? `<input type="text" data-field="manualName" placeholder="Exact playlist name" aria-label="Exact playlist name" value="${esc(f.manualName)}">`
      : `<select data-field="playlist" aria-label="Playlist">
          <option value="" ${f.playlist ? "" : "selected"} disabled>Playlist</option>
          ${state.playlists.map((p) => `<option value="${esc(p.identity)}" ${f.playlist?.identity === p.identity ? "selected" : ""}>${esc(p.name)}${p.detail ? ` · ${esc(p.detail)}` : ""}</option>`).join("")}
        </select>`;

  return `${header()}
    <textarea data-field="description" aria-label="Album description" placeholder="Describe the album">${esc(f.description)}</textarea>
    <div class="row">
      <span title="Songs" class="row">${icon("music")}<input type="number" data-field="songCount" aria-label="Songs" min="${MIN_SONGS}" max="${MAX_SONGS}" value="${f.songCount}"></span>
      <span class="grow"></span>
      <span title="Parallel sessions" class="row">${icon("layers")}${seg("workers", WORKER_OPTIONS, f.workerCount, undefined, "Parallel sessions")}</span>
    </div>
    ${FEATURES.playlist ? `<div class="row">
      ${seg("playlist-mode", ["existing", "new"] as const, f.playlistMode, { existing: "Existing", new: "New" }, "Playlist destination")}
      <span class="grow">${playlistControl}</span>
      ${f.playlistMode === "existing"
        ? iconButton("refresh-playlists", state.playlistsStatus === "loading" ? "loader" : "refresh", "Load playlists", state.playlistsStatus === "loading" ? "disabled" : "")
        : ""}
    </div>` : ""}
    <div class="err" role="alert">${state.error ? `${icon("alert")}${esc(state.error)}` : ""}</div>
    <div class="actions">
      ${iconButton("preview", "list", draft ? `Queue (${draft.tracks.length})` : "Preview queue")}
      <button class="primary" data-action="start" ${state.busy ? "disabled" : ""}>${icon("play")}Start</button>
    </div>`;
}

function jobView(job: AlbumJob): string {
  const p = jobProgress(job);
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const issues = issueCount(job);
  const running = job.phase === "generating" || job.phase === "downloads" || job.phase === "playlist";
  const resumable = job.phase === "paused" || job.phase === "needs_attention" || job.phase === "stopped";
  const generated = job.songs.some((x) => x.downloadStatus === "not_started");
  const attention = job.phase === "needs_attention" ? attentionLabel(job.attentionCode) ?? "Needs attention" : "";

  const workers = job.phase === "generating" || job.resumePhase === "generating"
    ? job.workerStates.filter((w) => w.tabId !== undefined || w.currentTrackId)
    : [];
  const workerRows = workers.map((w, i) => {
    const t = w.currentTrackId ? job.tracks.find((x) => x.trackId === w.currentTrackId) : undefined;
    return `<li><span class="n">${i + 1}</span><span class="t">${esc(t?.plannedTitle ?? "—")}</span>${statusChip(workerStatus(w))}</li>`;
  }).join("");

  const batches = [...job.downloadBatches, ...job.playlistBatches];
  const batchRows = (job.phase === "downloads" || job.phase === "playlist" || job.resumePhase === "downloads" || job.resumePhase === "playlist")
    ? batches.map((b) => {
        const tone = b.status === "completed" ? "ok" : b.status === "failed" ? "bad" : b.status === "partial" ? "warn" : b.status === "pending" ? "muted" : "active";
        const ic = b.status === "completed" ? "check" : b.status === "failed" ? "x" : b.status === "partial" ? "help" : b.status === "pending" ? "clock" : "loader";
        return `<li><span class="n">${icon(b.kind === "download" ? "download" : "listMusic", "tone-muted")}</span><span class="t">${b.index + 1} · ${b.songIds.length} ${b.songIds.length === 1 ? "song" : "songs"}</span><span class="s tone-${tone}">${icon(ic, ic === "loader" ? "spin" : "")}</span></li>`;
      }).join("")
    : "";

  const retryPhase = job.tracks.some((t) => t.trackStatus === "generation_failed" || t.trackStatus === "needs_attention")
    ? "generation"
    : job.songs.some((x) => x.downloadStatus === "download_failed")
      ? "downloads"
      : job.songs.some((x) => x.playlistStatus === "add_failed") ? "playlist" : null;

  return `${header(job.albumTitle)}
    <div class="progress"><strong>${p.done} / ${p.total}</strong><span class="phase">${esc(p.unit)} · ${esc(PHASE_LABEL[job.phase])}</span>
      ${issues > 0 ? `<button class="ghost" data-action="nav-queue" title="Issues" aria-label="${issues} issues"><span class="tone-warn row">${icon("alert")}${issues}</span></button>` : ""}
    </div>
    <div class="muted">${esc(countsLine(job))}</div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}"><span style="width:${pct}%"></span></div>
    ${attention ? `<div class="attention" role="alert">${icon("alert")}${esc(attention)}</div>` : ""}
    ${workerRows ? `<ul class="rows" aria-label="Sessions">${workerRows}</ul>` : ""}
    ${batchRows ? `<ul class="rows" aria-label="Batches">${batchRows}</ul>` : ""}
    ${job.phase === "generating" ? `<div class="row"><span class="grow"></span><span title="Parallel sessions" class="row">${icon("layers")}${seg("job-workers", WORKER_OPTIONS, job.workerCount, undefined, "Parallel sessions")}</span></div>` : ""}
    <div class="err" role="alert">${state.error ? `${icon("alert")}${esc(state.error)}` : ""}</div>
    <div class="actions">
      ${iconButton("nav-queue", "list", "Songs")}
      ${job.phase === "generating" && generated ? iconButton("process", "download", "Download finished songs now") : ""}
      ${retryPhase && !running ? iconButton(`retry:${retryPhase}`, "retry", `Retry ${retryPhase}`) : ""}
      ${running || resumable ? (job.phase !== "stopped" ? iconButton("stop", "stop", "Stop") : "") : ""}
      ${job.phase === "completed" || job.phase === "stopped" ? iconButton("discard", "trash", "Clear job") : ""}
      ${running ? `<button class="primary" data-action="pause">${icon("pause")}Pause</button>` : ""}
      ${resumable ? `<button class="primary" data-action="resume">${icon("play")}Resume</button>` : ""}
      ${job.phase === "completed" ? `<button class="primary" data-action="discard">${icon("plus")}New album</button>` : ""}
    </div>`;
}

function queueView(job: AlbumJob): string {
  const rows = [...job.tracks].sort((a, b) => a.index - b.index).map((t) => {
    const open = state.expanded === t.trackId;
    const versions = job.songs.filter((x) => x.trackId === t.trackId).sort((a, b) => a.version - b.version);
    // Versions share a title; the short UUID tells them apart.
    const versionRows = versions.map((v) =>
      `<span class="row"><span class="muted">v${v.version + 1} · ${esc(v.songId.slice(0, 8))}</span><span class="grow"></span>${statusChip(songStatus(v))}</span>`,
    ).join("");
    const editable = t.trackStatus === "draft" || t.trackStatus === "queued";
    const detail = open
      ? `<li class="editor">
          ${editable
            ? `<textarea data-field="prompt" aria-label="Prompt">${esc(t.prompt)}</textarea>
               <div class="actions"><span class="grow"></span><button data-action="save-prompt" data-id="${t.trackId}">${icon("check")}Save</button></div>`
            : `<p class="muted" style="margin:0">${esc(t.prompt)}</p>`}
          ${t.flowTitle && t.flowTitle !== t.plannedTitle ? `<span class="muted">Flow: ${esc(t.flowTitle)}</span>` : ""}
          ${versionRows}
          ${t.lastErrorCode ? `<span class="tone-warn">${esc(errorText(t.lastErrorCode))}</span>` : ""}
        </li>`
      : "";
    return `<li><span class="n">${t.index + 1}</span>
      <button class="t" data-action="toggle" data-id="${t.trackId}" aria-expanded="${open}">${esc(t.plannedTitle)}${versions.length > 1 ? ` <span class="muted">×${versions.length}</span>` : ""}</button>
      ${statusChip(trackStatusView(t, versions))}</li>${detail}`;
  }).join("");
  // Header = album title; each row is one track (its own title + prompt).
  const n = job.tracks.length;
  return `${header(job.albumTitle, true)}<div class="muted">${n} ${n === 1 ? "track" : "tracks"}</div><ul class="rows" style="max-height:420px" aria-label="Tracks">${rows}</ul>`;
}

function settingsView(): string {
  const s = state.settings!;
  return `${header("Settings", true)}
    <label class="toggle">Pause all on error <input type="checkbox" data-field="pauseOnError" ${s.pauseOnError ? "checked" : ""}></label>
    <label class="toggle">Batch size <input type="number" data-field="batchSize" min="1" max="${MAX_BATCH_SIZE}" value="${s.downloadBatchSize}"></label>
    <div class="actions">${iconButton("nav-log", "terminal", "Developer log")}</div>`;
}

function logView(): string {
  return `${header("Developer log", true)}
    <pre class="log">${esc(state.log || "—")}</pre>
    <div class="actions">
      ${iconButton("copy-log", "copy", "Copy")}
      ${iconButton("clear-log", "trash", "Clear")}
    </div>`;
}

function render(): void {
  const job = state.job;
  if (state.view === "queue" && job) app.innerHTML = queueView(job);
  else if (state.view === "settings" && state.settings) app.innerHTML = settingsView();
  else if (state.view === "log") app.innerHTML = logView();
  else {
    state.view = "main";
    app.innerHTML = job && job.phase !== "draft" ? jobView(job) : setupView();
  }
}

// ---------------------------------------------------------------- actions

async function activeFlowTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith(FLOW_ORIGIN) ? tab.id : undefined;
}

async function run(cmd: Command): Promise<CommandResponse> {
  state.busy = true;
  state.error = "";
  render();
  const res = await send(cmd);
  state.busy = false;
  if (!res.ok) state.error = errorText(res.error);
  await load();
  render();
  return res;
}

function chosenPlaylist(f: Form): PlaylistRef | undefined {
  if (state.playlistsStatus === "manual") {
    const name = f.manualName.trim();
    return name ? { identity: `name:${name}`, name } : undefined;
  }
  return f.playlist;
}

async function onAction(action: string, el: HTMLElement): Promise<void> {
  const f = state.form!;
  const [name, arg] = action.split(":");
  switch (name) {
    case "nav-main": state.view = "main"; state.error = ""; break;
    case "nav-settings": state.view = "settings"; break;
    case "nav-queue": state.view = "queue"; break;
    case "nav-log":
      state.view = "log";
      state.log = (await readDiagnostics()).map((e) =>
        `${new Date(e.at).toLocaleTimeString()} ${e.level.toUpperCase()} [${e.scope}] ${e.msg}${e.data ? ` ${JSON.stringify(e.data)}` : ""}`,
      ).join("\n");
      break;
    case "copy-log": await navigator.clipboard.writeText(state.log).catch(() => undefined); return;
    case "clear-log": await clearDiagnostics(); state.log = ""; break;
    case "workers": f.workerCount = Number(el.dataset.value) as WorkerCount; saveForm(); break;
    case "job-workers": await run({ type: "setWorkerCount", workerCount: Number(el.dataset.value) as WorkerCount }); return;
    case "playlist-mode": f.playlistMode = el.dataset.value as Form["playlistMode"]; saveForm(); break;
    case "refresh-playlists": {
      state.playlistsStatus = "loading";
      state.error = "";
      render();
      const res = await send<PlaylistRef[]>({ type: "listPlaylists" });
      if (res.ok && res.data && res.data.length > 0) {
        state.playlists = res.data;
        state.playlistsStatus = "idle";
        writeLocal(PLAYLISTS_KEY, res.data);
      } else {
        // Listing not available (UI unverified / not logged in): fall back to the exact name.
        state.playlistsStatus = "manual";
        if (!res.ok && res.error !== "ui_unverified" && res.error !== "selector_unverified") state.error = errorText(res.error);
      }
      break;
    }
    case "preview":
      if (state.job?.phase === "draft" && state.job.inputDescription === f.description.trim() && state.job.songCount === f.songCount) {
        state.view = "queue";
        break;
      }
      if ((await run({ type: "plan", description: f.description, songCount: f.songCount })).ok) state.view = "queue";
      break;
    case "start": {
      const playlist = chosenPlaylist(f);
      await run({
        type: "start",
        description: f.description,
        songCount: f.songCount,
        workerCount: f.workerCount,
        // With the playlist step off, no destination is sent at all.
        playlistMode: FEATURES.playlist ? f.playlistMode : "existing",
        playlist: FEATURES.playlist && f.playlistMode === "existing" ? playlist : undefined,
        newPlaylistName: FEATURES.playlist && f.playlistMode === "new" ? f.newName : undefined,
        tabId: await activeFlowTabId(),
      });
      return;
    }
    case "pause": await run({ type: "pause" }); return;
    case "resume": await run({ type: "resume" }); return;
    case "stop": await run({ type: "stop" }); return;
    case "process": await run({ type: "processCompleted" }); return;
    case "retry": await run({ type: "retry", phase: arg as "generation" | "downloads" | "playlist" }); return;
    case "discard": await run({ type: "discardJob" }); return;
    case "toggle": state.expanded = state.expanded === el.dataset.id ? undefined : el.dataset.id; break;
    case "save-prompt": {
      const text = (app.querySelector('[data-field="prompt"]') as HTMLTextAreaElement | null)?.value ?? "";
      await run({ type: "editPrompt", trackId: el.dataset.id!, prompt: text });
      return;
    }
  }
  render();
}

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (el && !el.hasAttribute("disabled")) void onAction(el.dataset.action!, el);
});

app.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  const f = state.form!;
  switch (el.dataset.field) {
    case "description": f.description = el.value; break;
    case "songCount": f.songCount = Math.round(Number(el.value)); break;
    case "newName": f.newName = el.value; break;
    case "manualName": f.manualName = el.value; break;
    default: return;
  }
  saveForm();
});

app.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  switch (el.dataset.field) {
    case "playlist":
      state.form!.playlist = state.playlists.find((p) => p.identity === el.value);
      saveForm();
      break;
    case "pauseOnError":
      void run({ type: "updateSettings", patch: { pauseOnError: el.checked } });
      break;
    case "batchSize":
      void run({ type: "updateSettings", patch: { downloadBatchSize: Number(el.value) } });
      break;
  }
});

// Live updates from the service worker; never clobber text being typed.
let pending: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((k) => k === STORAGE_KEYS.jobMeta || k === STORAGE_KEYS.jobTracks || k === STORAGE_KEYS.jobSongs || k === STORAGE_KEYS.settings)) return;
  clearTimeout(pending);
  pending = setTimeout(async () => {
    await load();
    const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
    if (!typing) render();
  }, 150);
});

void load().then(render);
