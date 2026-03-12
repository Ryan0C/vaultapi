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

## Guidance for agents
- Keep route and store changes narrowly scoped to the ticket.
- Maintain existing API behavior unless acceptance criteria require a contract change.
- Avoid editing `dist/` by hand; it is build output.
- Prefer adding/adjusting tests when changing route or store logic.

## Validation
- Run `npm test` for logic changes.
- Run `npm run build` before handoff when TypeScript files were modified.
