/**
 * dsh-compaction-fit — `llm/stream` middleware that hardens compaction
 * summaries against the two failure modes seen with local OpenAI-compatible
 * gateways (Qoder / WorkBuddy / AutoClaw):
 *
 *   1. The adapter declares a much smaller `contextWindow` than the gateway
 *      actually serves. For a `stop` response pi-ai then classifies the turn as
 *      a silent overflow (`input + cacheRead > contextWindow`) even though the
 *      answer arrived complete. Compaction summaries always end in `stop`, so
 *      every summary was discarded as
 *      `pi-ai detected context overflow for model "..."` while the normal
 *      tool-call turns (stopReason `toolUse`) were unaffected.
 *
 *   2. A summary request can genuinely exceed the upstream prompt limit. The
 *      basic engine has no summary-prompt trimming or shrink-and-retry layer,
 *      so the whole compaction attempt fails and the original request error is
 *      surfaced.
 *
 * This plugin adds the missing layer without touching the harness or the
 * compaction engine:
 *
 *   - Before dispatching a `purpose: 'compaction'` request, estimate the
 *     prompt with a CJK-aware token heuristic and trim oversized tool results,
 *     reasoning, tool arguments, and middle message groups until the request
 *     fits the model budget. Tool-call/result pairs are kept together, the
 *     system prompt, the first group (usually the prior checkpoint), and the
 *     most recent groups are preserved, and an elision note is added.
 *
 *   - If the upstream genuinely rejects the prompt (context overflow before
 *     any content), shrink the budget geometrically and retry the shaped
 *     request, up to `maxRetries` times.
 *
 *   - If a terminal `CONTEXT_WINDOW_EXCEEDED` error matches pi-ai's fabricated
 *     "silent overflow" diagnostic (no upstream `status`/`requestId`, and the
 *     exact `pi-ai detected context overflow for model "..."` wording) and the
 *     stream already produced content, rewrite the finish to `stop` and keep
 *     the answer. A real upstream rejection never produces content and keeps
 *     its own message, so it is never suppressed.
 *
 * The middleware never mutates the loop's frozen request: shaped requests are
 * fresh objects carrying a bypass symbol so the nested dispatch does not
 * re-enter the trimming/retry path.
 *
 * Config shape (cordis.patch.yml):
 *
 *   - insert:
 *       - id: compaction-fit
 *         name: dsh-compaction-fit
 *         config:
 *           trim: true
 *           suppressFabricatedOverflow: true
 *           suppressScope: all          # all | compaction
 *           retryOnPromptTooLong: true
 *           maxRetries: 2
 *           shrinkRatio: 0.5
 *           contextRatio: 0.9
 *           safetyTokens: 8192
 *           minBudgetTokens: 16000
 *           maxBudgetTokens: 1000000
 *           keepHeadGroups: 2
 *           # budgets:
 *           #   "your-provider/your-model": 650000
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'compaction-fit'
export const inject = ['llm']

/** Marks a request this plugin already shaped, so the nested dispatch passes through. */
export const GUARD_BYPASS = Symbol.for('dsh.compaction-fit.bypass')

/**
 * Boot-time breadcrumb. apply() runs before the desktop log bridge attaches,
 * and info-level lines may be filtered, so a file trace is the only reliable
 * way to confirm the plugin is mounted and intercepting.
 */
