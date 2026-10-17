// Developer diagnostics. Kept in a bounded ring in storage; never shown in
// the normal UI and never contains account data (URLs are stripped of query).

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  scope: string;
  msg: string;
  data?: unknown;
}

const KEY = "diagnostics";
const MAX_ENTRIES = 300;
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function hasStorage(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

async function flush(): Promise<void> {
  flushTimer = undefined;
  if (!hasStorage() || pending.length === 0) return;
  const batch = pending;
  pending = [];
  const stored = (await chrome.storage.local.get(KEY))[KEY] as LogEntry[] | undefined;
  const next = [...(stored ?? []), ...batch].slice(-MAX_ENTRIES);
  await chrome.storage.local.set({ [KEY]: next });
}

function write(level: LogEntry["level"], scope: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { at: Date.now(), level, scope, msg, data };
  const line = `[studio:${scope}] ${msg}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.debug(line, data ?? "");
  pending.push(entry);
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), 500);
}

export function createLogger(scope: string) {
  return {
    info: (msg: string, data?: unknown) => write("info", scope, msg, data),
    warn: (msg: string, data?: unknown) => write("warn", scope, msg, data),
    error: (msg: string, data?: unknown) => write("error", scope, msg, data),
  };
}

export async function readDiagnostics(): Promise<LogEntry[]> {
  if (!hasStorage()) return [];
  return ((await chrome.storage.local.get(KEY))[KEY] as LogEntry[] | undefined) ?? [];
}

export async function clearDiagnostics(): Promise<void> {
  if (hasStorage()) await chrome.storage.local.remove(KEY);
}

export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
