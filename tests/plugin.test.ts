import { exec as nodeExec, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, parseLog, parseStatus } from '../src/index.ts'

interface CapturedTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: { agent?: object; signal: AbortSignal }): Promise<unknown>
}

type PreExecuteListener = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

function run(command: string, cwd: string, stdin?: string): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const child = nodeExec(command, { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(error)
        return
      }
      resolve({
        exitCode: error === null ? 0 : error.code,
        signal: error?.signal ?? null,
        timedOut: false,
        aborted: false,
        timeoutMs: 30_000,
        stdout: { text: stdout, truncated: false },
        stderr: { text: stderr, truncated: false },
      })
    })
    child.stdin?.end(stdin)
  })
}

function shell() {
  return {
    resolve(request: ShellExecRequest): ShellExecSpec {
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 30_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 2 * 1024 * 1024,
        signal: request.signal,
        stdin: request.stdin,
        sandboxPolicy: undefined,
      }
    },
    run(spec: ShellExecSpec): Promise<ShellRunResult> {
      return run(spec.command, spec.workdir, spec.stdin)
    },
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function repository(withCommit = true): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-gitflow-'))
  git(cwd, 'init', '--initial-branch=main')
  git(cwd, 'config', 'user.name', 'GitFlow Test')
  git(cwd, 'config', 'user.email', 'gitflow@example.invalid')
  if (withCommit) {
    await writeFile(join(cwd, 'tracked.txt'), 'one\n')
    git(cwd, 'add', 'tracked.txt')
    git(cwd, 'commit', '-m', 'test: initial')
  }
  return cwd
}

function fixture(cwd: string, ledger?: object, config: Parameters<typeof apply>[1] = {}) {
  const tools: CapturedTool[] = []
  const commands: CommandDefinition[] = []
  const listeners: PreExecuteListener[] = []
  const followup = vi.fn()
  const agent = { id: 'agent-1', session: { header: { cwd } }, followup }
  const ctx = {
    shell: shell(),
    tools: { register: (tool: CapturedTool) => { tools.push(tool); return () => {} } },
    commands: { register: (command: CommandDefinition) => { commands.push(command); return () => {} } },
    skills: { register: () => () => {} },
    systemPrompt: { section: vi.fn(() => () => {}) },
    on: (event: string, listener: PreExecuteListener) => {
      if (event === 'tools/pre-execute') listeners.push(listener)
      return () => {}
    },
    get: (service: string) => service === 'changeLedger' ? ledger : undefined,
  } as unknown as Context
  apply(ctx, config)
  return { tools, commands, listeners, followup, agent }
}