const TRACE_FILE = join(tmpdir(), 'dsh-compaction-fit.trace.log')
function trace(line) {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const FABRICATED_OVERFLOW = /^pi-ai detected context overflow for model\b/i
const CJK_RE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g
const NOTE_TOKENS = 140
const CAP_ROUNDS = 5

export function apply(ctx, config) {
  trace('apply called')
  let cfg
  try {
    cfg = normalizeConfig(config)
  } catch (error) {
    trace(`config rejected: ${error?.message ?? error}`)
    return
  }
  const log = typeof ctx.logger === 'function' ? ctx.logger('compaction-fit') : ctx.logger
  const observed = new Map()
  let announced = false

  ctx.on('llm/stream', (options, next) => {
    if (!isObject(options)) return next()
    if (options[GUARD_BYPASS] === true) return next()
    const purpose = options.purpose
    const trim = cfg.trim && purpose === 'compaction'
    const watch = cfg.suppressFabricatedOverflow && watchScope(cfg, purpose)
    const retry = cfg.retryOnPromptTooLong && purpose === 'compaction'
    if (!trim && !watch && !retry) return next()
    if (!announced) {
      announced = true
      trace(`intercepting llm/stream (purpose=${purpose ?? 'chat'})`)
      log?.info?.(`active: trim=${trim} watch=${watch} retry=${retry}`)
    }
    return guardedStream(ctx, cfg, options, next, observed, log)
  })

  log?.info?.(`active: trim=${cfg.trim} suppress=${cfg.suppressFabricatedOverflow}/${cfg.suppressScope} retry=${cfg.retryOnPromptTooLong}`)
}

/* ------------------------------------------------------------------ stream */

async function* guardedStream(ctx, cfg, options, next, observed, log) {
  const key = routeKey(options)
  const trim = cfg.trim && options.purpose === 'compaction'
  const watch = cfg.suppressFabricatedOverflow && watchScope(cfg, options.purpose)
  const retry = cfg.retryOnPromptTooLong && options.purpose === 'compaction'

  let budget = 0
  if (trim) {
    try {
      budget = await resolveBudget(ctx, options, cfg, observed, log)
    } catch (error) {
      trace(`budget resolution failed for ${key}: ${error?.message ?? error}`)
      log?.warn?.(`budget resolution failed for ${key}: ${error?.message ?? error}; sending untrimmed`)
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    const shaped = trim && budget > 0 ? trimRequest(options, budget, cfg) : undefined
    if (shaped?.changed === true) {
      trace(`trimmed ${key}: ${shaped.originalTokens} -> ${shaped.estimatedTokens} tokens (budget ${budget}, note=${shaped.droppedMessages} msgs)`)
      log?.info?.(`trimmed compaction prompt for ${key}: ~${shaped.originalTokens} -> ~${shaped.estimatedTokens} tokens (budget ${budget})`)
    }

    const iterable = shaped?.changed === true
      ? ctx.llm.stream({ ...shaped.options, [GUARD_BYPASS]: true })
      : next()
    assertIterable(iterable, 'llm/stream')

    const state = { usage: undefined, finish: undefined, contentChunks: 0 }
    for await (const chunk of collect(iterable, state)) yield chunk

    const finish = state.finish
    if (finish === undefined) return
    const reason = finish.reason
    const failure = reason?.kind === 'error' ? reason.failure : undefined

    // 1) False positive: pi-ai inferred overflow from usage, but the answer
    //    actually arrived. Only a content-bearing, fabricated diagnostic is
    //    rewritten; real upstream rejections and empty completions pass through.
    if (failure !== undefined && watch && state.contentChunks > 0 && isFabricatedOverflow(failure)) {
      if (state.usage !== undefined) {
        yield { type: 'usage', usage: state.usage }
        noteObserved(observed, key, state.usage)
      }
      trace(`suppressed fabricated overflow for ${key}: contentChunks=${state.contentChunks} prompt=${promptTokens(state.usage)}`)
      log?.warn?.(`${key}: keeping a completed ${state.contentChunks}-chunk response that pi-ai misclassified as context overflow`)
      yield finishWith(finish, { kind: 'stop' })
      return
    }

    // 2) Genuine prompt-too-long before any content: shrink the shaped request
    //    and retry. Content already handed to the consumer cannot be retracted.
    if (failure !== undefined && retry && state.contentChunks === 0 && attempt < cfg.maxRetries && isOverflowFailure(failure)) {
      const used = promptTokens(state.usage)
      const base = used > 0 ? used : (shaped?.estimatedTokens ?? budget)
      const nextBudget = Math.max(cfg.minRetryBudgetTokens, Math.floor(base * cfg.shrinkRatio))
      if (nextBudget < base || budget === 0) {
        budget = nextBudget
        trace(`retrying ${key} with budget ${nextBudget} after: ${failure.message}`)
        log?.warn?.(`${key}: summary prompt rejected (${failure.message}); retrying with ~${nextBudget} token budget`)
        continue
      }
      trace(`retry not smaller for ${key}: base=${base} next=${nextBudget} budget=${budget}`)
    }

    // 3) Pass the terminal outcome through unchanged.
    if (state.usage !== undefined) {
      yield { type: 'usage', usage: state.usage }
      if (reason?.kind !== 'error' && reason?.kind !== 'aborted') noteObserved(observed, key, state.usage)
    }
    yield finish
    return
  }
}

/** Drain one attempt, holding `usage` and `finish` until the outcome is known. */
async function* collect(iterable, state) {
  for await (const chunk of iterable) {
    if (chunk?.type === 'usage') {
      state.usage = chunk.usage
      continue
    }
    if (chunk?.type === 'finish') {
      state.finish = chunk
      continue
    }
    if (isContentChunk(chunk)) state.contentChunks += 1
    yield chunk
  }
}

function finishWith(finish, reason) {
  return {
    type: 'finish',
    reason,
    ...(finish.replayState === undefined ? {} : { replayState: finish.replayState }),
  }
}

function isContentChunk(chunk) {
  return chunk?.type !== undefined && chunk.type !== 'usage' && chunk.type !== 'finish'
}

function assertIterable(value, label) {
  if (value === null || value === undefined || typeof value[Symbol.asyncIterator] !== 'function') {
    throw new TypeError(`${label} returned a non-async-iterable value`)
  }
}

/* --------------------------------------------------------------- diagnosis */

function isFabricatedOverflow(failure) {
  return failure?.code === 'CONTEXT_WINDOW_EXCEEDED'
    && typeof failure.message === 'string'
    && FABRICATED_OVERFLOW.test(failure.message)
    && failure.status === undefined
    && failure.requestId === undefined
}

function isOverflowFailure(failure) {
  if (failure?.code === 'CONTEXT_WINDOW_EXCEEDED') return true
  if (failure?.code !== 'INVALID_REQUEST') return false
  if (typeof failure.message !== 'string') return false
  return /too\s+(?:long|large)|context\s+(?:length|window)|maximum\s+context|payload\s+too\s+large|request\s+body\s+too\s+large|exceeds?\s+(?:the\s+)?(?:model\s+)?context/i.test(failure.message)
}

function promptTokens(usage) {
  if (!isObject(usage)) return 0
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  return Math.max(0, input + cacheRead)
}

function noteObserved(observed, key, usage) {
  const tokens = promptTokens(usage)
  if (tokens <= 0) return
  const previous = observed.get(key) ?? 0
  if (tokens > previous) observed.set(key, tokens)
}

function watchScope(cfg, purpose) {
  return cfg.suppressScope === 'all' || purpose === 'compaction'
}

/* ------------------------------------------------------------------ budget */

function routeKey(options) {
  return `${options.provider}/${options.model}`
}

async function resolveBudget(ctx, options, cfg, observed, log) {
  const key = routeKey(options)
  const pinned = cfg.budgets.get(key)
  if (pinned !== undefined) return clamp(pinned, cfg.minBudgetTokens, cfg.maxBudgetTokens)

  let declared = 0
  try {
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal)
    declared = info?.context?.contextWindow ?? 0
  } catch (error) {
    trace(`resolveModelInfo(${key}) failed: ${error?.message ?? error}`)
  }
  const observedTokens = observed.get(key) ?? 0
  const capacity = Math.max(declared, observedTokens)
  if (!(capacity > 0)) {
    log?.warn?.(`${key}: no declared or observed context capacity; compaction trimming skipped`)
    return 0
  }

  const requestedMax = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 20000
  const outputReserve = Math.min(requestedMax, cfg.maxOutputReserveTokens)
  const budget = Math.floor(capacity * cfg.contextRatio) - outputReserve - cfg.safetyTokens
  return clamp(Math.max(budget, cfg.minBudgetTokens), cfg.minBudgetTokens, cfg.maxBudgetTokens)
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/* --------------------------------------------------------------------- trim */

/**
 * Shape one compaction request to a prompt-token budget.
 * @param {object} options - frozen GenerateOptions from compaction-basic.
 * @param {number} budget - prompt-token budget including tools and system.
 * @param {object} cfg - normalized guard config.
 * @returns {{options: object, changed: boolean, originalTokens: number, estimatedTokens: number, budget: number, droppedMessages: number}}
 */
export function trimRequest(options, budget, cfg) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const overhead = estimateOverhead(options)
  const originalTokens = overhead + estimateMessages(messages)
  const base = { options, changed: false, originalTokens, estimatedTokens: originalTokens, budget, droppedMessages: 0 }
  if (originalTokens <= budget || messages.length === 0) return base

  let best = null
  for (let round = 0; round < CAP_ROUNDS; round += 1) {
    const caps = capsForRound(cfg, round)
    const plan = planRequest(options, messages, overhead, budget, cfg, caps)
    best = plan
    if (plan.estimatedTokens <= budget) break
  }
  if (best === null) return base
  return {
    options: best.options,
    changed: best.options !== options,
    originalTokens,
    estimatedTokens: best.estimatedTokens,
    budget,
    droppedMessages: best.droppedMessages,
  }
}

function planRequest(options, messages, overhead, budget, cfg, caps) {
  const truncated = messages.map((message) => truncateMessage(message, caps))
  const groups = buildGroups(truncated)
  const costs = groups.map((group) => group.indices.reduce((total, index) => total + estimateMessage(truncated[index]), 0))

  const pinned = new Set()
  groups.forEach((group, index) => {
    if (group.pinned) pinned.add(index)
  })
  const nonPinned = []
  groups.forEach((group, index) => {
    if (!group.pinned) nonPinned.push(index)
  })
  if (nonPinned.length > 0) pinned.add(nonPinned[nonPinned.length - 1]) // most recent group
  const head = new Set(nonPinned.slice(0, cfg.keepHeadGroups))
  for (const index of head) pinned.add(index)

  const fixed = overhead + NOTE_TOKENS + [...pinned].reduce((total, index) => total + costs[index], 0)
  let remaining = budget - fixed
  const keep = new Set(pinned)
  for (let cursor = nonPinned.length - 1; cursor >= 0; cursor -= 1) {
    const index = nonPinned[cursor]
    if (keep.has(index)) continue
    if (costs[index] <= remaining) {
      keep.add(index)
      remaining -= costs[index]
    } else {
      break
    }
  }

  for (let tighten = 0; tighten < 256; tighten += 1) {
    const built = buildPlan(options, truncated, groups, costs, keep, overhead, messageNote)
    if (built.estimatedTokens <= budget) return built
    // Still over: widen the elided middle by dropping the oldest kept tail group.
    const droppable = nonPinned
      .filter((index) => keep.has(index) && !pinned.has(index))
      .sort((left, right) => left - right)
    if (droppable.length === 0) return built
    keep.delete(droppable[0])
  }
  return buildPlan(options, truncated, groups, costs, keep, overhead, messageNote)
}

function buildGroups(messages) {
  const groups = []
  let cursor = 0
  while (cursor < messages.length) {
    const message = messages[cursor]
    const pinned = message?.role === 'system' || message?.role === 'developer'
    if (pinned) {
      groups.push({ indices: [cursor], pinned: true })
      cursor += 1
      continue
    }
    const isToolCall = message?.role === 'assistant' && hasToolCall(message)
    if (isToolCall) {
      const indices = [cursor]
      let next = cursor + 1
      while (next < messages.length && messages[next]?.role === 'tool') {
        indices.push(next)
        next += 1
      }
      groups.push({ indices, pinned: false })
      cursor = next
      continue
    }
    groups.push({ indices: [cursor], pinned: false })
    cursor += 1
  }
  return groups
}

function hasToolCall(message) {
  return Array.isArray(message.content) && message.content.some((block) => block?.type === 'tool-call')
}

function buildPlan(options, messages, groups, costs, keep, overhead, noteFactory) {
  const kept = []
  let droppedMessages = 0
  let droppedTokens = 0
  let noteAt = -1
  groups.forEach((group, index) => {
    if (keep.has(index)) {
      for (const messageIndex of group.indices) kept.push(messages[messageIndex])
      return
    }
    droppedMessages += group.indices.length
    droppedTokens += costs[index]
    if (noteAt === -1) noteAt = kept.length
  })
  if (droppedMessages > 0) {
    const note = noteFactory(droppedMessages, droppedTokens)
    kept.splice(noteAt === -1 ? kept.length - 1 : noteAt, 0, note)
  }
  const untouched = kept.length === messages.length && kept.every((message, index) => message === options.messages?.[index])
  const shaped = untouched ? options : { ...options, messages: kept }
  const estimatedTokens = overhead + estimateMessages(kept)
  return { options: shaped, estimatedTokens, droppedMessages, droppedTokens }
}

function messageNote(messages, tokens) {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: `[compaction-fit: ${messages} messages (~${tokens} tokens) from the middle of this span were omitted so the summary request fits the model context window. The first messages and the most recent messages were kept; summarize the remaining conversation.]`,
    }],
  }
}

