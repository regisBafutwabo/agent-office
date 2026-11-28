# Instructions for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) that work on Agent Office. People can read it too. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide. This file gives the rules that agents most often break.

## Project map

| Path | What it is |
|---|---|
| `web/` | The office page: `index.html`, `office.css` and the scripts in `web/js/` |
| `bridge/` | The Node server (`npm start`) |
| `desktop/src-tauri/src/` | The Mac app's server, in Rust |
| `plugin/`, `adapters/` | The hooks that coding agents use to report to the office |
| `tests/` | Browser tests (Playwright) |
| `scripts/`, `bridge/*.test.js` | Unit tests and tools |
| `docs/` | User documentation |

## Rules for code

1. **The scripts in `web/js/` share one global scope.** They load in the order that `web/index.html` lists them. Before you add a top-level name (`const`, `let`, `function`), search for it: `grep -rnw '<name>' web/js`. A duplicate name stops the page from loading. Do the same for a new CSS class in `web/office.css`.
2. **The two servers must do the same thing.** If you change `bridge/`, make the same change in `desktop/src-tauri/src/`, and the reverse.
3. **Add or update a test for each change.** Put browser behavior in `tests/*.spec.mjs` and server logic in a unit test.
4. **Use the same style as the code near your change.** Write comments that tell why, in plain words.
5. **Do not add dependencies, build steps or CDN scripts** unless the maintainer agrees first.
6. **Keep the security rules.** The office listens only on `127.0.0.1` by default. No user data leaves the computer. Hooks never block or change what an agent does. New `/api/` routes need the page key, like the others.

## Design tokens

The top of `web/office.css` defines the design tokens, for light and dark mode. Use them in the panels, cards, toasts and dialogs:

| For | Use |
|---|---|
| Colors | `--ink`, `--ink-2`, `--muted`, `--line`, `--panel`, `--panel-2`, `--panel-3`, `--accent`, and the status colors `--s-*` |
| Font family | `--font-d` (display), `--font-b` (body), `--font-m` (mono) |
| Font size | `--fs-*`, the type scale |
| Padding, margin and gap | `--sp-1` to `--sp-6` (4, 8, 12, 16, 24 and 32px) |
| Corner radius | `--r-sm`, `--r-md`, `--r-lg`. Each one has a comment that tells where to use it. |
| Shadows | `--e-1`, `--e-2`, `--e-raise` |
| Borders | `1px solid var(--line)` |

- Do not write a raw color, font size, spacing or radius value if a token fits. If no token fits, add a token, with its dark-mode value, and do not add a one-off value.
- `npm test` fails if `web/office.css` gets more raw values than it has now.
- The 3D scene (furniture, the city, agent colors) is art, not interface. These rules do not apply to it.

## Check your work

Run all of these. All must pass.

```bash
npm test
npm run test:e2e
(cd desktop/src-tauri && cargo test)
```

If you change something on screen, take a screenshot before and after the change.

## Words

- Write user documentation in Simplified Technical English. See [CONTRIBUTING.md](CONTRIBUTING.md#8-rules-for-documents).
- Write text in the office for a person, not a developer. Say what happens and what to do next. Do not show internal names, error codes or file formats if a plain description is possible.

## Branches

- Start from `main`. Name the branch `feat/<short-name>`, `fix/<short-name>` or `docs/<short-name>`.
- Send the pull request to `main`.

## Commits

- Write the first line in the imperative mood. Tell what changes for the person who uses the office, in plain words. Examples from this project:
  - `Let finished subagents leave the office`
  - `Sprint back to the desk when called from a break`
- Use 72 characters or fewer on the first line. Do not use prefixes such as `feat:` or `fix:`.
- If necessary, add a blank line and then tell what changed and why.
- Make one commit for one logical change.
- Do not add an AI attribution line, such as `Co-Authored-By`, unless your user's setup adds one. Do not invent one.

## Pull requests

- One pull request does one thing.
- Fill in every section of [the template](.github/pull_request_template.md): Why, What changed, Screenshots and How it was tested.
- In **How it was tested**, check only the boxes for the tests that you really ran. Write down what you did not test.
- Say which AI agent helped to write the change.
