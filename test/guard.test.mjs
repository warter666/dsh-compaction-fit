import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GUARD_BYPASS,
  _internals,
  apply,
  normalizeConfig,
  trimRequest,
} from '../index.js'

const {
  buildGroups,
  estimateMessage,
  estimateMessages,
  estimateOverhead,
  estimateText,
  isFabricatedOverflow,
  isOverflowFailure,
  resolveBudget,
  routeKey,
  truncateText,
} = _internals

const INSTRUCTION = {
  role: 'user',
  content: [{
    type: 'text',
    text: 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint. Output EXACTLY the Markdown structure below.',
  }],
}

function system(text = 'You are a coding assistant.') {
  return { role: 'system', content: [{ type: 'text', text }] }
}

function user(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistant(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function toolTurn(index, chars) {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id: `call-${index}`,
        name: 'read_file',
        arguments: JSON.stringify({ path: `file-${index}.txt`, offset: 0, limit: 2000 }),
      }],
    },
    {
      role: 'tool',
      toolCallId: `call-${index}`,
      content: [{ type: 'text', text: `result-${index}: ` + 'x'.repeat(chars) }],
    },
    assistant(`Finished reading file ${index}.`),
  ]
}

function conversation(turns, chars) {
  const messages = [system(), user('Please inspect the repository and fix the failing tests.')]
  for (let index = 0; index < turns; index += 1) messages.push(...toolTurn(index, chars))
  messages.push(INSTRUCTION)
  return messages
}

function compactionOptions(messages, extra = {}) {
  return {
    provider: 'qoder',
    model: 'deepseek-flash',
    messages,
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    maxTokens: 32768,
    purpose: 'compaction',
    ...extra,
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function* fromChunks(chunks) {
  for (const chunk of chunks) yield chunk
}

function harness(config, responders, modelInfo = { context: { contextWindow: 180000 }, defaultMaxTokens: 32768 }) {
  let handler
  const calls = []
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    on(event, fn) {
      if (event === 'llm/stream') handler = fn
    },
    llm: {
      resolveModelInfo: async () => modelInfo,
      stream(options) {
        calls.push(options)
        const responder = responders.shift()
        if (responder === undefined) throw new Error('unexpected nested dispatch')
        return responder(options)
      },
    },
  }
  apply(ctx, config)
  return {
    calls,
    run(options) {
      const responder = responders.shift()
      if (responder === undefined) throw new Error('no responder for the first attempt')
      return handler(options, () => responder(options))
    },
  }
}

function textChunk(text) {
  return { type: 'text-delta', index: 0, text }
}

function usageChunk(inputTokens, cacheReadTokens = 0) {
  return { type: 'usage', usage: { inputTokens, outputTokens: 100, cacheReadTokens } }
}

function stopChunk() {
  return { type: 'finish', reason: { kind: 'stop' }, replayState: { provider: 'qoder' } }
}

function fabricatedOverflow(label = 'deepseek-flash') {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'CONTEXT_WINDOW_EXCEEDED',
        message: `pi-ai detected context overflow for model "${label}"`,
      },
    },
    replayState: { provider: 'qoder' },
  }
}

function genuineOverflow(message = 'prompt is too long: 39001 > 39000') {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message, status: 400 },
    },
  }
}

test('estimateText counts CJK closer to real tokenizers', () => {
  assert.equal(estimateText(''), 0)
  assert.equal(estimateText('abcd'), 1)
  assert.equal(estimateText('你好世界'), 4)
  assert.equal(estimateText('你好abcd'), 3)
  assert.equal(estimateText('…'), 1)
})

test('truncateText keeps both ends and stays within the cap', () => {
  const short = truncateText('abcdefghij', 5)
  assert.equal(short, 'abcde')
  const long = truncateText('a'.repeat(1000), 100)
  assert.equal(long.length, 100)
  assert.match(long, /compaction-fit/)
  assert.doesNotMatch(long, /a{100}/)
})

test('trimRequest elides the middle and preserves paired tool calls', () => {
  const messages = conversation(100, 10000)
  const originalCount = messages.length
  const options = compactionOptions(messages)
  const result = trimRequest(options, 30000, normalizeConfig({}))

  assert.equal(result.changed, true)
  assert.ok(result.estimatedTokens <= 30000, `estimated ${result.estimatedTokens} should fit 30000`)
  assert.equal(options.messages.length, originalCount, 'input options must not be mutated')
  assert.deepEqual(result.options.messages[0], system())
  assert.equal(result.options.messages.at(-1), INSTRUCTION)
  assert.ok(result.droppedMessages > 0)

  const note = result.options.messages.find((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === 'text' && block.text.startsWith('[compaction-fit:')))
  assert.ok(note, 'an elision note should be present')
  assert.equal(note.role, 'user')

  const openCalls = new Set()
  const keptTools = []
  for (const message of result.options.messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool-call') openCalls.add(block.id)
      }
    }
    if (message.role === 'tool') keptTools.push(message)
  }
  assert.ok(keptTools.length > 0)
  for (const message of keptTools) {
    assert.ok(openCalls.has(message.toolCallId), `tool result ${message.toolCallId} lost its tool call`)
  }
  for (const message of keptTools) {
    const text = message.content[0].text
    assert.ok(text.length <= 4000, `tool result should be truncated, got ${text.length}`)
  }
})

