import type { AlbumJob, Settings } from "../shared/types";
import { migrateJob, migrateSettings, splitJob } from "./migrations";
import { STORAGE_KEYS, type KeyValueStore } from "./schema";

// Single writer for persisted state. Only the service worker writes; all
// writes go through one promise chain so read-modify-write cycles never
// interleave (e.g. two workers finishing at the same moment cannot both
// claim the same queued track).
export class Repository {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyValueStore) {}

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async getSettings(): Promise<Settings> {
    const raw = await this.store.get([STORAGE_KEYS.settings]);
    return migrateSettings(raw[STORAGE_KEYS.settings]);
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.serialize(async () => {
      const next = migrateSettings({ ...(await this.getSettings()), ...patch });
      await this.store.set({ [STORAGE_KEYS.settings]: next });
      return next;
    });
  }

  async getJob(): Promise<AlbumJob | null> {
    const raw = await this.store.get([STORAGE_KEYS.jobMeta, STORAGE_KEYS.jobTracks, STORAGE_KEYS.jobSongs]);
    const meta = raw[STORAGE_KEYS.jobMeta] as Record<string, unknown> | undefined;
    if (!meta) return null;
    return migrateJob(
      meta,
      (raw[STORAGE_KEYS.jobTracks] as unknown[]) ?? [],
      (raw[STORAGE_KEYS.jobSongs] as unknown[]) ?? [],
    );
  }

  replaceJob(job: AlbumJob | null): Promise<void> {
    return this.serialize(async () => {
      if (!job) {
        await this.store.remove([STORAGE_KEYS.jobMeta, STORAGE_KEYS.jobTracks, STORAGE_KEYS.jobSongs]);
        return;
      }
      await this.write(job);
    });
  }

  /**
   * Atomic read-modify-write of the current job. `fn` mutates the job in place
   * and may return a value. Throws if there is no job.
   */
  mutateJob<T>(fn: (job: AlbumJob) => T): Promise<T> {
    return this.serialize(async () => {
      const job = await this.getJob();
      if (!job) throw new Error("no_job");
      const result = fn(job);
      job.updatedAt = Date.now();
      await this.write(job);
      return result;
    });
  }

  private async write(job: AlbumJob): Promise<void> {
    const { meta, tracks, songs } = splitJob(job);
    await this.store.set({
      [STORAGE_KEYS.jobMeta]: meta,
      [STORAGE_KEYS.jobTracks]: tracks,
      [STORAGE_KEYS.jobSongs]: songs,
    });
  }
}
