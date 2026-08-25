import {
  cycleIndex,
  rankCandidates,
  sameCandidates,
  type Candidate,
  type ScreenPoint,
} from './candidateMath';

/**
 * The one candidate system.
 *
 * Given a cursor position it asks every registered provider what it has under
 * there, ranks the answers, exposes the top one for pre-highlight, and lets
 * `Tab` cycle. Phase 1 registers the element and measurement providers;
 * snapping (Phase 3) registers a third and inherits the ranking, the cycling
 * and the hover display for free.
 *
 * Building this twice — once for measurement picking, once for snap picking —
 * is the mistake the orbit work already paid for (two rotate paths, one
 * ignoring the pivot). Hence one resolver, many providers.
 *
 * No DOM and no WebGL here: pointer and keyboard wiring is `CandidateInput`'s
 * job, and the maths lives in `candidateMath.ts`.
 */

export interface CandidateProvider {
  /** Matches `Candidate.kind` for everything this provider emits. */
  kind: string;
  /** What is under the cursor right now. Return `[]` for nothing. */
  candidatesAt(cursor: ScreenPoint): Candidate[];
  /**
   * Act on a click that landed with one of this provider's candidates active.
   * Optional: the element provider has no handler because `SelectionManager`
   * owns that path already and passing a selection mode through here would
   * leak selection semantics into a generic resolver.
   */
  pick?(candidate: Candidate): void;
  /**
   * Show or clear the "this is what a click would take" affordance. Called
   * with the active candidate when it belongs to this provider, and with
   * `null` on every other provider, so exactly one thing is lit at a time.
   */
  highlight?(candidate: Candidate | null): void;
}

/**
 * How far the cursor may drift, in CSS pixels, before a re-resolve is treated
 * as a new gesture and the `Tab` offset resets. Small enough that moving to a
 * different element restarts the cycle, large enough that hand tremor during a
 * `Tab` sequence does not.
 */
const HOLD_RADIUS_PX = 4;

export class CandidateResolver {
  private providers: CandidateProvider[] = [];

  /** Ranked result of the last `resolve`. */
  private ranked: Candidate[] = [];
  /** Index into `ranked` — moved by `cycle()`, reset when the set changes. */
  private offset = 0;
  /** Cursor the last `resolve` ran at, for the hold radius. */
  private lastCursor: ScreenPoint | null = null;

  register(provider: CandidateProvider): () => void {
    this.providers.push(provider);
    return () => {
      this.providers = this.providers.filter((p) => p !== provider);
    };
  }

  /**
   * Re-ask every provider and re-rank. Keeps the `Tab` offset when the cursor
   * has barely moved and the same candidates came back; resets it otherwise.
   * Returns the ranked list.
   */
  resolve(cursor: ScreenPoint): Candidate[] {
    const fresh: Candidate[] = [];
    for (const provider of this.providers) {
      fresh.push(...provider.candidatesAt(cursor));
    }
    const ranked = rankCandidates(fresh);

    const held =
      this.lastCursor !== null &&
      Math.hypot(cursor.x - this.lastCursor.x, cursor.y - this.lastCursor.y) <= HOLD_RADIUS_PX &&
      sameCandidates(this.ranked, ranked);

    this.ranked = ranked;
    this.lastCursor = { x: cursor.x, y: cursor.y };
    if (!held) this.offset = 0;
    // A held list can still shrink out from under the offset if a provider
    // dropped something without changing the rest — clamp rather than trust.
    if (this.offset >= ranked.length) this.offset = 0;

    return ranked;
  }

  /** The candidate a click would act on, or null when there is nothing. */
  getActive(): Candidate | null {
    return this.ranked[this.offset] ?? null;
  }

  /** How many candidates the last `resolve` found. */
  count(): number {
    return this.ranked.length;
  }

  /**
   * Move to the next (or, with `step: -1`, previous) candidate. No-op below
   * two candidates — with one there is nothing to cycle to, and `Tab` should
   * be left to the browser's focus traversal instead.
   */
  cycle(step = 1): Candidate | null {
    if (this.ranked.length < 2) return this.getActive();
    this.offset = cycleIndex(this.offset, this.ranked.length, step);
    return this.getActive();
  }

  /** Route a click to the provider that produced `candidate`. */
  pick(candidate: Candidate): void {
    this.providers.find((p) => p.kind === candidate.kind)?.pick?.(candidate);
  }

  /**
   * Light the active candidate and clear every other provider's affordance.
   * Called after `resolve` on hover, and after `cycle`.
   */
  refreshHighlight(): void {
    const active = this.getActive();
    for (const provider of this.providers) {
      provider.highlight?.(active && active.kind === provider.kind ? active : null);
    }
  }

  /**
   * Forget the current candidates and clear every highlight — the cursor left
   * the canvas, a tool took over, or the hover setting was switched off.
   */
  clear(): void {
    this.ranked = [];
    this.offset = 0;
    this.lastCursor = null;
    for (const provider of this.providers) provider.highlight?.(null);
  }
}