test('trimRequest leaves an already small request untouched', () => {
  const options = compactionOptions([system(), user('hi'), assistant('hello'), INSTRUCTION])
  const result = trimRequest(options, 30000, normalizeConfig({}))
  assert.equal(result.changed, false)
  assert.equal(result.options, options)
})

test('trimRequest can squeeze a single giant tool result', () => {
  const messages = [system(), user('read it'), ...toolTurn(0, 200000), INSTRUCTION]
  const options = compactionOptions(messages)
  const result = trimRequest(options, 2000, normalizeConfig({}))
  assert.equal(result.changed, true)
  assert.ok(result.estimatedTokens <= 2000, `estimated ${result.estimatedTokens} should fit 2000`)
  const tool = result.options.messages.find((message) => message.role === 'tool')
  assert.ok(tool, 'the most recent tool result must survive')
  assert.ok(tool.content[0].text.length <= 4000)
  assert.ok(tool.content[0].text.length < 200000)
})

test('resolveBudget honours declared, observed, and pinned capacities', async () => {
  const cfg = normalizeConfig({})
  const options = { provider: 'qoder', model: 'deepseek-flash', maxTokens: 32768 }
  const ctx = { llm: { resolveModelInfo: async () => ({ context: { contextWindow: 180000 } }) } }

  assert.equal(await resolveBudget(ctx, options, cfg, new Map(), undefined), 121040)

  const observed = new Map([[routeKey(options), 500000]])
  assert.equal(await resolveBudget(ctx, options, cfg, observed, undefined), 409040)

  const pinned = normalizeConfig({ budgets: { 'qoder/deepseek-flash': 700000 } })
  assert.equal(await resolveBudget(ctx, options, pinned, observed, undefined), 700000)
})

test('fabricated overflow after content is rewritten to stop', async () => {
  const options = { provider: 'qoder', model: 'deepseek-flash', messages: [user('hi')], purpose: 'chat' }
  const runner = harness({}, [
    () => fromChunks([textChunk('answer'), usageChunk(900, 200), fabricatedOverflow()]),
  ])
  const chunks = await collect(runner.run(options))
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1)
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.equal(chunks.at(-1).replayState.provider, 'qoder')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
})

test('fabricated overflow without content is not suppressed', async () => {
  const options = { provider: 'qoder', model: 'deepseek-flash', messages: [user('hi')], purpose: 'chat' }
  const runner = harness({}, [() => fromChunks([usageChunk(900, 200), fabricatedOverflow()])])
  const chunks = await collect(runner.run(options))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('genuine prompt-too-long shrinks the summary request and retries', async () => {
  const messages = conversation(30, 2000)
  const options = compactionOptions(messages)
  const runner = harness({ budgets: { 'qoder/deepseek-flash': 200000 }, maxRetries: 2 }, [
    () => fromChunks([usageChunk(20000), genuineOverflow()]),
    () => fromChunks([textChunk('summary'), usageChunk(9000), stopChunk()]),
  ])

  const chunks = await collect(runner.run(options))

  assert.equal(runner.calls.length, 1, 'the retry should use a nested shaped dispatch')
  assert.equal(runner.calls[0][GUARD_BYPASS], true)
  assert.ok(runner.calls[0].messages.length < messages.length)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'usage', 'finish'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('a genuine overflow after content is not retried', async () => {
  const messages = conversation(5, 1000)
  const options = compactionOptions(messages)
  const runner = harness({ budgets: { 'qoder/deepseek-flash': 200000 }, maxRetries: 2 }, [
    () => fromChunks([textChunk('partial'), usageChunk(20000), genuineOverflow()]),
  ])
  const chunks = await collect(runner.run(options))
  assert.equal(runner.calls.length, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('suppressScope=compaction leaves ordinary chat overflows alone', async () => {
  const options = { provider: 'qoder', model: 'deepseek-flash', messages: [user('hi')], purpose: 'chat' }
  const runner = harness({ suppressScope: 'compaction' }, [
    () => fromChunks([textChunk('answer'), usageChunk(900), fabricatedOverflow()]),
  ])
  const chunks = await collect(runner.run(options))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(runner.calls.length, 0)
})

test('diagnosis distinguishes fabricated and genuine failures', () => {
  assert.equal(isFabricatedOverflow(fabricatedOverflow().reason.failure), true)
  assert.equal(isFabricatedOverflow(genuineOverflow().reason.failure), false)
  assert.equal(isFabricatedOverflow({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'pi-ai detected context overflow for model "x"', status: 400 }), false)
  assert.equal(isOverflowFailure(genuineOverflow().reason.failure), true)
  assert.equal(isOverflowFailure({ code: 'RATE_LIMIT', message: 'slow down' }), false)
})

test('grouping keeps tool calls and their results together', () => {
  const groups = buildGroups([system(), user('go'), ...toolTurn(0, 100), INSTRUCTION])
  assert.deepEqual(groups.map((group) => group.indices), [[0], [1], [2, 3], [4], [5]])
  assert.equal(groups[0].pinned, true)
  const message = { role: 'tool', content: [{ type: 'text', text: 'x' }] }
  assert.ok(estimateMessage(message) > 0)
  assert.ok(estimateMessages([message, message]) > estimateMessage(message))
  assert.ok(estimateOverhead({ tools: [{ name: 'x', description: 'y', parameters: {} }] }) > 64)
})