/* --------------------------------------------------------------- truncation */

function capsForRound(cfg, round) {
  const factor = Math.pow(0.5, round)
  return {
    toolResult: Math.max(200, Math.floor(cfg.maxToolResultChars * factor)),
    assistant: Math.max(400, Math.floor(cfg.maxAssistantChars * factor)),
    user: Math.max(800, Math.floor(cfg.maxUserChars * factor)),
    reasoning: round === 0 ? cfg.maxReasoningChars : 0,
    toolCall: Math.max(200, Math.floor(cfg.maxToolCallChars * factor)),
  }
}

function truncateMessage(message, caps) {
  if (!isObject(message) || !Array.isArray(message.content)) return message
  if (message.role === 'system' || message.role === 'developer') return message
  const textCap = message.role === 'tool' ? caps.toolResult : message.role === 'assistant' ? caps.assistant : caps.user
  let changed = false
  const content = []
  for (const block of message.content) {
    const next = truncateBlock(block, message.role, textCap, caps, () => { changed = true })
    if (next !== null) content.push(next)
  }
  return changed ? { ...message, content } : message
}

function truncateBlock(block, role, textCap, caps, markChanged) {
  if (!isObject(block)) return block
  switch (block.type) {
    case 'text': {
      if (typeof block.text !== 'string' || block.text.length <= textCap) return block
      markChanged()
      return { ...block, text: truncateText(block.text, textCap) }
    }
    case 'reasoning': {
      if (caps.reasoning <= 0) {
        markChanged()
        return null
      }
      if (typeof block.text !== 'string' || block.text.length <= caps.reasoning) return block
      markChanged()
      return { ...block, text: truncateText(block.text, caps.reasoning) }
    }
    case 'tool-call': {
      if (typeof block.arguments !== 'string' || block.arguments.length <= caps.toolCall) return block
      markChanged()
      return { ...block, arguments: truncateArguments(block.arguments, caps.toolCall) }
    }
    default:
      return block
  }
}

