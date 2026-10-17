import type { AlbumInput, AlbumPlan } from "../shared/types";

// Provider-pluggable planner. The baseline is LocalPromptPlanner, which is a
// deterministic template planner and not an LLM. A future AI-backed planner
// must be opt-in, configured explicitly by the user, and never billed silently.
export interface PromptPlanner {
  readonly id: string;
  createAlbumPlan(input: AlbumInput, songCount: number): Promise<AlbumPlan>;
}
