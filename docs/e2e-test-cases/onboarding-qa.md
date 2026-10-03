# Test cases in Jittle Lamp: a guide for QA engineers

This guide takes you from your first test case to reviewing its runs. A test case is a list of plain-language steps. An AI agent follows the steps in a real browser, checks your checkpoints, and records the whole session as evidence, the same kind of evidence you already review in Jittle Lamp. When the agent has done a step once and a later check confirms it worked, Jittle Lamp saves the step as a script. Later runs replay the script without the agent, which makes them faster and cheaper.

## 1. Before you start

Ask an organisation admin for these (Settings → Test cases):

- **An environment** for the app you test, for example `pcf-uat`. It has the base URL, shared variables such as `PARENT_URL`, the runner pool that can reach it, and agent instructions such as "never delete existing records".
- **A credential profile** for each account you log in with, for example `PCF_HQ_ADMIN`. You only ever see the profile name and the username. Passwords are typed into the page by the runner itself; you and the AI never see them.
- **A model key** (Settings → AI model). Runs are blocked until one is configured.
- **A role** with the test-case permissions (QA Engineer by default).

Admins and operators setting up the backend, runners and integrations: see [deployment.md](deployment.md).

## 2. Write a case

Open **Test cases** and press `c` (or **New case**). Give the case a title, then add steps. Each row is one step: a type chip, then the instruction.

| Type | Use it for | Example |
| --- | --- | --- |
| **Open** | Go to a page. Paths are relative to the environment's base URL | `/login` |
| **Act** | One thing a user does | `open the account menu and choose "Sign out"` |
| **Assert** | One thing that must be true on the screen. Never an action | `the login form shows an empty Email field` |
| **Wait** | Something that takes a while to appear | `the report has finished generating` |
| **Login** | Sign in with a credential profile | `Login · profile: PCF_HQ_ADMIN` |
| **Extract** | Remember a value for later steps | `Extract · orderId: the order number in the header` |
| **Screenshot** | Keep a picture in the evidence | `invoice after payment` |
| **Note** | A remark for reviewers. It doesn't run | `Covers PCF-1234` |

Shortcuts in the editor:

- `/` or `[` at the start of a row picks a step type or a macro (`Login`, or one your team created).
- `{` inserts a variable, `@` a credential or a file.
- `#` on an empty row starts a checkpoint heading.
- `Enter` adds a row of the same type. `Tab` changes the type.
- `⌘/` disables a row without deleting it. `⌘D` duplicates it.
- `⌘Enter` runs the case.

Group your asserts under **checkpoints**. A checkpoint is a heading such as "Logout returns to the login page". Reports and the run page group results by checkpoint.

**Write steps the way the agent sees the page.**

- One intent per step. "Click Save, then open the list" is two steps; the editor offers to split it for you.
- Name controls by their visible label, never a CSS selector. When the editor underlines `#submit-btn`, it suggests the label seen in the last run, for example `button "Save"`.
- Make asserts specific. "It works" can't be checked; "the student list shows E2E Ann with level K1" can.
- Aim for 3 to 15 steps. Repeated sequences belong in a macro (ask an admin, or create a draft macro).
- Never type a password or OTP into a step. Use `[Login: PROFILE]` or `{cred:PROFILE.field}`; the editor rejects literal secrets.

The **Text** toggle shows the same case as a document. You can paste a list of steps copied from a ticket into one row; the editor splits it into rows.

## 3. Run it

Press **Run** and pick the environment. The run joins your organisation's queue.

- If someone already requested the same case, version, environment and params, you **attach** to their run instead of starting a second one. Within a couple of minutes after it finishes, you get the finished run unless you choose **Run again (force)**.
- `queued · #2 of 3` shows your place in the queue and the estimated start. `NO_RUNNER` means no runner of the environment's pool is online. Tell whoever looks after the devbox runner.

While the run executes, the step list fills in live, with a small screenshot after each step.

## 4. Review the run

The run page has two sides.

**Left: the steps.** Each step shows its status, how it ran and its duration and cost. A step can run in one of three ways:

- **agent**: the AI did it.
- **replayed**: the saved script did it, with no AI call.
- **hand-off**: the script stopped working because the app changed, so the AI finished the step and the script was re-recorded.

**Right: the evidence.** The video, actions, requests and logs, as with any recording. Click a step on the left: the video jumps to it, and the timeline shows only what happened during that step.

The run has two results:

- **Passed / Failed** is about the app. A failed assert shows what you expected next to what the agent observed, with a screenshot.
- **Blocked** means the test couldn't decide: a missing credential, an app that didn't answer, the AI being unsure. The reason is shown first. Blocked runs don't count as failures.

The case page shows the averages of the last ten runs: pass rate, flaky rate, duration, cost and model calls.

## 5. Scale up

- **Import** (`Test cases → Import`): a document of many cases, a `.feature` file (Given/When become Act, Then becomes Assert, Examples become a dataset), CSV or XLSX with a column mapping, or Jira issues by JQL. Imported and AI-generated cases land in the **Review queue**. There, `a` approves, `x` rejects with a reason and `e` edits.
- **Duplicate** (`d`): copy a case with find and replace, for example `HQ_ADMIN` → `BRANCH_ADMIN`. Unchanged steps keep their saved scripts, so the copy replays on its first run.
- **Datasets**: one case, many rows of parameters. Each row is a variant run.
- **Tags** with namespaces (`team:qa-pcf`, `module:enrolment`, `prio:p1`) group the library in the sidebar. **Saved views** keep your filters.
- **Suites** group cases for a CI pipeline. A pipeline runs a suite with `jl-e2e run --suite <id> --wait --junit out.xml` (see `deploy/ci/`). Failed cases fail the job, and blocked cases show as skipped. Add `--fail-on-blocked` to fail on those too.

## 6. Working on your machine

The `jl-e2e` CLI runs the same transcripts locally, with a visible browser:

```bash
jl-e2e env pull pcf-uat                     # writes .env.e2e with the environment and empty credential lines
jl-e2e config --env-file .env.e2e           # what will be used, secrets masked, and where each value comes from
jl-e2e run cases/logout.transcript.md --env-file .env.e2e --headed
```

In a headed run, a shield covers the page while the agent works. If you click or type, the run pauses until you press **Resume**. Nothing you do while it is paused is recorded as a step.

`jl-e2e export --case TC-0412 e2e/cases` and `jl-e2e push e2e/cases/logout.transcript.md` move cases between files and the library. Push matches cases by `Key`, then by title.

## 7. When something looks wrong

| You see | What to do |
| --- | --- |
| Lint `undeclared variable {email}` | Declare it as a case param (the fix button), or add it to the environment |
| `MISSING_CREDENTIAL credential('PCF')` | The profile name doesn't exist in the environment. Pick it with `@` instead of typing it |
| An assert is `INCONCLUSIVE` | Say exactly what must be visible. Use `[Wait]` for content that loads slowly |
| Every run uses the agent, never replays | Each Act needs a later Assert or Wait that passes. Unverified steps are never saved |
| A replayed step keeps handing off | The UI changed. The step is re-recorded on success; clear its script (Scripts tab) if it keeps failing |
| A run behaves differently from your manual test | Open the step in the viewer: video, requests and console show what the agent saw |
