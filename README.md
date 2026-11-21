# Council

**Have Claude and ChatGPT work on a question together, then hand you one combined document.**

Council is a small Mac app that runs in your browser. You give two AI models a topic, and they:

1. **Work separately:** each writes its own answer, without seeing the other's.
2. **Review each other:** each critiques the other's answer and revises its own.
3. **Talk it through:** they message each other directly, for as many turns as you allow.
4. **Write one document:** one drafts a combined document, the other checks it, and the first applies the fixes.

You watch every step live, and you can pause, edit anything either model wrote, and re-run from any point.

It uses the **Claude and ChatGPT plans you already pay for**, through their official command-line tools, not API keys. You need a Claude subscription, a ChatGPT plan that includes Codex, or both. With only one, the model works against a second copy of itself.

> Council is an independent project. It is not made by or affiliated with Anthropic or OpenAI.

---

## Get started (no technical knowledge needed)

**You need:** a Mac, and a Claude or ChatGPT subscription.

1. **Download:** [Council.zip](https://github.com/prtkc/council-ai/releases/latest/download/Council.zip). Double-click it to unzip, and move the **Council** folder to Documents.
2. **Open Terminal:** press ⌘ Space, type `Terminal`, and press Return.
3. **Start Council:** type `zsh` and a space, drag **Start Council.command** from the Council folder into the Terminal window, and press Return.
4. **If it asks to download Node.js, type `y`.** This is a one-time download of about 50 MB into the Council folder. It doesn't need your password.
5. **Set up in the browser:** Council opens a page. Under **Claude** or **ChatGPT**, click **Install**, then **Sign in**, and follow the login steps. Then click **Test connection**.
6. **Start a council:** pick the two models, type your question, and click **Start council**.

Keep the Terminal window open while you use Council. To start it again later, repeat step 3.

**Why not just double-click?** Council isn't signed by Apple, so macOS blocks it from the internet the first time you double-click. Steps 2–3 avoid that. Double-clicking also works if you allow it under **System Settings → Privacy & Security → Open Anyway**.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "Not signed in" after signing in | Wait a few seconds, or click **Sign in again**. |
| **Test connection** says the login expired | Click **Sign in again**. |
| A step fails with a usage or limit message | Your plan's limit is used up. Wait for it to reset, then click **Retry** on that step. |
| "Fable … out of usage credits" | Your plan doesn't include that model. Pick another one. |
| The browser page doesn't open | Go to `http://127.0.0.1:4317` in your browser. |
| Install fails | Check your internet connection and click **Try again**. |

### Let your AI set it up for you

Paste this into Claude, ChatGPT, or any AI assistant:

```text
I want to use Council, a free Mac app that has Claude and ChatGPT work on a question together and then combine their work into one document: https://github.com/prtkc/council-ai

Please set it up for me as quickly as possible. First read the setup guide at https://raw.githubusercontent.com/prtkc/council-ai/main/AGENTS.md.

If you can run commands on my Mac, use its "Fast setup" section. In one message, tell me everything you will do and ask me once for permission to do all of it. Then do it all without stopping to ask again. The only thing I'll do myself is sign in to Claude and ChatGPT in my browser. Never ask for my passwords.

If you can't run commands, give me every step at once as a short numbered list, from the section "Helping a non-technical person get it running".

If I later ask you to change or improve Council, follow the "Contributing changes" section of that file: make the change on a new branch, show me what changed, and only open a pull request after I say yes.
```

---

## What you can control

- **Models and effort:** each participant can be any available Claude or ChatGPT model, with its own effort level, from Low to Max (Ultra on some ChatGPT models). Claude vs Claude and ChatGPT vs ChatGPT work too.
- **Prompts:** give both the same starting prompt, or a different one each.
- **Adversarial level:** from Collaborative to Ruthless. You can change it during a run.
- **Conversation length:** set the maximum number of turns. They stop early if both agree nothing is left to discuss.
- **Editing:** every prompt, answer, the ground rules, the final document, and the files in the run's folder can be edited. Steps that haven't run yet use your edits. Steps that already ran are flagged so you can re-run them.
- **Viewing:** answers stream in live, with each model's web searches and file changes. Each block has a one-sentence summary, and **Collapse all** tidies the page.
- **Continue the work:** when a council finishes, a chat box appears at the bottom. Ask any Claude or ChatGPT model to build on the whole output, for example to turn the combined document into a Google Doc. It can edit the run's files. Tick **Use my connected apps** to let it use apps connected to your Claude or ChatGPT account, such as Google Drive or Gmail.
- **Speed:** while a run is going, **Hurry up** switches later steps to low effort and short replies, and shortens the conversation. Click it again to go back to normal. If one step is taking too long, **End and continue** stops it, keeps what it has written so far, and moves on.

## Playgrounds

A playground puts several agents in one room. Click **New playground** and start from a software team, an open debate, or a blank canvas.

- **Build your team on a canvas:** click empty space to add an agent, drag agents to arrange the room, and click one to set its name, role, model, effort, and color. Presets include manager, product manager, designer, coder, tester, red teamer, and debate characters.
- **Project mode:** a head agent speaks first, plans the work, and decides who does what. Agents hand off to each other, and the floor returns to the head when someone hands it back, or after a set number of turns. Everyone shares one workspace folder, so agents can write real files. The head ends the project when the brief is met.
- **Open conversation:** agents talk in character, with no project. Choose who speaks next: **Speakers choose** (each picks who answers, and anyone left out too long gets pulled in), **Round robin**, or **Random**.
- **Join in:** post a message as **You** at any time, to everyone or to one agent. You can also pause, end a turn early with **End turn**, hurry the team with **Hurry up**, stop a speaker, edit any message, re-run from any point, and change an agent's role mid-run.
- **Replay:** after or during a run, click **Replay** to watch the conversation unfold on the canvas. Speech bubbles pop up over each speaker, with an arrow to whoever they're addressing, while the chat timeline fills in on the right. You can play, pause, step forward and back, scrub, and set the speed from 0.5× to 4×.
- **Summary size:** one switch sets **Small**, **Medium**, or **Large** summaries for every bubble and message.

## Where your work is saved

Everything stays on your Mac, in the Council folder:

- `runs/<run id>/run.json` has every prompt, answer, working step, and earlier attempt.
- `runs/<run id>/combined.md` is the final combined document.
- `runs/<run id>/workspace/` is the folder the models work in.
- `playgrounds/<id>/playground.json` holds each playground's agents and messages. Its `workspace/` holds the team's files.

## Safety

- The app only accepts connections from your own Mac, and rejects requests from websites.
- API keys are removed before either tool starts, so runs always use your subscription.
- Connected apps such as Google Drive are off, except in the follow-up chat when you tick **Use my connected apps**.
- Each model can only read and write files inside its run's folder. Claude has file and web tools but no shell. ChatGPT, through Codex, has a sandboxed shell with no network access, plus web search.
- Text from the other model and from web pages is treated as material to evaluate, not as instructions.

---

## For developers

Requires macOS and Node.js 20 or newer. There are no npm dependencies.

```bash
npm start
```

```bash
npm test
```

```bash
npm run verify
```

```bash
npm run package
```

`npm start` serves the app on `127.0.0.1:4317` and opens a Chrome app window. `npm test` runs the offline tests. `npm run verify` sends one short prompt to each real CLI to check the folder limits. `npm run package` builds `dist/Council.zip` without your runs or installed tools.

See [AGENTS.md](AGENTS.md) for the architecture, the rules the code must keep, and how to help a non-technical user get it running.

**Contributing:** improvements are welcome as pull requests from a `community/<topic>` branch. Nothing is pushed straight to `main`. The steps are in AGENTS.md under "Contributing changes".