function tool(tools: CapturedTool[], name: string): CapturedTool {
  const found = tools.find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

describe('parsers', () => {
  it('parses status counts and detached HEAD', () => {
    expect(parseStatus('## main...origin/main [ahead 1]\nM  staged\n M unstaged\n?? new\n')).toMatchObject({
      clean: false,
      branch: 'main',
      staged: 1,
      unstaged: 1,
      untracked: 1,
    })
    expect(parseStatus('## HEAD (no branch)\n')).toMatchObject({ clean: true, branch: null })
  })

  it('parses record-separated logs and rejects incomplete records', () => {
    expect(parseLog('full\u001fshort\u001fA U Thor\u001f2026-01-01T00:00:00Z\u001ffeat: one\u001e\n')).toEqual([{
      hash: 'full',
      shortHash: 'short',
      author: 'A U Thor',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'feat: one',
    }])
    expect(() => parseLog('broken\u001erecord')).toThrow('incomplete record')
  })
})

describe('real Git workflow', () => {
  it('reads status and diff, commits staged files, reads log, and creates a branch', async () => {
    const cwd = await repository()
    try {
      const { tools, commands, followup, agent } = fixture(cwd)
      const exec = { agent, signal: new AbortController().signal }
      expect(tools.map(candidate => candidate.name)).toEqual([
        'git_status',
        'git_diff',
        'git_log',
        'git_commit',
        'git_branch',
        'checkpoint_list',
        'checkpoint_restore',
      ])

      await writeFile(join(cwd, 'tracked.txt'), 'one\ntwo\n')
      await writeFile(join(cwd, 'untracked.txt'), 'new\n')
      await expect(tool(tools, 'git_status').execute({}, exec)).resolves.toMatchObject({
        clean: false,
        staged: 0,
        unstaged: 1,
        untracked: 1,
      })
      await expect(tool(tools, 'git_diff').execute({}, exec)).resolves.toMatchObject({
        staged: false,
        path: null,
        diff: expect.stringContaining('+two'),
      })

      git(cwd, 'add', 'tracked.txt')
      await expect(tool(tools, 'git_diff').execute({ staged: true, path: 'tracked.txt' }, exec)).resolves.toMatchObject({
        staged: true,
        path: 'tracked.txt',
        diff: expect.stringContaining('+two'),
      })
      await expect(tool(tools, 'git_commit').execute({ message: 'feat: add second line' }, exec)).resolves.toMatchObject({
        hash: expect.stringMatching(/^[0-9a-f]{40}$/u),
        summary: 'feat: add second line',
      })
      await expect(tool(tools, 'git_log').execute({ max_count: 2 }, exec)).resolves.toMatchObject([
        { subject: 'feat: add second line' },
        { subject: 'test: initial' },
      ])
      await expect(tool(tools, 'git_branch').execute({ action: 'create', name: 'feature/test' }, exec)).resolves.toEqual({
        current: 'feature/test',
        branches: ['feature/test', 'main'],
      })

      const commit = commands.find(command => command.name === 'commit')
      expect(commit?.handler({
        commandId: 'command-1',
        agent,
        rawInput: ' focus on the CLI ',
        signal: new AbortController().signal,
      } as never)).toEqual({ kind: 'success', text: 'queued staged-change review' })
      expect(followup.mock.calls[0]?.[0]).toMatchObject({
        content: [{ type: 'text', text: '/gitflow-commit focus on the CLI' }],
        source: { kind: 'user' },
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns an empty log for an unborn repository and refuses an empty index', async () => {
    const cwd = await repository(false)
    try {
      const { tools, agent } = fixture(cwd)
      const exec = { agent, signal: new AbortController().signal }
      await expect(tool(tools, 'git_log').execute({}, exec)).resolves.toEqual([])
      await expect(tool(tools, 'git_commit').execute({ message: 'feat: impossible' }, exec))
        .rejects.toThrow('no staged changes')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('approval and Change Ledger integration', () => {
  it('asks before mutation and creates an optional automatic checkpoint', async () => {
    const cwd = await repository()
    const ledger = {
      create: vi.fn(async () => ({ id: 'rp-1' })),
      list: vi.fn(async () => []),
      planRestore: vi.fn(),
      applyRestore: vi.fn(),
    }
    try {
      const { listeners, agent } = fixture(cwd, ledger, { autoCheckpoint: true })
      const exec = {
        name: 'git_commit',
        arguments: { message: 'feat: change' },
        agent,
        signal: new AbortController().signal,
      } as unknown as ToolExecution
      const decision = await listeners.reduceRight<() => Promise<PreToolDecision>>(
        (next, listener) => () => listener(exec, next),
        async () => ({ kind: 'allow' }),
      )()
      expect(decision).toMatchObject({ kind: 'ask' })
      expect(ledger.create).toHaveBeenCalledWith(expect.objectContaining({
        cwd,
        sessionId: 'agent-1',
        label: 'Before git_commit',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('delegates checkpoint planning and apply without implementing a second restore engine', async () => {
    const cwd = await repository()
    const ledger = {
      create: vi.fn(),
      list: vi.fn(async () => [{
        id: 'rp-1', kind: 'user', createdAt: 1, fileCount: 2, totalBytes: 20, label: 'before', branch: 'main', head: 'abc',
      }]),
      planRestore: vi.fn(async () => ({ id: 'plan-1', confirmation: 'RESTORE rp-1', expiresAt: 10, changes: [{ path: 'a' }] })),
      applyRestore: vi.fn(async () => ({
        operationId: 'op-1', restorePointId: 'rp-1', rescuePointId: 'rp-rescue', restoredPaths: ['a'],
      })),
    }
    try {
      const { tools, agent } = fixture(cwd, ledger)
      const exec = { agent, signal: new AbortController().signal }
      await expect(tool(tools, 'checkpoint_list').execute({}, exec)).resolves.toEqual([{
        id: 'rp-1', kind: 'user', createdAt: 1, fileCount: 2, totalBytes: 20, label: 'before', branch: 'main', head: 'abc',
      }])
      await expect(tool(tools, 'checkpoint_restore').execute({ action: 'plan', restore_point_id: 'rp-1' }, exec)).resolves.toMatchObject({
        action: 'plan', planId: 'plan-1', confirmation: 'RESTORE rp-1', changeCount: 1,
      })
      await expect(tool(tools, 'checkpoint_restore').execute({
        action: 'apply', plan_id: 'plan-1', confirmation: 'RESTORE rp-1',
      }, exec)).resolves.toMatchObject({
        action: 'apply', operationId: 'op-1', rescuePointId: 'rp-rescue', restoredPaths: ['a'],
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
