# dsh-compaction-fit

让 DSH 的上下文压缩在**本地 OpenAI 兼容网关**上真正能跑完：摘要前按真实 token 预算裁剪、被上游拒绝时缩小预算重试，并修掉 pi-ai 把「已经完整到达的回答」误判成上下文溢出。

[English](README.en.md) | 中文

## 它解决的两个问题

1. **摘要请求超出上游真实限制。** `dsh-compaction-basic` 把整段被压缩历史塞进摘要请求，既不裁剪也不重试；harness 的 token meter 又按 4 字符/token 估算，中文和 JSON 会被低估 3–4 倍。自建反代（Qoder / WorkBuddy / AutoClaw 等）实际窗口和 adapter 声明值经常对不上，摘要请求就这样被顶回去，整个压缩失败，原始报错浮到用户面前。
2. **pi-ai 的静默溢出误判。** 当响应以 `stop` 结束、且 `input + cacheRead > contextWindow`（adapter 声明的窗口）时，pi-ai 不看内容是否已经到齐，直接伪造一条 `pi-ai detected context overflow for model "..."`。压缩摘要总是以 `stop` 结束，于是每一次成功的摘要都被丢弃；普通对话的最终文本回答同样会被毁掉。

## 它做什么

- **摘要前裁剪**：用 CJK 感知的估算器衡量 `purpose: 'compaction'` 请求；超预算时先按字符上限截断超长工具结果、assistant 文本、reasoning 和工具参数，仍不够再按「工具调用 + 结果」整组省略中间历史，插入一条省略说明。system、首组（通常是上一个 checkpoint）和最近若干组始终保留。
- **缩小重试**：上游真的拒绝（`CONTEXT_WINDOW_EXCEEDED` 或 `prompt too long` 一类错误，且尚未产出任何内容）时，按 `shrinkRatio` 几何缩小预算重发，最多 `maxRetries` 次。已经流出的内容不会被撤回重试。
- **纠正伪造溢出**：只在上游诊断是 pi-ai 的伪造措辞、没有 `status`/`requestId`、且流里已经有内容时，把 finish 改回 `stop` 并保留回答。真实上游拒绝没有内容、消息也是上游原文，不会被吞掉。

插件只挂在 `llm/stream` 上，不修改 harness、不修改 `app.asar`、不改会话日志；被省略的原文仍完整保存在 session log 里。

## 安装

在市场（Discover）里搜 `dsh-compaction-fit` 点安装，或：

```sh
dsh plugin --profile web add dsh-compaction-fit
```

`package.json` 声明了 `dsh.bundle.patch`，安装时 `cordis.patch.yml` 会作为 bundle 层自动并入，无需手工编辑 profile 的 patch。装完重启 DSH（市场里的热安装不需要）。

要求：Node `^22.19.0 || >=24.0.0`，DSH `0.2.1-rc.2`（cordis `~4.0.5`）已实测；其他 0.2.x 版本请以 `llm/stream` 的 chunk 形状为准。

## 配置

默认值（随包 patch）：

| 键 | 默认 | 说明 |
|---|---|---|
| `trim` | `true` | 对 `purpose: 'compaction'` 请求做预算裁剪 |
| `suppressFabricatedOverflow` | `true` | 纠正 pi-ai 伪造的溢出诊断 |
| `suppressScope` | `all` | `all` 覆盖普通请求；`compaction` 只覆盖摘要 |
| `retryOnPromptTooLong` | `true` | 真拒绝时缩小重试 |
| `maxRetries` | `2` | 最多重试次数 |
| `shrinkRatio` | `0.5` | 每次重试把预算乘以该系数 |
| `contextRatio` | `0.9` | 未 pin 时，预算 = 窗口 × 该系数 − 输出预留 − 安全余量 |
| `safetyTokens` | `8192` | 安全余量 |
| `maxOutputReserveTokens` | `32768` | 输出预留上限 |
| `minBudgetTokens` / `maxBudgetTokens` | `16000` / `1000000` | 预算夹取范围 |
| `minRetryBudgetTokens` | `4000` | 重试预算下限 |
| `keepHeadGroups` | `2` | 省略中间段时额外保留的开头组数 |
| `budgets` | 空 | `provider/model → prompt token 预算`，显式覆盖声明窗口 |

未 pin 的模型用 `max(声明 contextWindow, 本进程观察到的最大成功 prompt)` 作为容量，再套上面的公式。观察值来自正常完成的 `usage` 分片，进程重启后从声明窗口重新开始——所以如果你的网关实际窗口远大于声明值，建议直接 pin：

插件作为 bundle 安装后，在你自己的 `cordis.patch.yml` 里按 id 追加覆盖层即可（同一 id 的后层配置覆盖前层）：

```yaml
- id: compaction-fit
  config:
    budgets:
      "qoder/deepseek-flash": 650000
```

pin 的值应来自该网关**实际接受过**的 prompt 大小；写大了会被真实拒绝，然后自动缩半重试。

## 行为细节

- 消息按组处理：assistant 的 `tool-call` 与紧随其后的 `tool` 结果是一组，不会被拆开；省略说明只插在组边界。
- 超长工具参数替换为合法 JSON 的 `{"_compaction_fit_truncated":true,"originalChars":N,"preview":"..."}`，避免上游校验失败。
- 字符上限分 5 轮逐步收紧（最低工具结果 250 字符、assistant 500 字符）；仍不够就继续扩大被省略的中间段。
- 观察日志：`%TEMP%\dsh-compaction-fit.trace.log`（桌面端 info 日志可能被过滤）。启动时写 `apply called`；第一次命中 compaction 请求时写 `intercepting llm/stream`，之后是 `trimmed ...`、`suppressed fabricated overflow ...` 或 `retrying ... after: ...`。
- trace 只记录路由、token 估算和错误摘要，不记录消息内容。

## 已知限制

- 预算用启发式估算，不是上游 tokenizer 的精确值；`safetyTokens` 和 `contextRatio` 就是为此留的余量。
- 中间历史被省略后，本次摘要不会包含那部分细节；原始事件仍在 session log，但不会回到模型上下文。对已经有 checkpoint 覆盖早期内容的会话，这是代价最小的恢复方式。
- 不处理图片 offload（交给 `dsh-compaction-image-offload`），也不拆分单个不可分单元（超大工具结果的剩余部分）。
- 只对 `purpose: 'compaction'` 做裁剪与重试；伪造溢出纠正默认覆盖所有请求，因为同一条误判同样会毁掉普通回答。

## 开发

```sh
node --test test/guard.test.mjs
```

13 个测试覆盖 CJK 估算、组级裁剪与工具配对、伪造溢出纠正、真实溢出后的缩小重试、有内容时不重试，以及 `suppressScope: compaction` 不拦截普通请求。

## 许可证

MIT
