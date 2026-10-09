# gh-monitor

One view of every GitHub pull request you have in flight, from checks and review through merge to the published release. It is a [mod](https://code.claude.com/docs/en/plugins/mods/overview) (a TypeScript hooks module), so it draws a status line, a band above the prompt, and toasts, and it never talks to the model unless you turn that on.

Each PR walks one pipeline, in plain words:

```
checks -> review -> merged (any route) -> release -> published -> (offered) deploy-repo bump
```

It replaces the Release Ticker that used to live in `git-tooling`, and it follows merges that ticker could not: a PR merged in the GitHub UI, a manual release dispatch, a release already running.

## What it looks like

<!-- CAPTURE -->

## How it starts watching

Nothing to configure. It arms itself from what you and Claude do:

1. **A PR a `gh` command or URL touches.** `gh pr create`, `view`, `checks`, `merge`, `ready`, `edit`, `comment`, `review`, a PR URL in the output, or a `git push` of a branch that has an open PR.
2. **`ci-watch` reporting `MERGED`.** The `git-tooling` `ci-watch` skill's merge event hands the PR to the release stage.
3. **You typing "merged".** Merge in the GitHub UI, then say `merged` (or `I just merged`, optionally with `#12` or a PR link). It finds the PR and starts the release stage.
4. **A release dispatch or watch.** `gh workflow run release.yml`, `gh run watch` on a release run, `gh release view`/`list` right after a run, or the `release-watch` skill.
5. **Commands.** `/watch-pr <number | owner/repo#N | URL>` and `/watch-release <owner/repo> [--pr N | --tag vX]`.
6. **Optional sweep.** With `sweepRepos` set, release runs that start in those repos are picked up even if you did not start them.

Watches survive `/clear`, `/reload-plugins` and a restart of the same session.

## What the stages say

Each line reads `<repo> #<pr> · <step>/<total> · <what it is waiting for>`.

| While | It says |
|-------|---------|
| Checks | `checks running 3/7`, `checks failing: lint, test`, `checks passed` |
| Review | `waiting for review`, `changes requested`, `merge conflict`, `approved, ready to merge` |
| Release workflow | `waiting for workflow to start`, `workflow queued`, `workflow running 1m 20s` |
| Tag | `workflow done, waiting for tag` |
| GitHub release | `tagged v1.2.3, waiting for GitHub release` |
| Image / chart | `v1.2.3 released, waiting for image + chart` |
| Done | `v1.2.3 published` |

The release steps are always named **workflow, tag, GitHub release, image / chart**, in the status line, the band, the toasts and here. The image and chart steps only exist for a repo that publishes a matching `ghcr.io` package, decided when the release watch starts.

### Nothing to do

It says so instead of waiting out the timeout:

| Situation | Message |
|-----------|---------|
| The repo has no checks | `no checks configured` |
| PR closed without merging | `closed without merging` |
| Merged with no `semver:major`, `semver:minor` or `semver:patch` label | `merged · no release expected (no semver label)` |
| Merged into a branch other than the default | `merged into dev · no release expected` |
| The repo has no release workflow | `merged · no release workflow` |
| The workflow ran but cut no version | `workflow ran, cut no version` |
| No release run ever started | `release workflow never started` |

Failures and give-ups are named too: `release workflow failed`, `tagged v1.2.3, no GitHub release`, `gave up after 20 min (tag)`.

## Where it shows

- **Status line.** One short line, or a count when several things are in flight (`3 PRs · 1 failing · 2 releasing`). Claude Code adds the ` ⚠ gh-monitor: ` prefix itself; the text is sized to fit an 82-column terminal with it. It clears when nothing is live.
- **Band above the prompt.** One row per item, worst first (failing, deploy offers, releasing, checks running, in review, done). It fits the terminal width and scrolls when there are more rows than room. Terminal and desktop only.
- **Toasts.** For failed checks, changes requested, a merge, and every release outcome. Not for arming, running checks, or approvals.
- **`/gh-monitor`.** Opens a pane with everything, including finished items. `/gh-monitor stop <id|all>` drops watches.

## Deploy hand-off (optional)

Set `deployRepos` and, once a release is fully published, a toast and a `[ bump ]` button on the band draft a request such as:

```
Bump apps/earmark/helmfile.yaml in jedwards1230/homelab-k8s to earmark v0.47.9 (image ghcr.io/jedwards1230/earmark:v0.47.9, chart 0.47.9) and open a PR for review. Don't merge it.
```

It goes into your prompt box. You read it and press enter; it is never sent for you. The offer lapses after an hour.

## Configuration

All keys are optional. Set them with `/plugin configure`, or from the shell (use the plugin id `claude plugin list` shows). `configure` saves every value as a string, so list several entries comma-separated:

```bash
echo '{"timeoutMin": "30", "deployRepos": "jedwards1230/earmark=jedwards1230/homelab-k8s:apps/earmark/helmfile.yaml"}' \
  | claude plugin configure gh-monitor@jedwards1230-plugins --values-stdin
```

| Key | Default | Meaning |
|-----|---------|---------|
| `releaseWorkflow` | `release.yml` | Workflow file under `.github/workflows/` that cuts releases. A repo without one is reported as having none. |
| `registry` | `ghcr.io` | Registry for the image/chart steps. Only `ghcr.io` is read; anything else drops those steps. |
| `floatingTagRepos` | *(empty)* | `owner/repo:tag` entries for repos that release only when a workflow is dispatched. Merges there wait for the dispatch (`dispatch release.yml to move v1`), and a toast warns when the tag was not moved. |
| `timeoutMin` | `20` | Hard stop for a release watch, in minutes after the merge. |
| `pollSec` | `30` | How often GitHub is queried while something is watched (minimum 10). |
| `deployRepos` | *(empty)* | `owner/app=owner/deploy-repo:path/in/repo`. Entries that don't parse are ignored. |
| `sweepRepos` | *(empty)* | `owner/repo` list whose in-progress release runs are picked up automatically. Empty is off. |
| `semverLabelGate` | `true` | On: a default-branch merge waits for a release only when the PR has a `semver:*` label. Off: every merge waits for a release run. |
| `nudge` | `false` | On: one short line per merge, release outcome and failed-checks event is added to your next prompt so the model knows. |

Start a new session after installing or changing configuration.

## Token-neutral

By default the mod only draws a status line, a band, a pane and toasts. Nothing is added to the conversation, no model calls are made, and `gh` tool results are handed back untouched. `nudge` is the one opt-in exception, and it only attaches to a prompt you typed yourself.

## Requirements

- `gh`, authenticated. Reading a private `ghcr.io` package also needs the `read:packages` scope; without it the image/chart step is skipped rather than failing.
- A Claude Code version that loads mods. Start a new session after installing.

## Migrating from the Release Ticker

The Release Ticker moved here from `git-tooling` (2.0.0). Enable `gh-monitor`, and re-enter `releaseWorkflow`, `registry`, `floatingTagRepos` and `timeoutMin` under it; the keys kept their names but saved values do not carry across plugins. Remove them from `git-tooling` if they linger.

The `ci-watch` and `release-watch` skills stay in `git-tooling`, unchanged.

## Tests

Logic and rendering are tested against fixture `gh` output under `tests/` (`claude plugin test plugins/gh-monitor`), which CI runs.
