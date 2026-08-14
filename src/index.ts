/** Git workflow tools for DeepSeek Harness. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Loader-facing plugin name. */
export const name = 'gitflow'

/** Services required for the Git workflow capability. */
export const inject = ['commands', 'shell', 'skills', 'systemPrompt', 'tools']

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_LOG_ENTRIES = 100
const DEFAULT_CHECKPOINT_TOOLS = ['write', 'edit', 'str_replace_editor', 'git_commit', 'git_branch']
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CONVENTIONAL_COMMIT = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9._/-]+\))?!?: .+$/u

/** Deployment configuration for Git execution and optional restore points. */
export interface Config {
  /** Per-command deadline requested from the mounted shell provider. */
  timeoutMs?: number
  /** Maximum complete stdout accepted from a Git process. */
  maxOutputBytes?: number
  /** Upper bound accepted by git_log. */
  maxLogEntries?: number
  /** Require conventional-commit syntax in git_commit. */
  conventionalCommits?: boolean
  /** Create Change Ledger restore points before configured write tools. */
  autoCheckpoint?: boolean
  /** Tool names that autoCheckpoint treats as workspace mutations. */
  checkpointTools?: string[]
}

/** Loader validation for GitFlow configuration. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxLogEntries: z.number().step(1).min(1).default(DEFAULT_MAX_LOG_ENTRIES),
  conventionalCommits: z.boolean().default(true),
  autoCheckpoint: z.boolean().default(false),
  checkpointTools: z.array(z.string()).default(DEFAULT_CHECKPOINT_TOOLS),
})

interface ResolvedConfig {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly maxLogEntries: number
  readonly conventionalCommits: boolean
  readonly autoCheckpoint: boolean
  readonly checkpointTools: ReadonlySet<string>
}

interface RestorePointSummary {
  readonly id: string
  readonly kind: string
  readonly createdAt: number
  readonly label?: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly branch?: string
  readonly head?: string
}

interface RestorePlan {
  readonly id: string
  readonly confirmation: string
  readonly expiresAt: number
  readonly changes: readonly unknown[]
}

interface RestoreResult {
  readonly operationId: string
  readonly restorePointId: string
  readonly rescuePointId: string
  readonly restoredPaths: readonly string[]
}

interface ChangeLedgerLike {
  create(options: { cwd: string; sessionId?: string; label?: string; signal?: AbortSignal }): Promise<RestorePointSummary>
  list(options: { cwd: string; includeRescue?: boolean; includeTurnCheckpoints?: boolean; signal?: AbortSignal }): Promise<RestorePointSummary[]>
  planRestore(options: { cwd: string; restorePointId: string; sessionId?: string; paths?: readonly string[]; allowHeadChange?: boolean; signal?: AbortSignal }): Promise<RestorePlan>
  applyRestore(options: { planId: string; confirmation: string; sessionId?: string; signal?: AbortSignal }): Promise<RestoreResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    changeLedger: ChangeLedgerLike
  }
}

/** Canonical status returned by git_status. */
export interface GitStatus {
  readonly clean: boolean
  readonly branch: string | null
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly summary: string
}

/** One compact commit returned by git_log. */
export interface GitLogEntry {
  readonly hash: string
  readonly shortHash: string
  readonly author: string
  readonly authoredAt: string
  readonly subject: string
}

