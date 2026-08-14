# dsh-gitflow

[![CI](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/ci.yml/badge.svg)](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/ci.yml)
[![最新 DSH 兼容性](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/dsh-compatibility.yml/badge.svg)](https://github.com/lonelymoon87/dsh-gitflow/actions/workflows/dsh-compatibility.yml)
[![Release](https://img.shields.io/github/v/release/lonelymoon87/dsh-gitflow)](https://github.com/lonelymoon87/dsh-gitflow/releases/latest)
[![License](https://img.shields.io/github/license/lonelymoon87/dsh-gitflow)](./LICENSE)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Git 状态、diff、日志、提交、分支和可选恢复点工具集。

可安装的 v0.1.1 面向 DSH 0.1.0-rc.6；npm 是后续可选的额外分发渠道。

[English](./README.md)

## MVP

- `git_status` 读取当前分支和工作树状态计数；
- `git_diff` 读取未暂存或已暂存 diff，不改动 index；
- `git_log` 返回有上限的结构化提交记录，并处理空仓库；
- `git_commit` 只提交已经暂存的改动，并经过 DSH 审批；
- `git_branch` 列出本地分支，创建和切换需要审批；
- `/commit` 先加载暂存改动审查技能，再调用 `git_commit`；
- `checkpoint_list` 和两阶段 `checkpoint_restore` 委托给可选的 Change Ledger 服务；
- 可选的 `autoCheckpoint` 在配置的写工具执行前创建 Change Ledger 恢复点。

PR 创建、push、worktree 管理和分支删除不在 MVP 范围内。

## 安全约束

GitFlow 不会隐式暂存文件，也不会执行 `git add`、`git reset`、`git stash`、`git push`、跳过 hook 的参数或破坏性分支命令。Git 参数经过 shell 引用，提交信息通过 stdin 传给 Git。所有 Git 进程都经过 DSH shell service，因此沿用其超时、沙箱、取消和执行环境。

会修改状态的工具调用经过 DSH 审批。`/commit` 只负责排入用户显式调用的技能，最终的 `git_commit` 工具调用仍会触发审批。

## 与 Change Ledger 的关系

[dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) 负责工作区快照、恢复计划、救援点、过期计划检查和恢复后验证。GitFlow 不再实现第二套 stash 或 commit-tree 恢复引擎。

没有挂载兼容的 `ctx.changeLedger` 服务时，普通 Git 工具照常工作，检查点工具会明确提示配置缺失。恢复点本身已经是持久事实源，因此插件不会再用必需的自定义会话事件复制一份状态。

## 安装

当前代码面向 DSH `0.1.0-rc.6` 插件 API，要求 Node.js `^22.19 || >=24`。

```sh
dsh plugin --profile default add https://github.com/lonelymoon87/dsh-gitflow/releases/download/v0.1.1/dsh-gitflow-0.1.1.tgz
```

Release tarball 已预构建，不需要构建权限。也可以固定版本从源码安装：

```sh
dsh plugin --profile default add github:lonelymoon87/dsh-gitflow#v0.1.1
```

源码安装会运行本包的 `prepare` 构建。pnpm 10 及以上版本默认拒绝执行，第一次安装失败时请按 DSH 输出的提示，将准确的包键加入 profile 的构建白名单，然后重新执行同一条命令。

升级时用新版本的 Release URL 再执行一次 `dsh plugin add`。卸载命令：

```sh
dsh plugin --profile default remove dsh-gitflow
```

## 配置

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

`autoCheckpoint` 默认关闭。即使开启但没有 Change Ledger，插件也不会假装已经具备恢复能力。

## 发布验证

测试使用真实临时 Git 仓库，覆盖状态、暂存与未暂存 diff、提交、分支、空仓库、审批、自动检查点和两阶段恢复委托。

- v0.1.1 tarball 已从 HTTPS Release URL 直接安装进全新 DSH profile；
- pack 产物与固定版本 GitHub 源码安装均通过 `dsh --dump-config` 检查；
- CI 覆盖 Node 22.19 与 Node 24，定时任务会用 `@deepseek-ai/dsh@latest` 重跑真实安装；
- bug 与兼容性问题统一进入 [GitHub Issues](https://github.com/lonelymoon87/dsh-gitflow/issues)。

## 许可证

[MIT](./LICENSE)
