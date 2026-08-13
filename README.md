# dsh-gitflow

Git status, diff, log, commit, branch, and optional restore-point tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Early development: the public repository is reserved, but the package has not yet been published to npm.

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

## Development install

The package currently targets DSH `0.1.0-rc.6` plugin APIs and Node.js `^22.19 || >=24`.

```sh
pnpm install
pnpm run check
npm pack
dsh plugin --profile default add ./dsh-gitflow-0.1.0.tgz
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

## License

[MIT](./LICENSE)
