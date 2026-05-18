# Contributing to Ponder

Thank you for considering a contribution to Ponder. Issues, discussions, and pull requests are welcome.

## Quick start

```bash
git clone https://github.com/anthropics/ponder.git
cd ponder
npm install
npm run typecheck   # must be clean before sending a PR
```

## Repo layout

- `src/agent/` — vision agent loop, browser bridge, recorder.
- `src/cli/` — `ponder` CLI, SDK entry point, postinstall.
- `src/mcp/` — Model Context Protocol server (stdio + HTTP).
- `src/bridge/` — localhost HTTP bridge auth/keys.
- `electron/` — desktop tray app that runs the bridge with macOS perms granted.
- `skills/ponder/` — Claude Code skill files synced into `~/.claude/skills/ponder/`.
- `docs/` — recipe, SDK, bridge docs.
- `examples/` — small end-to-end scripts.

## Coding conventions

- TypeScript strict mode (see `tsconfig.json`); typecheck must pass.
- Prefer editing existing files over creating new ones.
- Comments only when the *why* is non-obvious. Don't narrate what the code does.
- Stripe-style errors: surface a `PonderError` with `code`, `message`, `hint`, `docs_url`.

## Recipes are the public artifact

Recipes (`<id>.recipe.ts`) are the cross-process portable artifact. Codegen lives in `src/agent/recorder.ts:renderRecipeScript`. Keep the body inside `defineRecipe({ run })` as raw Playwright — no Ponder-specific wrappers — so a user can paste the body straight into a Playwright project.

## Testing

The bench in `bench/` is the canonical end-to-end harness. Add a new case under `bench/cases/<id>.md` when you change agent behavior, and confirm a run before sending the PR. Snapshot artifacts (PNGs, JSON) land in `bench/results/`.

## License

By contributing you agree your contribution will be licensed under the Apache License, Version 2.0 (see `LICENSE`).