interface GitOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function resolveConfig(config: Config): ResolvedConfig {
  const checkpointTools = config.checkpointTools ?? DEFAULT_CHECKPOINT_TOOLS
  if (checkpointTools.some(tool => tool.trim().length === 0)) {
    throw new TypeError('checkpointTools must contain only non-empty tool names')
  }
  return {
    timeoutMs: positiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxOutputBytes: positiveInteger(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes'),
    maxLogEntries: positiveInteger(config.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES, 'maxLogEntries'),
    conventionalCommits: config.conventionalCommits ?? true,
    autoCheckpoint: config.autoCheckpoint ?? false,
    checkpointTools: new Set(checkpointTools),
  }
}

function shellQuote(value: string): string {
  return process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`
}

function gitCommand(args: readonly string[]): string {
  return ['git', ...args.map(shellQuote)].join(' ')
}

function workingDirectory(exec: { agent?: { session: { header: { cwd?: string } } } }): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('GitFlow tools require an agent workspace')
  return cwd
}

function collectedText(result: ShellRunResult['stdout'], stream: string): string {
  if (result.truncated) {
    throw new Error(`${stream} exceeded the configured complete-output limit${result.spillPath === undefined ? '' : `; full output: ${result.spillPath}`}`)
  }
  return result.text
}

async function runGit(
  ctx: Context,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  config: ResolvedConfig,
  options: { readonly stdin?: string; readonly allowedExitCodes?: readonly number[] } = {},
): Promise<GitOutput> {
  const request = {
    command: gitCommand(args),
    workdir: cwd,
    timeoutMs: config.timeoutMs,
    stdoutMaxBytes: config.maxOutputBytes,
    signal,
    ...options.stdin === undefined ? {} : { stdin: options.stdin },
  }
  const result = await ctx.shell.run(ctx.shell.resolve(request))
  const stdout = collectedText(result.stdout, 'git stdout')
  const stderr = collectedText(result.stderr, 'git stderr')
  const allowed = options.allowedExitCodes ?? [0]
  if (result.exitCode === null || !allowed.includes(result.exitCode)) {
    const detail = stderr.trim() || stdout.trim() || `git exited with ${result.exitCode === null ? result.signal ?? 'a signal' : `code ${result.exitCode}`}`
    throw new Error(detail)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}

/** Parse git status --short --branch output into stable counts. */
export function parseStatus(output: string): GitStatus {
  const lines = output.replace(/\r\n/gu, '\n').split('\n').filter(Boolean)
  const header = lines[0]?.startsWith('## ') === true ? lines.shift()?.slice(3) : undefined
  const branch = header === undefined || header === 'HEAD (no branch)'
    ? null
    : (header.split('...')[0]?.split(' [')[0] ?? header)
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of lines) {
    if (line.startsWith('??')) {
      untracked += 1
      continue
    }
    const index = line[0]
    const worktree = line[1]
    if (index !== undefined && index !== ' ') staged += 1
    if (worktree !== undefined && worktree !== ' ') unstaged += 1
  }
  return {
    clean: staged === 0 && unstaged === 0 && untracked === 0,
    branch,
    staged,
    unstaged,
    untracked,
    summary: output,
  }
}

/** Parse the record-separated git_log format used by this plugin. */
export function parseLog(output: string): GitLogEntry[] {
  return output.split('\x1e').flatMap((record) => {
    const normalized = record.replace(/^\n/u, '').trimEnd()
    if (normalized.length === 0) return []
    const [hash, shortHash, author, authoredAt, subject] = normalized.split('\x1f')
    if (hash === undefined || shortHash === undefined || author === undefined || authoredAt === undefined || subject === undefined) {
      throw new Error('git log returned an incomplete record')
    }
    return [{ hash, shortHash, author, authoredAt, subject }]
  })
}

function parseBranches(output: string): { current: string | null; branches: string[] } {
  let current: string | null = null
  const branches = output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const branch = line.slice(2).trim()
    if (line.startsWith('* ')) current = branch
    return branch
  })
  return { current, branches }
}

function changeLedger(ctx: Context): ChangeLedgerLike {
  const ledger = ctx.get('changeLedger')
  if (ledger === undefined) {
    throw new Error('Change Ledger is not configured; install a compatible dsh-turn-rewind service to use checkpoint tools')
  }
  return ledger
}

function sessionId(exec: { agent?: { id: string } }): string | undefined {
  return exec.agent?.id
}

function dispatchCommitSkill(invocation: CommandInvocation): void {
  invocation.signal.throwIfAborted()
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: invocation.rawInput.trim().length === 0 ? '/gitflow-commit' : `/gitflow-commit ${invocation.rawInput.trim()}` }],
    source: { kind: 'user' },
  }))
}

function mutationNeedsApproval(exec: ToolExecution): boolean {
  if (exec.name === 'git_commit') return true
  if (exec.name === 'checkpoint_restore') {
    return typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { action?: unknown }).action === 'apply'
  }
  if (exec.name !== 'git_branch') return false
  return typeof exec.arguments === 'object' && exec.arguments !== null
    && (exec.arguments as { action?: unknown }).action !== 'list'
}

async function approvalGate(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
  const decision = await next()
  if (decision.kind !== 'allow' || !mutationNeedsApproval(exec)) return decision
  return { kind: 'ask', reason: `${exec.name} will change Git or workspace state` }
}

function skillContent(): string {
  return readFileSync(new URL('../skills/gitflow-commit/SKILL.md', import.meta.url), 'utf8')
}

/** Register Git tools, the commit command, approval policy, and optional restore integration. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  ctx.skills.register({
    name: 'gitflow-commit',
    description: 'Review staged changes, prepare a commit message, and create one approved Git commit.',
    content: skillContent(),
    source: 'bundled',
    resourceBase: { kind: 'directory', path: PACKAGE_ROOT },
    invocation: { modelInvocable: false, userInvocable: true },
  })

  ctx.commands.register({
    name: 'commit',
    description: 'Review staged changes and create an approved commit',
    input: { hint: '[message guidance]' },
    handler: (invocation) => {
      dispatchCommitSkill(invocation)
      return { kind: 'success', text: 'queued staged-change review' }
    },
  })

  ctx.on('tools/pre-execute', approvalGate)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind === 'deny' || !resolved.autoCheckpoint || !resolved.checkpointTools.has(exec.name)) return decision
    const ledger = ctx.get('changeLedger')
    const cwd = exec.agent?.session.header.cwd
    if (ledger === undefined || cwd === undefined) return decision
    exec.signal.throwIfAborted()
    await ledger.create({
      cwd,
      ...exec.agent === undefined ? {} : { sessionId: exec.agent.id },
      label: `Before ${exec.name}`,
      signal: exec.signal,
    })
    return decision
  })

  ctx.tools.register(defineTool({
    name: 'git_status',
    description: 'Read branch and working-tree status without changing the repository.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clean: { type: 'boolean', required: true },
          branch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          staged: { type: 'integer', required: true },
          unstaged: { type: 'integer', required: true },
          untracked: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const cwd = workingDirectory(exec)
      return parseStatus((await runGit(ctx, cwd, ['status', '--short', '--branch', '--untracked-files=all'], exec.signal, resolved)).stdout)
    },
    presentCall: () => ({ card: 'generic', title: 'Read Git status', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff',
    description: 'Read an unstaged or staged unified diff. This never stages files.',
    parameters: {
      staged: { type: 'boolean', description: 'Read the index diff instead of the worktree diff.' },
      path: { type: 'string', description: 'Optional repository-relative path filter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          staged: { type: 'boolean', required: true },
          path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          diff: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.diff.length === 0 ? '(no diff)' : `\`\`\`diff\n${value.diff}\n\`\`\`` }],
    },
    async execute(args, exec) {
      const staged = args.staged ?? false
      const gitArgs = ['diff', '--no-ext-diff', '--no-color', ...staged ? ['--cached'] : [], ...args.path === undefined ? [] : ['--', args.path]]
      const diff = (await runGit(ctx, workingDirectory(exec), gitArgs, exec.signal, resolved)).stdout
      return { staged, path: args.path ?? null, diff }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.staged === true ? 'Read staged Git diff' : 'Read Git diff',
      kind: 'read',
      ...args.path === undefined ? {} : { locations: [{ path: args.path }] },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'git_log',
    description: 'Read recent commits from the current repository.',
    parameters: {
      max_count: { type: 'integer', description: 'Number of commits, capped by plugin configuration.' },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hash: { type: 'string', required: true },
            shortHash: { type: 'string', required: true },
            author: { type: 'string', required: true },
            authoredAt: { type: 'string', required: true },
            subject: { type: 'string', required: true },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const cwd = workingDirectory(exec)
      const count = positiveInteger(args.max_count ?? 20, 'max_count')
      if (count > resolved.maxLogEntries) throw new Error(`max_count exceeds configured limit ${resolved.maxLogEntries}`)
      const head = await runGit(ctx, cwd, ['rev-parse', '--verify', 'HEAD'], exec.signal, resolved, { allowedExitCodes: [0, 128] })
      if (head.exitCode !== 0) return []
      const format = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'
      return parseLog((await runGit(ctx, cwd, ['log', `--max-count=${count}`, `--format=${format}`], exec.signal, resolved)).stdout)
    },
    presentCall: args => ({ card: 'generic', title: 'Read Git log', kind: 'read', rawInput: args.max_count }),
  }))

  ctx.tools.register(defineTool({
    name: 'git_commit',
    description: 'Commit only the currently staged changes. Never stages files. Every call requires human approval.',
    parameters: {
      message: { type: 'string', required: true, description: 'Complete commit message.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hash: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.hash} ${value.summary}` }],
    },
    async execute(args, exec) {
      const message = args.message.trim()
      if (message.length === 0) throw new Error('commit message must not be empty')
      const subject = message.split(/\r?\n/u)[0] ?? ''
      if (resolved.conventionalCommits && !CONVENTIONAL_COMMIT.test(subject)) {
        throw new Error('commit subject must use conventional-commit syntax')
      }
      const cwd = workingDirectory(exec)
      const staged = await runGit(ctx, cwd, ['diff', '--cached', '--name-only'], exec.signal, resolved)
      if (staged.stdout.trim().length === 0) throw new Error('no staged changes; GitFlow never stages files implicitly')
      await runGit(ctx, cwd, ['commit', '--file=-'], exec.signal, resolved, { stdin: `${message}\n` })
      const hash = (await runGit(ctx, cwd, ['rev-parse', 'HEAD'], exec.signal, resolved)).stdout.trim()
      const summary = (await runGit(ctx, cwd, ['log', '-1', '--format=%s'], exec.signal, resolved)).stdout.trim()
      return { hash, summary }
    },
    presentCall: args => ({ card: 'generic', title: 'Create Git commit', kind: 'execute', rawInput: args.message }),
  }))

  ctx.tools.register(defineTool({
    name: 'git_branch',
    description: 'List, create, or switch local Git branches. Create and switch require human approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'create', 'switch'] },
      name: { type: 'string', description: 'Branch name required for create and switch.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          branches: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const cwd = workingDirectory(exec)
      if (args.action !== 'list') {
        const branch = args.name?.trim()
        if (branch === undefined || branch.length === 0) throw new Error(`branch name is required for ${args.action}`)
        await runGit(ctx, cwd, ['check-ref-format', '--branch', branch], exec.signal, resolved)
        await runGit(ctx, cwd, args.action === 'create' ? ['switch', '--create', branch] : ['switch', branch], exec.signal, resolved)
      }
      return parseBranches((await runGit(ctx, cwd, ['branch', '--list', '--no-color'], exec.signal, resolved)).stdout)
    },
    presentCall: args => ({ card: 'generic', title: `${args.action} Git branch`, kind: args.action === 'list' ? 'read' : 'execute', rawInput: args.name }),
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_list',
    description: 'List Change Ledger restore points. Requires a compatible dsh-turn-rewind service.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            createdAt: { type: 'number', required: true },
            fileCount: { type: 'integer', required: true },
            totalBytes: { type: 'integer', required: true },
            label: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            branch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            head: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const points = await changeLedger(ctx).list({
        cwd: workingDirectory(exec),
        includeRescue: false,
        includeTurnCheckpoints: false,
        signal: exec.signal,
      })
      return points.map(point => ({
        id: point.id,
        kind: point.kind,
        createdAt: point.createdAt,
        fileCount: point.fileCount,
        totalBytes: point.totalBytes,
        label: point.label ?? null,
        branch: point.branch ?? null,
        head: point.head ?? null,
      }))
    },
    presentCall: () => ({ card: 'generic', title: 'List restore points', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_restore',
    description: 'Plan or apply an exact Change Ledger restore. Applying requires the plan confirmation and human approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['plan', 'apply'] },
      restore_point_id: { type: 'string', description: 'Required for plan.' },
      plan_id: { type: 'string', description: 'Required for apply.' },
      confirmation: { type: 'string', description: 'Exact confirmation returned by plan; required for apply.' },
      allow_head_change: { type: 'boolean', description: 'Allow a reviewed HEAD or branch change during planning.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          planId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          confirmation: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          expiresAt: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          changeCount: { type: 'integer', required: true },
          operationId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          restorePointId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          rescuePointId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          restoredPaths: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const ledger = changeLedger(ctx)
      const owner = sessionId(exec)
      if (args.action === 'plan') {
        const restorePointId = args.restore_point_id?.trim()
        if (restorePointId === undefined || restorePointId.length === 0) throw new Error('restore_point_id is required for plan')
        const plan = await ledger.planRestore({
          cwd: workingDirectory(exec),
          restorePointId,
          ...owner === undefined ? {} : { sessionId: owner },
          allowHeadChange: args.allow_head_change ?? false,
          signal: exec.signal,
        })
        return {
          action: 'plan',
          planId: plan.id,
          confirmation: plan.confirmation,
          expiresAt: plan.expiresAt,
          changeCount: plan.changes.length,
          operationId: null,
          restorePointId,
          rescuePointId: null,
          restoredPaths: [],
        }
      }
      const planId = args.plan_id?.trim()
      const confirmation = args.confirmation
      if (planId === undefined || planId.length === 0 || confirmation === undefined || confirmation.length === 0) {
        throw new Error('plan_id and exact confirmation are required for apply')
      }
      const result = await ledger.applyRestore({
        planId,
        confirmation,
        ...owner === undefined ? {} : { sessionId: owner },
        signal: exec.signal,
      })
      return {
        action: 'apply',
        planId,
        confirmation: null,
        expiresAt: null,
        changeCount: 0,
        operationId: result.operationId,
        restorePointId: result.restorePointId,
        rescuePointId: result.rescuePointId,
        restoredPaths: [...result.restoredPaths],
      }
    },
    presentCall: args => ({ card: 'generic', title: `${args.action} workspace restore`, kind: args.action === 'plan' ? 'read' : 'edit', rawInput: args.restore_point_id ?? args.plan_id }),
  }))

  ctx.systemPrompt.section({
    name: 'tool:gitflow',
    order: 118,
    text: 'GitFlow never stages files, pushes, deletes branches, or creates pull requests in its MVP. Read status and diff before mutation. git_commit, branch changes, and restore application require approval. Change Ledger remains the owner of restore plans, rescue points, and verification.',
  })
}
