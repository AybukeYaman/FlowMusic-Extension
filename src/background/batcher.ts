import { MAX_BATCH_SIZE } from "../shared/constants";

export function clampBatchSize(size: number): number {
  if (!Number.isFinite(size)) return MAX_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(size)));
}

/** Splits items into consecutive groups of at most `size` (never above 100). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = clampBatchSize(size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
