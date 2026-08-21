# dsh-gitflow

[![CI](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/ci.yml/badge.svg)](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/ci.yml)
[![Latest DSH compatibility](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/dsh-compatibility.yml/badge.svg)](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/dsh-compatibility.yml)
[![Release](https://img.shields.io/github/v/release/lonelymoon87/dsh-gitflow)](https://github.com/lonelymoon87/dsh-gitflow/releases/latest)
[![License](https://img.shields.io/github/license/lonelymoon87/dsh-gitflow)](./LICENSE)

Git status, diff, log, commit, branch, and optional restore-point tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The v0.1.3 release is tested with DSH 0.1.0-rc.8 and 0.1.1-rc.1 while retaining the rc.6-compatible peer range. Prebuilt packages are distributed through GitHub Releases; npm publication is prepared but not yet live.

[简体中文](./README.zh-CN.md)

## MVP

- `git_status` reads branch and working-tree counts.
- `git_diff` reads unstaged or staged unified diffs without touching the index.
- `git_log` returns bounded structured commit history and handles unborn repositories.
- `git_commit` commits only existing staged changes and requires DSH approval.
- `git_branch` lists local branches; create and switch require approval.
- `/commit` loads a staged-change review skill before calling `git_commit`.
- `checkpoint_list` and two-phase `checkpoint_restore` delegate to an optional Change Ledger service.
- Optional `autoCheckpoint` captures a Change Ledger restore point at `tools/pre-execute` for configured mutation tools.

Pull-request creation, push, worktree management, and branch deletion are deliberately outside the MVP.

## Safety model

GitFlow never stages files implicitly. It does not run `git add`, `git reset`, `git stash`, `git push`, hook-bypass flags, or destructive branch commands. Git arguments are shell-quoted and commit messages are passed through stdin. Every Git process uses the mounted DSH shell service, preserving its timeout, sandbox, cancellation, and execution-world behavior.

Mutating tool calls pass through the DSH approval seam. Direct command handlers do not bypass it: `/commit` queues a user-invoked skill, and the eventual `git_commit` tool call asks for approval.

## Change Ledger integration

[dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) owns workspace snapshots, restore planning, rescue points, stale-plan checks, and post-restore verification. GitFlow does not implement a competing stash or commit-tree restore engine.

When no compatible `ctx.changeLedger` service is mounted, ordinary Git tools continue to work and checkpoint tools fail with a configuration message. Because the restore point is already the durable source of truth, GitFlow does not duplicate it into required custom session events.

## Permissions and data

- Read tools execute local `git status`, `git diff`, and `git log` commands through the mounted DSH shell service. Mutating commit and branch operations pass through DSH approval.
- The optional Change Ledger integration can create and restore workspace checkpoints when that service is installed and explicitly enabled.
- GitFlow does not access credentials, contact Git hosts, push changes, or register a custom durable session event. Git command output is returned to the current agent session.

## Install

The package supports DSH `>=0.1.0-rc.6 <0.2.0` plugin APIs and Node.js `^22.19 || >=24`.

```sh
dsh plugin --profile web add https://github.com/lonelymoon87/dsh-gitflow/releases/download/v0.1.3/dsh-gitflow-0.1.3.tgz
```

The release tarball is prebuilt and needs no build allowance. A pinned source install is also supported:

```sh
dsh plugin --profile web add github:lonelymoon87/dsh-gitflow#v0.1.3
```

The source install runs this package's `prepare` build. pnpm 10 and later reject it until the profile allowlists the exact package key printed by the failed command; apply that instruction and rerun the same `dsh plugin add` command. Replace `web` with `headless` to install into the one-shot agent profile.

To upgrade, rerun `dsh plugin add` with the newer release URL. To uninstall:

```sh
dsh plugin --profile web remove dsh-gitflow
```

## Configuration

```yaml
- id: gitflow
  name: dsh-gitflow
  config:
    timeoutMs: 30000
    maxOutputBytes: 2097152
    maxLogEntries: 100
    conventionalCommits: true
    autoCheckpoint: false
    checkpointTools:
      - write
      - edit
      - str_replace_editor
      - git_commit
      - git_branch
```

`autoCheckpoint` is disabled by default. Enabling it without a Change Ledger service does not pretend recovery exists; it leaves calls unchanged.

## Verification

The test suite uses real temporary Git repositories. It covers dirty status, staged and unstaged diffs, commits, branch creation, unborn history, approval decisions, automatic checkpoint delegation, and two-phase restore delegation.

- The v0.1.3 tarball installs directly from its HTTPS release URL into clean DSH 0.1.0-rc.8 and 0.1.1-rc.1 profiles.
- The packed bundle and pinned GitHub source install both appear in `dsh --dump-config`.
- CI covers Node 22.19 and Node 24; a compatibility matrix repeats the real install against DSH 0.1.0-rc.8 plus the `latest` and `next` npm tags.
- Bugs and compatibility reports are tracked in [GitHub Issues](https://github.com/lonelymoon87/dsh-gitflow/issues).

## License

[MIT](./LICENSE)
