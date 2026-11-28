# Contributing to Agent Office

Thank you for your help. This guide tells you how to send a change.

> **Important:** Send all pull requests to the `main` branch.

## 1. Before you start

- For a large change, open an issue first. Tell us what you want to change and why.
- For a small fix, you can open a pull request immediately.
- Keep each pull request small. One pull request must do one thing.

## 2. Set up your computer

You need these tools:

| Tool | Version | Used for |
|---|---|---|
| Git | Any recent version | All changes |
| Node.js | 18 or later | The office and the bridge |
| Rust | Stable | The desktop app only |
| Claude Code | Any recent version | Tests with live agents |

Do these steps:

1. Fork the repository on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/<your-name>/agent-office.git
   cd agent-office
   ```

3. Add the main repository as `upstream`:

   ```bash
   git remote add upstream https://github.com/regisBafutwabo/agent-office.git
   ```

4. Install the packages:

   ```bash
   npm install
   ```

5. Start the office:

   ```bash
   npm start
   ```

6. Open <http://localhost:4747/?demo> in a browser. You see agents that are not real.

To use live agents, install the hooks. See [Quick start](README.md#quick-start) in the README.

To work on the desktop app, install Rust. Then see [Build the Mac app](INSTALL.md#from-source). To run the app while you work on it, run `npm run dev` in `desktop/`.

## 3. Make a branch

1. Get the latest `main` branch:

   ```bash
   git fetch upstream
   git checkout -b <branch-name> upstream/main
   ```

2. Give the branch a short name that tells what it does. Examples:
   - `fix/stuck-subagents`
   - `docs/install-steps`
   - `feat/<short-name>`

## 4. Make your change

- Use the same style as the code near your change.
- The office page is in `web/`:
  - `web/index.html` has the markup.
  - `web/office.css` has the styles.
  - `web/js/` has the scripts. They share one scope and load in the order that `web/index.html` lists them. A script can use a function from a later script only after all scripts have loaded. If you add a script, add it to the list in `web/index.html`.
- The browser tests are in `tests/`.
- The Node bridge is in `bridge/`.
- The desktop app server is in `desktop/src-tauri/src/`. It is written in Rust.
- If you change the bridge, also change the Rust server. The two servers must do the same thing.
- Add or update tests for your change.

## 5. Test your change

1. Run the unit tests:

   ```bash
   npm test
   ```

2. Run the browser tests. Before the first run, install Chromium for Playwright:

   ```bash
   npx playwright install chromium
   npm run test:e2e
   ```

3. If you changed the desktop app, run its tests:

   ```bash
   (cd desktop/src-tauri && cargo test)
   ```

4. If you changed the hooks, try them in one session:

   ```bash
   claude --plugin-dir ./plugin
   ```

5. If you changed the office, open it in a browser. Check your change with `?demo` and with live agents.
6. If your change is visual, take a screenshot before and after the change. Add them to your pull request.

All tests must pass before you open a pull request. CI runs the same tests on each pull request. CI also does these checks:

- **Secret scan.** gitleaks scans the full git history. If it finds a secret, remove the secret and rotate it. To scan on your computer, run `gitleaks git .`.
- **File size.** A file that you add or change must be smaller than 1 MB. Files in `web/cities/` are an exception. Do not commit videos or large images. Drag them into a comment on a GitHub issue or pull request, and then use the `user-attachments` link.

## 6. Commit your change

- Write the first line of the commit message in the imperative mood. Examples from this project:
  - `Let finished subagents leave the office`
  - `Coffee cups at the coffee bar`
- Keep the first line short. Use 72 characters or fewer.
- If necessary, add a blank line and then more text. Tell what changed and why.
- Make one commit for one logical change.

```bash
git add <files>
git commit
```

## 7. Open a pull request

1. Push your branch to your fork:

   ```bash
   git push -u origin <branch-name>
   ```

2. On GitHub, open a pull request.
3. Set the **base** branch to **`main`**.
4. Fill in the pull request template:
   - Why
   - What changed
   - Screenshots, before and after, for visual changes
   - How you tested it
   - Whether an AI agent helped, and which one
5. Wait for a review. The maintainer must approve each change.
6. If the reviewer asks for changes, push new commits to the same branch.

## 8. Rules for documents

Write all documents in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/). These rules make the text easy to read for all people, also for people whose first language is not English.

- Use short sentences. Use a maximum of 20 words in an instruction. Use a maximum of 25 words in a description.
- Use the active voice.
- Write one instruction in each sentence.
- Use simple words. Use one word for one meaning.
- Use the same term for the same thing every time.

## 9. AI coding agents

You can use AI coding agents. [AGENTS.md](AGENTS.md) gives them the rules of this project. Most agents read it automatically. Claude Code reads it through `CLAUDE.md`.

- You are responsible for each line that you send, also for lines that an agent wrote.
- In the pull request, say which agent helped.
- An AI attribution line in a commit, such as `Co-Authored-By`, is optional.

## 10. Security and privacy

- The office must listen only on `127.0.0.1` by default.
- Do not send user data out of the computer.
- Hooks must not block or change what an agent does.
- Do not commit tokens, keys or other secrets.
- If you find a security problem, do not open a public issue. Report it privately. See [SECURITY.md](SECURITY.md).

## License

When you contribute, you agree that your work uses the [MIT license](LICENSE) of this project.
