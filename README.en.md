# dsh-compaction-fit

Make DSH compaction summaries finish reliably behind **local OpenAI-compatible gateways**: trim the summary prompt to a real token budget, shrink and retry when upstream actually rejects it, and repair pi-ai's false "context overflow" classification for answers that already arrived in full.

English | [中文](README.md)

## The two failures it fixes

1. **The summary prompt exceeds the gateway's real limit.** `dsh-compaction-basic` sends the whole shadowed range as one summary request with no trimming and no retry, while the harness token meter assumes 4 characters per token — CJK text and JSON are undercounted by roughly 3–4×. Self-hosted relays (Qoder, WorkBuddy, AutoClaw, …) often serve a much larger window than their adapter declares, or reject long prompts outright, so the whole compaction attempt fails and the original request error surfaces.
2. **pi-ai's silent-overflow false positive.** When a response ends with `stop` and `input + cacheRead > contextWindow`, pi-ai ignores whether content actually arrived and fabricates `pi-ai detected context overflow for model "..."`. Compaction summaries always end in `stop`, so every successful summary was discarded; ordinary final text answers above the declared window were destroyed the same way.

## What it does

- **Trim before summarizing.** For `purpose: 'compaction'` requests it measures the prompt with a CJK-aware estimator, then truncates oversized tool results, assistant text, reasoning and tool arguments, and finally drops whole middle message groups with an elision note. Tool-call/result pairs stay together; the system prompt, the first group (usually the previous checkpoint) and the most recent groups are always kept.
- **Shrink and retry.** A genuine upstream rejection (`CONTEXT_WINDOW_EXCEEDED` or prompt-too-long wording) before any content is retried with `budget × shrinkRatio`, up to `maxRetries` times. Content already handed to the consumer is never retracted.
- **Repair the fabricated diagnostic.** Only a failure that matches pi-ai's exact wording, carries no `status`/`requestId`, and arrives after content is rewritten to `stop`. A real upstream rejection has no content and keeps its own message, so it is never swallowed.

The plugin only listens on `llm/stream`. It does not patch the harness, `app.asar`, or the session log; elided source events remain in the log.

## Install

Search for `dsh-compaction-fit` in the plugin market (Discover), or:

```sh
dsh plugin --profile web add dsh-compaction-fit
```

The package declares `dsh.bundle.patch`, so its `cordis.patch.yml` is applied as a bundle layer automatically — no manual profile patch editing. Restart DSH after a CLI install; market installs are hot.

Requires Node `^22.19.0 || >=24.0.0`. Tested on DSH `0.2.1-rc.2` (cordis `~4.0.5`); other 0.2.x releases depend on the same `llm/stream` chunk shapes.

## Configuration

Defaults shipped in the bundle patch:

| Key | Default | Meaning |
|---|---|---|
| `trim` | `true` | Budget-trim `purpose: 'compaction'` requests |
| `suppressFabricatedOverflow` | `true` | Repair pi-ai's fabricated overflow diagnostic |
| `suppressScope` | `all` | `all` covers ordinary requests too; `compaction` only summaries |
| `retryOnPromptTooLong` | `true` | Shrink and retry a genuine rejection |
| `maxRetries` | `2` | Retry attempts |
| `shrinkRatio` | `0.5` | Budget multiplier per retry |
| `contextRatio` | `0.9` | Unpinned budget = window × ratio − output reserve − safety |
| `safetyTokens` | `8192` | Safety margin |
| `maxOutputReserveTokens` | `32768` | Output-reserve cap |
| `minBudgetTokens` / `maxBudgetTokens` | `16000` / `1000000` | Budget clamp |
| `minRetryBudgetTokens` | `4000` | Retry-budget floor |
| `keepHeadGroups` | `2` | Extra head groups kept when the middle is elided |
| `budgets` | empty | `provider/model → prompt token budget`, overrides the declared window |

An unpinned model uses `max(declared contextWindow, largest successful prompt observed in this process)` as capacity. Observed values reset when the process restarts, so if your gateway serves much more than the adapter declares, pin it. Once the bundle is installed, append an override layer by id in your own `cordis.patch.yml`:

```yaml
- id: compaction-fit
  config:
    budgets:
      "qoder/deepseek-flash": 650000
```

Pin a prompt size the gateway has actually accepted; a too-large value is rejected upstream and then shrunk automatically.

## Behavior notes

- Messages are handled in groups: an assistant tool call plus its following tool results never split. The elision note is inserted only at group boundaries.
- Oversized tool arguments become valid JSON: `{"_compaction_fit_truncated":true,"originalChars":N,"preview":"..."}`.
- Character caps tighten over five rounds (down to 250 chars for tool results, 500 for assistant text); after that the elided middle keeps growing.
- Trace: `%TEMP%\dsh-compaction-fit.trace.log` (desktop info logs may be filtered). `apply called` on boot, then `intercepting llm/stream` on the first compaction request, followed by `trimmed ...`, `suppressed fabricated overflow ...` or `retrying ... after: ...`. The trace records routes, token estimates and error summaries only — never message content.

## Limitations

- Budgets are heuristic, not the upstream tokenizer; `safetyTokens` and `contextRatio` exist for that gap.
- Elided middle history is absent from that summary. The events stay in the session log but do not return to the model context; for a session whose earlier history is already covered by a checkpoint this is the cheapest recovery.
- No image offload (that is `dsh-compaction-image-offload`), and no splitting of an indivisible unit (an oversized tool result whose remainder cannot be pruned).
- Trimming and retry apply to `purpose: 'compaction'` only. Fabricated-overflow repair defaults to all requests because the same misclassification also destroys ordinary answers.

## Development

```sh
node --test test/guard.test.mjs
```

Thirteen tests cover CJK estimation, group-level trimming and tool pairing, fabricated-overflow repair, shrink-retry after a genuine overflow, no retry after content, and `suppressScope: compaction` leaving ordinary requests alone.

## License

MIT
