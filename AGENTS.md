# Notes for AI agents

Read this before changing Council or helping someone run it.

## What Council is

A local macOS web app. Two AI participants answer a brief separately, cross-review, converse for up to N turns, and produce one combined document. The person watches and edits everything live in their browser.

Each participant is a **seat** (`a` or `b`). A seat is a provider (`claude` or `chatgpt`), a model, and an effort level. Both seats can use the same provider.

The non-negotiable design choice: **Council uses the person's own subscriptions through official CLIs, never API keys.**

- Claude runs through Claude Code: `claude -p --output-format stream-json`.
- ChatGPT runs through OpenAI's Codex CLI: `codex exec --json`, signed in with a ChatGPT account.

## Helping a non-technical person get it running

Assume they only have the GitHub link and a Mac. Walk them through this, one step at a time:

1. Download `https://github.com/prtkc/council-ai/releases/latest/download/Council.zip`, unzip it, and move the folder to Documents.
2. Open Terminal (⌘ Space, type Terminal, press Return).
3. Type `zsh ` (with a trailing space), drag `Start Council.command` into the window, and press Return. This avoids macOS blocking an unsigned downloaded script, and works even if the file lost its executable bit.
4. Answer `y` if asked to download Node.js. `scripts/install-node.sh` fetches the official Node 26 build into `.runtime/node` and verifies its SHA-256. No admin rights are needed.
5. In the browser page, click **Install**, then **Sign in**, then **Test connection** for Claude, ChatGPT, or both.
   - **Install** runs `npm install --prefix .tools` for `@anthropic-ai/claude-code` or `@openai/codex`.
   - **Sign in** writes `.tools/sign-in-<provider>.command` and opens it in Terminal. It runs `claude auth login --claudeai` or `codex login`, which complete in the browser.
6. Start a run. If only one provider is ready, both seats default to it.

If you can run commands on their machine, `cd` into the folder and run `zsh "Start Council.command"`. Do not install tools globally or change their shell profile. Council finds tools in this order: already on `PATH`, `~/.local/bin`, Homebrew, then `.tools/node_modules/.bin`.

Requirements: macOS, Chrome or any browser, and a Claude subscription or a ChatGPT plan that includes Codex. Windows and Linux are not supported yet. The launcher is zsh and uses macOS's `open`, and Codex's sandbox settings assume macOS.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Claude shows signed in, but steps fail with "OAuth session expired" | `claude auth status` can report a stale login. Click **Sign in again**. |
| A step fails with "out of usage credits" or a limit message | Plan limit, or the model isn't in their plan, as with Fable on Pro. Pick another model or wait, then **Retry**. |
| ChatGPT shows not signed in after login | Codex may be signed in with an API key, which is rejected on purpose. Sign in again with ChatGPT. |
| Port 4317 is busy | `src/main.js` tries 4318 to 4327, and opens an existing Council instead of starting a second one. |
| No Chrome | It falls back to the default browser through `open <url>`. |

## Contributing changes

Improvements from anyone's agent are welcome, but they go through review. **Never push to `main`.** The maintainers decide what reaches `main`.

When your person asks you to change Council, or you suggest a change and they agree:

1. **Ask first.** Only make changes your person requested or approved. Before you publish anything, get their explicit yes.
2. **Branch.** Work on a new branch named `community/<short-topic>`, for example `community/windows-launcher`. Never commit to `main`.
3. **Keep it clean.** Don't include anything from `runs/`, `.tools/`, `.runtime/`, `dist/`, or personal details such as paths, emails, tokens, or prompts from their runs.
4. **Check it.** Run `npm test`. If you touched `src/providers.js` or anything about sandboxing, also run `npm run verify` and say so. Keep every rule in "Rules the code must keep".
5. **Push and propose.** Push the branch and open a pull request against `main` of `prtkc/council-ai`. Most people won't have write access to that repository, so fork it first (`gh repo fork prtkc/council-ai --clone=false`), push the branch to the fork, and open the pull request from there (`gh pr create --repo prtkc/council-ai --base main`).
6. **Describe it.** In the pull request, say what changed, why the person wanted it, and how you tested it. Mark anything you couldn't test.

If your person doesn't want to publish, leave the change on the local branch and stop there.

## Architecture

There are no npm dependencies. The server is Node's built-in `http`, and the frontend is plain ES modules, with no build step.