function truncateText(text, maxChars) {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const marker = `\n…[compaction-fit: ${text.length - maxChars} chars elided]…\n`
  if (maxChars <= marker.length + 16) return text.slice(0, maxChars)
  const payload = maxChars - marker.length
  const head = Math.floor(payload * 0.7)
  const tail = payload - head
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '')
}

function truncateArguments(raw, maxChars) {
  const preview = raw.slice(0, Math.max(0, maxChars - 96))
  return JSON.stringify({ _compaction_fit_truncated: true, originalChars: raw.length, preview })
}

/* ---------------------------------------------------------------- estimates */

/**
 * CJK-aware prompt-token estimate. The harness token meter uses 4 chars per
 * token, which undercounts Chinese/JSON prompts by ~3-4x; summaries must be
 * budgeted against something closer to the real tokenizer.
 * @param {string} text - prompt text.
 * @returns {number} approximate tokens.
 */
export function estimateText(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = text.match(CJK_RE)
  const cjkCount = cjk === null ? 0 : cjk.length
  return Math.ceil(cjkCount + (text.length - cjkCount) * 0.25)
}

function estimateMessage(message) {
  if (!isObject(message)) return 0
  let tokens = 8
  if (Array.isArray(message.content)) {
    for (const block of message.content) tokens += estimateBlock(block)
  }
  if (message.role === 'tool') tokens += 4
  return tokens
}

