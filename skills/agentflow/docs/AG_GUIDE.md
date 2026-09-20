# Agentflow v8.2 — a guide for everyday use

English · [繁體中文](AG_GUIDE.zh-tw.md)

<a href="https://youtu.be/0dp_HnqX0ms"><img src="https://img.youtube.com/vi/0dp_HnqX0ms/maxresdefault.jpg" alt="Watch the Agentflow introduction on YouTube" width="640"></a>

Watch the introduction by clicking the image above.

Agentflow gives your AI assistant a project notebook. It keeps what you asked for, the decisions you made, progress, and the result together. When you return tomorrow or start a fresh conversation, the assistant has a place to pick up the work.

- **Start with a normal request.** Open your project in Codex or Claude Code, type `godev`, then explain what you want. You can use it for documents and everyday tasks as well as code.

- **Read the result in the notebook.** The assistant’s closing message points to the file. It is usually `.agentflow/devlog.md`.

- **Ask when you need help.** “How do I use the Agentflow skill for this task?” is often the quickest way to get an answer that fits your project. You do not need to memorize this guide.

## 1. Get ready

You need Codex or Claude Code and Node.js 18 or newer. Git is needed for version history, separate feature workspaces, and some installation methods. Your working folder can still use the notebook without being a Git repository; Agentflow will not create a repository for you.

Install the skill from a terminal:

```sh
npx skills add agfnow/agentflow
```