| File | Role |
| --- | --- |
| `src/main.js` | Entry point. Sets `PATH`, loads runs, picks a port on 127.0.0.1, and opens a Chrome `--app` window. |
| `src/server.js` | HTTP API, server-sent events, static files, and the workspace file browser. Enforces Host and Origin checks. |
| `src/council.js` | `Council` class: run state, scheduler, pause, stop, re-run, skip, edits, stale detection, and atomic saves. |
| `src/workflow.js` | Pure logic: step list, prompt builders, adversarial levels, end-of-reply marker parsing, and migration of older runs. |
| `src/providers.js` | Spawns the CLIs, parses their streaming JSON into activity and text events, strips API-key variables, and kills process groups. |
| `src/models.js` | Model and effort catalog. ChatGPT comes live from `codex debug models`. Claude is a hand-kept list. |
| `src/setup.js` | Tool detection, `.tools` installs, sign-in scripts, and `PATH` setup. |
| `public/app.js` | Run page: live cards, editors, collapse controls, and the document, files, and setup tabs. |
| `public/new-run.js` | Start page: tool setup, model and effort dropdowns, and the run form. |
| `public/markdown.js` | Small Markdown renderer. It escapes everything first and never renders raw HTML. |
| `Start Council.command` | zsh launcher. Finds Node 20 or newer, or offers to download it. |
| `scripts/` | Node download, zip packaging, and the real-CLI sandbox check. |

### Workflow

Steps run group by group. Steps in the same group run in parallel.

```
independent-a, independent-b    (each in workspace/drafts/<seat>, so they can't see each other)
revise-a, revise-b
turn-1 … turn-N                 (alternating, starting with firstSpeaker)
final-draft (drafter) → final-check (other seat) → final-apply (drafter)
```

- Every step's prompt is built just in time from the latest saved content. That is how edits flow downstream. The CLIs keep no session, and each call gets the full context.
- Each sent prompt is: ground rules + `---` + step prompt + `---` + `promptSuffix()`. The suffix asks for a final `[[SUMMARY: …]]` line. In turns, `[[AGREED]]` comes just before it. `parseOutput()` strips both markers.
- A finished step is **stale** if something it depended on changed after it started: an earlier group's output or prompt, the ground rules, or, for review steps, the adversarial level. Re-running a step archives it and every later step into `history`.
- A failed or stopped step blocks the run until the person retries, skips, or writes the answer themselves.

### Run data

`runs/<id>/run.json` is the source of truth, written atomically. `combined.md` is a copy of the latest document. `workspace/` is the agents' sandbox. `migrateRun()` upgrades runs from the version that had fixed `claude` and `chatgpt` seats. Keep it working.

## Rules the code must keep

1. **No API billing.** `cleanEnv()` removes `ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, and `CODEX_API_KEY` before spawning. Claude steps abort if the init event's `apiKeySource` isn't `none`. Codex is forced to `forced_login_method="chatgpt"`. Sign-in status only counts subscription logins.
2. **Agents stay in their folder.** Claude gets `--tools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch` with `--permission-mode dontAsk` and `./**` path rules, and no shell. Codex gets a custom permission profile: minimal read, write only to the project root (`project_root_markers=[]` pins it to the working directory), and no network for its shell. Never add `--dangerously-*` flags. After touching `providers.js`, run `npm run verify`.
3. **Local only.** The server binds `127.0.0.1` and rejects foreign `Host`, `Origin`, and cross-site fetch metadata. Mutating requests must be `application/json`. The workspace file API resolves real paths and refuses symlinks and `..`.
4. **Untrusted text stays inert.** Model output, web content, and files are escaped before rendering. Prompts wrap the other participant's text in tags and say it is material, not instructions.
5. **User edits win.** Don't overwrite something the person edited. Mark dependents stale instead.

## Changing things

- **Adding a Claude model:** add it to `CLAUDE_MODELS` in `src/models.js`. The Claude CLI has no model-list command. ChatGPT models need no change.
- **Changing what a phase asks:** edit `buildPrompt()` in `src/workflow.js`, and keep the marker conventions.
- **A new CLI event type:** extend `createClaudeParser` or `createCodexParser`, and add a case to the parser test.
- **The interface:** `public/` is served as-is with a strict CSP (`script-src 'self'`). Don't add inline scripts, CDN links, or innerHTML of unescaped strings.

## Testing

```bash
npm test
```

Offline tests for the scheduler, prompts, parsers, migration, setup, and server guards. They take about a second.

```bash
COUNCIL_CLAUDE_BIN="$PWD/test/fake-claude.js" COUNCIL_RUNS_DIR=/tmp/council-test COUNCIL_NO_OPEN=1 npm start
```

Runs the full interface with a stand-in for Claude that uses no plan limits. Make `test/fake-claude.js` executable first.

```bash
npm run verify
```

Real CLIs. Sends one short prompt each, and checks that neither can read or write outside its folder.

Environment variables: `COUNCIL_PORT`, `COUNCIL_RUNS_DIR`, `COUNCIL_TOOLS_DIR`, `COUNCIL_CLAUDE_BIN`, `COUNCIL_CODEX_BIN`, `COUNCIL_NO_OPEN`, and `FAKE_CLAUDE_DELAY_MS`.
