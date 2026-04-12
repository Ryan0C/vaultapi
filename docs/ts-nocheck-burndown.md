# VaultAPI `@ts-nocheck` Burn-Down Plan

## Goal

Remove `@ts-nocheck` incrementally while keeping each change small and reviewable.

## Current baseline

- Guardrail: `npm run check:ts-nocheck`
- Baseline file: `.ts-nocheck-baseline`
- CI gate: `.github/workflows/quality-minimum.yml`

## Milestones

1. Runtime edge routes first (low coupling)
- Completed: `src/routes/worldInvites.ts` (`@ts-nocheck` removed).
- Next targets: `src/routes/commands.ts`, `src/routes/vendors.ts`.

2. Request-heavy API routes
- Targets: `src/routes/auth.ts`, `src/routes/uploads.ts`, `src/routes/packs.ts`.
- Approach: replace broad `any` request usage with narrow local parsing helpers.

3. Store/service boundaries
- Targets: `src/stores/worldStore.ts`, `src/stores/itemsPacksStore.ts`, `src/services/vaultStore.ts`.
- Approach: add typed interfaces at call boundaries before deep internal cleanup.

4. Test files
- Targets: `src/__tests__/api.test.ts`, `src/__tests__/auth.test.ts`.
- Approach: remove suppression after runtime surfaces are typed, then tighten test helpers.

## Rules

- Do not increase `.ts-nocheck` count.
- Prefer local typed adapters over large refactors.
- Keep each PR to one runtime file removal when possible.