function estimateMessages(messages) {
  let total = 0
  for (const message of messages) total += estimateMessage(message)
  return total
}

function estimateBlock(block) {
  if (!isObject(block)) return 4
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return 4 + estimateText(block.text)
    case 'tool-call':
      return 8 + estimateText(block.name) + estimateText(block.arguments)
    case 'image':
      return block.offloaded === true ? 40 : 1200
    case 'file':
      return 300
    case 'tool-addition':
    case 'tool-removal':
      return 40
    default:
      return 12
  }
}

function estimateOverhead(options) {
  let tokens = 64
  if (typeof options.system === 'string') tokens += estimateText(options.system)
  if (Array.isArray(options.tools)) {
    try {
      tokens += estimateText(JSON.stringify(options.tools))
    } catch {
      tokens += 4000
    }
  }
  return tokens
}

/* ------------------------------------------------------------------- config */

export function normalizeConfig(config) {
  const raw = isObject(config) ? config : {}
  const budgets = new Map()
  if (isObject(raw.budgets)) {
    for (const [key, value] of Object.entries(raw.budgets)) {
      if (typeof key !== 'string' || !key.includes('/')) continue
      const tokens = int(value, 0, 1, 10000000)
      if (tokens > 0) budgets.set(key, tokens)
    }
  }
  return {
    trim: raw.trim !== false,
    suppressFabricatedOverflow: raw.suppressFabricatedOverflow !== false,
    suppressScope: raw.suppressScope === 'compaction' ? 'compaction' : 'all',
    retryOnPromptTooLong: raw.retryOnPromptTooLong !== false,
    maxRetries: int(raw.maxRetries, 2, 0, 5),
    shrinkRatio: number(raw.shrinkRatio, 0.5, 0.2, 0.9),
    contextRatio: number(raw.contextRatio, 0.9, 0.3, 1),
    safetyTokens: int(raw.safetyTokens, 8192, 0, 200000),
    minBudgetTokens: int(raw.minBudgetTokens, 16000, 1000, 1000000),
    maxBudgetTokens: int(raw.maxBudgetTokens, 1000000, 1000, 10000000),
    maxOutputReserveTokens: int(raw.maxOutputReserveTokens, 32768, 1024, 400000),
    minRetryBudgetTokens: int(raw.minRetryBudgetTokens, 4000, 512, 1000000),
    keepHeadGroups: int(raw.keepHeadGroups, 2, 0, 50),
    maxToolResultChars: int(raw.maxToolResultChars, 4000, 200, 400000),
    maxAssistantChars: int(raw.maxAssistantChars, 8000, 400, 400000),
    maxUserChars: int(raw.maxUserChars, 16000, 800, 800000),
    maxReasoningChars: int(raw.maxReasoningChars, 1000, 0, 200000),
    maxToolCallChars: int(raw.maxToolCallChars, 2000, 100, 200000),
    budgets,
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function int(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function number(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

/* ----------------------------------------------------------------- testing */

export const _internals = {
  buildGroups,
  capsForRound,
  estimateMessage,
  estimateMessages,
  estimateOverhead,
  estimateText,
  isFabricatedOverflow,
  isOverflowFailure,
  planRequest,
  promptTokens,
  resolveBudget,
  routeKey,
  truncateText,
}
