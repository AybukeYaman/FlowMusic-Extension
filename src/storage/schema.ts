// Storage layout. The job is split so a long track list does not have to be
// rewritten together with small, frequent worker/phase changes in the future,
// and so each key stays well below chrome.storage per-item limits.

export const STORAGE_KEYS = {
  settings: "settings",
  jobMeta: "job.meta",
  jobTracks: "job.tracks",
  jobSongs: "job.songs",
} as const;

export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const chromeStore: KeyValueStore = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

export function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & {
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}
