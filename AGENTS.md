# AGENTS.md

## Repo
- Name: `VaultAPI`
- Purpose: Node/TypeScript API for Vault platform data, auth, and integration endpoints.
- Main code: `src/`
- Tests: `src/__tests__/`

## Core commands
- Install: `npm install`
- Dev: `npm run dev`
- Test: `npm test`
- Build: `npm run build`
- Start built server: `npm start`

## Work Prioritization
Before starting work, review repo memory together with the local mirror in `.agent-mirror`.

Use these sources to decide what to work on:
- `.agent-mirror/changelog.md` for the latest recent activity and likely active workstreams
- `.agent-mirror/git-summary.json` for structured recent commit and issue/PR linkage
- `.agent-mirror/issues` for current issue details
- `.agent-mirror/prs` for active and recent PR context
- repo memory files for longer-term plans, priorities, and constraints

Prioritize work by combining:
- items explicitly called out in memory
- recently active issues or PRs
- commits linked to open issues or PRs
- work that appears in both memory and the mirror

If memory and mirror disagree, treat memory as strategy and the mirror as current execution context.
Use GitHub/Linear primarily to post updates after work is complete; do not pull issue state from them when `.agent-mirror` already provides it.

## Guidance for agents
- Keep route and store changes narrowly scoped to the ticket.
- Maintain existing API behavior unless acceptance criteria require a contract change.
- Avoid editing `dist/` by hand; it is build output.
- Prefer adding/adjusting tests when changing route or store logic.

## Validation
- Run `npm test` for logic changes.
- Run `npm run build` before handoff when TypeScript files were modified.