Choose the assistant you use and whether to install for this project or all your projects. Then start a new assistant session so it can load the skill. Claude Code also has a plugin installation route; see the [public README](https://github.com/agfnow/agentflow#install).

For Codex, the Agentflow maintainer recommends **`gpt-5.6-sol/low` as the most stable coordinator choice in their use**. This means model `gpt-5.6-sol` with reasoning effort `low`, running the main conversation and coordinating work. It is a project recommendation; your task and available models still matter. [OpenAI’s model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol) confirms that this model supports `low` effort.

If you want an installation check, ask your assistant to run `agf setup`. It reports what is available. `agf setup --fix` can add missing shell shortcuts after backing up the shell settings. An unavailable optional worker does not mean installation failed. If the assistant asks you to restart after installing hooks, restart once; hooks are the small integrations that record messages and check completion.

### Keep the skill up to date

If you installed with `npx skills add`, periodically run:

```sh
npx skills update agentflow
```

The current CLI updates by **installed skill name**. Use `agentflow` here; `agfnow/agentflow` is the source used by `skills add`. The source-style command `npx skills update agfnow/agentflow` is not the current name-based syntax. Add `-g` for a global installation, or run from your project with `-p` for a project installation. See the [Skills update instructions](https://github.com/vercel-labs/skills#skills-update).

For a weekly reminder-free update on macOS or Linux, ask your assistant to help set up **crontab**, the system’s task scheduler. For example, this runs every Monday at 9 a.m. for a global installation:

```cron
PATH=/absolute/node/bin:/usr/local/bin:/usr/bin:/bin
0 9 * * 1 /absolute/node/bin/npx --yes skills update agentflow -g -y >> /absolute/path/agentflow-update.log 2>&1
```

Replace the example paths with your actual Node.js directory and a writable log location before adding the entry with `crontab -e`. For a project installation, have the job enter that project and use `-p` instead of `-g`. Try the command once first, check the log afterward, and open a new assistant session after updates.

## 2. Give it your first task

In your assistant conversation, send:

```text
godev
Rewrite the welcome page so a first-time visitor can understand it.
Keep the existing links. Let me review the result before uploading it.
```

The assistant records your request, does the authorized work, checks it, and writes a reply. During work, you see short progress updates. At the end, open the notebook named in the closing message.

- **Starting with no task:** If the Ask is empty, a bare `godev` can reply “Development workflow ready.” Send your task afterward.

- **Resuming an unfinished task:** If the Ask already contains your request, `godev` reads it and continues. You can also say `continue` or `next` in an active session.

- **Writing directly in the notebook:** Add your request under the empty Ask at the bottom, save the file, then type `godev`. Keep completed requests and replies intact.

- **Changing direction:** Say what to change or stop. A follow-up question normally stays with the unfinished task. “Stop this task” cancels that work; asking for an explanation does not authorize an extra fix.

## 3. Read the notebook without learning its machinery

Think of each **Ask** as one conversation about a task. Its matching **Reply** contains the answer. Numbers such as `A-012` help you find the right pair.

- **STATUS**, at the top, shows the last recorded result, open work, and next step. Project settings live in `ag.json`; STATUS is a progress summary.

- **RUN** entries are short numbered progress notes. A **WIP** checkpoint, added during longer work after ten active minutes, tells you what is finished, happening now, and still to do.

- **[SUMMARY]** gives the result quickly. **[FINAL REPORT]** answers multiple requests in your original order and says which succeeded, failed, or remain limited, with the relevant checks.

- **Questions** contain an empty `- ans:` line when a decision is needed. Reply in chat or fill in that line, save, and ask the assistant to continue. If the notebook links to questions in a plan, answer in that linked file.

Already answered questions are checked when work resumes. A suggested answer is only a suggestion; leaving `ans:` empty does not approve it.

When the live notebook exceeds 1,000 lines, completed older rounds move unchanged to an adjacent archive. The current task stays in the live notebook. You can read both files later.

## 4. Choose how much help a task needs

You can normally describe the task and let the assistant choose. These controls are useful when you want a particular approach:

- **Keep a small task light:** `fast-lane Fix the spelling in README.md.` The main assistant handles this task itself. It skips the larger pipeline, delegation, new feature workspaces, and external review. Necessary checks, progress notes, and the assistant’s own review still happen. The mode ends with this task.

- **See a plan first:** “Make a plan and let me review it before implementation.” The assistant saves a plan and waits at that checkpoint.

- **Challenge a plan:** `threeways` or `3ways` asks for one independent critique and the main assistant’s response. It does not approve implementation.

- **Review finished work:** Add `cross-check` to request a separate read-only reviewer. “Fix the settings validation, then cross-check the result” is an example.

- **Use the full development process:** `ag` or `agentflow` requests requirements, a specification, implementation, and acceptance when `allow-ag` permits it. Use `all-in` to include every optional advisor too. This takes more work and can use more model calls.

- **Keep execution with the main assistant:** Say `no delegation`. That choice does not cancel required checks or independent review.

- **See exactly what changed:** Add `show-diff`. The answer gives a reason for each change and a readable diff: `-` lines were removed; `+` lines were added. This display request alone does not authorize edits.

Agentflow should build only what you asked for and use existing solutions where they fit. Relevant checks come with the work; repeating a passing test needs a reason. Nearby improvement ideas stay proposals unless you choose them.

## 5. Know when your approval matters

For ordinary work, a clear request authorizes the necessary steps. If you say “prepare this for my review; do not upload it,” the assistant should finish the local work and wait before uploading.

Changes that are hard to undo need clearer checkpoints. The plan describes the normal user journey, what must keep working, and concrete examples that will prove success. Its **Invariants** are the promises to preserve; its **Acceptance criteria** describe how you will know the result works.

- `Design Go: <7-hex-commit-prefix>` approves the exact saved plan for consequential work. The assistant supplies the identifier for you to use.

- `Result Go: <implementation commit>` approves delivery of the checked consequential result.

- Answering a plan’s questions and approving implementation are separate decisions.

<a id="auto-reply-for-this-batch-only"></a>

To reduce interruptions over routine choices, use `auto-reply: on`. If you normally keep it off, `keep-going` enables safe default answers for the current approved batch, then turns it off. State your desired final setting if you combine those controls.

Neither control supplies Design Go or Result Go. For an agreed task you want completed while you are away, `away: gates` authorizes those approvals after the required evidence passes. It does not expand the task, accept failed checks, or authorize new irreversible actions or external messages.

For example, for work whose scope you have already agreed:

```text
keep-going
away: gates
Finish the task described in this Ask, using safe routine defaults.
Supply Design Go and Result Go after the required evidence passes.
Return auto-reply to off when this task finishes.
```

## 6. Understand a review result

A `cross-check` reviewer looks at the saved implementation and reports:

- **Outcome:** Does the requested result work?

- **Minimality:** Could a part be deleted, combined, or replaced through reuse while still meeting the request?

- **Conformance:** Does the work follow the agreed scope and rules?

Each result is `PASS` or `BLOCKING`. `Minimality: BLOCKING` means a sufficient simpler solution exists. A plan’s **Minimality check** asks the same question before building. The main assistant also inspects the result itself, called the **host gate** in technical records.

Review depth is `narrow`, `targeted`, or `full`, depending on the change. Add `stronger` to raise it one level. Current passing checks can be reused; a deeper review does not automatically rerun every test. A changed implementation needs updated review evidence. Matching pipeline acceptance can satisfy the final review without a duplicate pass.

Routine informational writing may need only the main assistant’s inspection. Changes to operating instructions, behavior, or substantive evidence can need external review. You may say “Skip external review for this round” or use `skip-review: <reason>`; necessary tests, the assistant’s own review, and applicable approval checkpoints still remain.

## 7. Work on two features separately

A **feature stream** gives one feature its own folder and notebook. In a Git project, it uses a branch, which is a separate line of version history, and a worktree, which is another folder holding that branch’s files. Separate folders help two sessions avoid overwriting each other.

1. Send `new-feature: login-page` in the assistant conversation.

2. Agentflow creates the workspace and gives you a continuation command. Exit the current assistant, run that command in a normal terminal, then type `godev` in the new session.

3. Work in that feature’s notebook, normally under `.agentflow/features/login-page/`. The main project keeps a pointer to it.

4. When ready to bring the feature into the main project, say `merge-back` in the feature session. The assistant prepares, checks, and delivers the merge through the guarded workflow.

5. From the main project, use `cleanup:login-page` to remove the finished temporary branch and folder while keeping its notebook and artifacts. Cleanup may merge undelivered work first. `agf ditch login-page` is the separate, confirmed operation for abandoning unmerged work.

Ordinary notebook work also works without Git. A separate notebook for non-code conversation can be created without a branch, but `new-feature:` needs Git to create its feature workspace. A stream is not a security sandbox.

<details>

<summary>If a feature merge needs recovery</summary>

- `agf finish --prep` brings the main branch’s changes into the feature and stops before delivery. `agf finish --deliver` completes delivery only after the required closing records and checks pass.

- If preparation reports a conflict, it has already aborted the merge. Stay on the feature branch, ask the assistant to reconcile and commit the intended result, then retry `finish --prep`. Do not use `git merge --continue` after that refusal or skip to delivery.

- Dirty files, moved branch tips, mismatched folders, or conflicting records can stop delivery. Follow the reported recovery instructions; a refused merge is not a completed merge.

</details>

## 8. Change settings in plain language

Type `settings` to see the active values and available choices. To change one, send a line such as `lang: zh-tw`. The assistant validates and saves it in the applicable `ag.json`. You usually do not need to edit JSON yourself.

- **Language:** `lang: en` or `lang: zh-tw` controls AI-written replies, records, documents, comments, and commits. Your original messages stay as written. You can request another language for one deliverable.

- **Routine answers:** `auto-reply: on|off` controls safe default answers.

- **Development process:** `allow-ag: on|ask|off` permits the pipeline, asks first, or blocks it. Direct work remains available under all three settings. Typing `ag` does not override `off`.

- **Feature workspaces:** `streams: ask|always|off` controls how ordinary requests for separate feature work are handled. Explicit `new-feature:` still requests creation directly.

- **Worker families:** `cli-provider: on|off` permits available configured families or restricts workers to the family of your current assistant. Worker access depends on your installed tools and account.

- **Notebook location:** `target-doc: .agentflow/shop.devlog.md` requests a managed rename. It requires Git and moves the notebook and archive, then updates settings and forwarding links. Follow the forwarding note at the old location.

<details>

<summary>More settings and model choices</summary>

- `workspace-dir` sets the project-relative record folder, normally `.agentflow`. [Task artifact locations](../SKILL.md#task-artifact-locations) explains the notebook, feature, artifact, and queue paths.

- `ask-names: on|off` adds the asker’s name to new Ask headings or leaves it off.

- `metrics: off|on|auto|ccxray` controls local records and ccxray telemetry: `off` disables both, `on` keeps local records, `auto` uses healthy ccxray optionally, and `ccxray` requires it.

For an active external worker, run `node metrics.js ccxray-summary --task <Ask id> --role <stage> --project <name> --config <ag.json> --format devlog` for its RUN, then run it without `--role` before closeout for the Reply, and paste both outputs verbatim. The closeout total includes the coordinator when the host itself runs through ccxray (`ccxray claude`, `ccxray codex`, or `ANTHROPIC_BASE_URL` pointing at it); a `host_not_proxied` line means the host bypassed ccxray.

- `large-work-minutes` defaults to 120; valid values are 1–10080. It sets the workflow’s large-work time threshold.

- `completion-cleanup` defaults to `off`. When enabled, cleanup at session end can move completed, inactive supporting records older than 30 days to Trash. Active and still-needed evidence stays.

- `completion-cleanup-interval-days` defaults to 7; valid values are 1–365. It sets the interval between successful cleanup runs, independently of the 30-day age rule.

- The configuration uses `"schema-version": 7`. This is the settings format, separate from Agentflow’s v8.2 release number.

- `pipeline-roles` maps requirements, codewalk, explore, spike, spec, implementation, security-scan, acceptance, cross-check, and learn to a model tier or `off`. Disabling a required role makes the full pipeline unavailable.

- `external-workers` holds profiles with commands and model/effort choices for `best`, `better`, `basic`, and `cheap`. These are local labels, not universal model rankings. The main conversation’s model is selected in Codex or Claude; worker settings do not change it.

- Ask the assistant to help choose a setting such as `codex-default.basic: <model>/<effort>`. If you explicitly name a model that is unavailable, it must ask before replacing that model.

</details>

## 9. Get specialist help or run a prepared task list

For a larger job, you can ask an advisor to investigate a particular question. For example: “Use `advisors: requirements, codewalk, spec` to settle how this change fits the existing project.” Name the uncertainty you want answered. Advisor use still depends on `allow-ag`.

If you need a task queue, `make-plans` saves the plans and **stops before implementation**. After reviewing them, `run-plans` runs the existing queue. `run-looper` invokes the documented sequential runner. Each plan runs one at a time; a failed or changed plan stays available for inspection.

<details>

<summary>Advisor, worker, and queue reference</summary>

- **Direct route:** Clear, reversible work stays with the main assistant or a bounded worker when the handoff is useful.

- **Selected-advisor route:** Only advisors needed for a named material question are used. Available names are requirements, codewalk, explore, spike, spec, security-scan, acceptance, and learn.

- **Full-pipeline route:** Requirements, specification, implementation, and independent acceptance are required; existing projects also need discovery. Codewalk may satisfy discovery with a shared-coverage marker. `all-in` requests every optional advisor.

- **Blocked route:** The assistant reports the unresolved decision, missing capability, or failed check and continues any independent authorized work it can still do.

- Advisor names use exact lowercase spelling. Empty entries, a trailing comma, non-string values, and unknown names are rejected before any advisor starts. Duplicates are removed in typed order; execution still follows dependency-safe order. Selecting only requirements does not cancel later authorized implementation or verification.

- Workers use independent temporary Git clones with no remotes through `external-runner-v1`. The main assistant checks their changes before accepting them. A clone is not a security sandbox, and a successful worker exit is not proof that the task worked. Codex and Claude are the current supported families; arbitrary hosts and native subagent fallback are not promised.

- A review stage allows at most three worker starts; one failed preflight before a process starts does not count. Quiet output alone is not a hang. Your stop instruction takes priority, and canceled work must not restart without your permission.

- `agf-looper --tasks-dir <path>` selects a queue. Generated queues contain `plan-NNN.md` files and a `.queue-generation.json` record that detects changed plans. Handwritten queues use plan files and notebook completion evidence. Completed plans move to `planned/done/` only after verification.

- `--show-output` displays worker output; `--dump` saves it. Before `--reset`, check that related processes have stopped. Reset clears the stop state; a separate run resumes work. Plan workers cannot launch more workers or another Agentflow workflow. See the [looper reference](../references/looper.md).

</details>

## 10. Pick up work after an interruption

Open the same project and type `godev`. The assistant reads the current Ask, answers you already supplied, progress notes, and relevant project state before continuing. If something is unclear, ask: “What is finished, what is still open, and what should happen next?”

- **A worker stopped:** The assistant inspects the saved output and changes before accepting any result. Silence or exit code zero alone is not enough.

- **Settings are missing or invalid:** Ask it to explain the repair. Established settings must not be guessed from STATUS.

- **Skills seem to disagree:** Ask for `agf skills audit`. It lists discoverable skills and prepares a read-only assessment. The audit itself makes no edits or model calls; your assistant explains confirmed conflicts and possible remedies.

- **You only want local work:** Say so in the request. Without Git, completion is local. With Git, Agentflow normally commits meaningful work and pushes when a remote exists, unless your instructions limit delivery. It preserves unrelated edits and never force-pushes.

<details>

<summary>What the supporting records mean</summary>

- The notebook keeps what you asked, short numbered RUN events, decisions, and replies for recovery. Work split into several tasks also uses a tracker. New timestamps use machine-local `YYYY-MM-DD HH:MM:SS ±HHMM`, and RUN/WIP headings include their Ask number.

- WIP notes say **Finished**, **Running now**, **Still to do**, and **Next work action**. `Still to do: None.` means no work remains in that list. These notes describe progress; they do not certify success by themselves.

- New Codex Reply stamps use the active session’s latest recorded model and effort. Missing or conflicting evidence is labeled `codex/unknown`; Claude currently has no verified effort extractor. Old replies are not relabeled.

- Completion checks keep supporting metadata under the workspace’s `.tmp/`, leaving new Replies free of generated evidence links and hashes. These local ignored files do not travel with a clone. Missing or damaged evidence cannot count as a pass; restore trashed records if they are needed again.

- Archive growth no longer triggers the former 1 MiB closeout read limit. Corrected retries scan the archive in chunks, and unchanged verified retries reuse existing evidence. Archive history remains unchanged.

- For exact operational details, see [SKILL.md](../SKILL.md), the [script reference](../scripts/README.md), and the [closeout rules](../references/closeout.md). Evaluation results apply to the tested assistant, model, and environment; they do not guarantee every future task.

</details>
