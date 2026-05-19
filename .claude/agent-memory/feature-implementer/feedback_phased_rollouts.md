---
name: Phased rollouts of large features
description: The user splits large features into numbered phases and gates each one on manual smoke testing
type: feedback
---

For large features (e.g. the Element Properties Inspector, ~5 phases), the user writes a `dev/plans/phase-*.md` document upfront that breaks the work into numbered phases. Each phase is independently mergeable and ends green (tests + lint + typecheck) before the next begins.

**Why:** The user said "it is hard for me in this instance to validate test driven development, so just use the branching testing checkpoint manual approving technique" — he wants small, verifiable units of progress that he can manually smoke-test in the browser before letting the next phase land. Skipping the phase boundary creates a too-large blob to validate.

**How to apply:**
- Always read the phase plan in `dev/plans/` first when starting work on something it covers. Don't reinvent the plan.
- Implement strictly within the named phase's scope — even if Phase N+1's work seems "right there." Note it but don't write it.
- Smoke tests for the phase are written in the plan itself; quote them verbatim in the handoff message so the user doesn't have to flip back to the plan.
- For phases the user explicitly says "no TDD," write tests alongside implementation in the same commit — they're still required, just not designed first.
- Branch names are spelled out in the plan (e.g. `feature/inspector-foundation`); use those exact names.
- Don't push or open PR at end of phase work. Stop at the "manual smoke test handoff" step and wait for the user's go-ahead.
