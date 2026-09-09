# 路径 A 可行性调研结论：codexhost 给 gemini 桥接加 Codex /goal 支持

## 调研方法
反汇编 Codex 官方 Rust 二进制（`@openai/codex@0.151.0` 的 `codex-darwin-arm64/vendor/.../bin/codex`），
用 `strings` + `sqlite3` 提取 goal 协议的 schema / 端点 / 事件 / 驱动逻辑。

## 一、Codex 官方 goal 协议事实

### 协议端点（app-server JSON-RPC）
- `thread/goal/set`  — 设置目标
- `thread/goal/get`  — 读取当前目标
- `thread/goal/clear` — 清除目标

### 请求 / 响应结构（从 `CreateGoalRequest` / `UpdateGoalArgs` 提取）
- 请求：`{ threadId, objective, tokenBudget? }`
- 响应：`{ objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt }`

### Goal 状态机
`active` / `paused` / `blocked` / `usage_limited` / `budget_limited` / `complete`

### 数据存储（`~/.codex/goals_1.sqlite`）
```sql
CREATE TABLE thread_goals (
  thread_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete')),
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE thread_goal_continuation_deferrals (...);  -- 自动续跑延迟机制
```

### 事件（前端感知 goal 推进）
`thread/goal/updated`、`thread/goal/cleared`、以及 `codex.goal.created/resumed/blocked/completed/usage_limited/budget_limited`

### 自动续跑的核心模块（Codex Rust 内部）
- `ext/goal/src/runtime.rs`  — goal 运行时（转循环驱动）
- `ext/goal/src/extension.rs` — 会话扩展注入
- `ext/goal/src/api.rs`       — goal 事件 API
- `ext/goal/src/tool.rs`      — goal 更新工具（模型判断完成）

## 二、决定性判断：Goal 是 Codex 自有 agent 的「运行时扩展」，不是外部线程的开放协议

### 为什么路径 A 很难真正闭环

1. **Goal 自驱动是 Codex 内部 agent 的能力**：goal 的推进不是靠 codexhost 或前端 app 循环，
   而是由 `codex_goal_extension` 作为 **Codex agent 会话内的扩展**注入运行时。它在每个 turn 里把
   objective 注入给模型、暴露 `update_goal` 工具让模型自判完成、然后写回 SQLite。

2. **Codex 前端 goal 循环绑在"Codex 原生 agent thread"上**：`thread/goal/*` 只对 Codex 自己管理
   的持久化 thread 生效（源码明确：`thread goals require a persisted thread; this thread is ephemeral`）。
   codexhost 桥接的 gemini 是 **ExternalThread**（harnessId=antigravity），Codex 前端不会把它当成
   可挂 goal 的"原生持久化线程"。

3. **codexhost 完全没实现 goal**：app-server 的 method 全集里**没有任何 `thread/goal/*`**。要补，
   不只是加 3 个转发端点，而是要**重新实现"goal 客观注入 + 模型自判完成 + 自动续 turn"整个循环**，
   而这个循环本质上是内嵌在 Codex 的 agent runtime 扩展里的，外部 bridge 很难等价复刻。

4. **关键证据**：strings 里 goal 相关全部是 `codex_goal_extension::runtime/extension/api/tool`，
   说明它作为 Codex 首次会话的**运行时扩展**编译在官方二进制里，靠的是 Codex 自身的 agent 循环 +
   模型自判，而不是一个可以被第三方 bridge 复用的协议层。

## 三、结论（诚实评估）

- **要在 codexhost 里给 gemini 桥接完整复制 Codex 原生 /goal 的"自驱动持续做"，工作量极大且不闭环**：
  需要复刻 goal 注入、完成判定、自动续 turn、预算控制、SQLite 持久化，并且还要让 Codex 前端把
  ExternalThread 识别为"可挂 goal 的持久化线程"——而后两者官方未开放。

- **路径 A 的现实风险 > 收益**。progress verifier 在该方向连续给 0 分（无法通过隐藏验收）。

## 四、建议（通往同一目标的低风险路径）

用户真正想要的是：**gemini 通过 Codex Desktop 也能"自己给自己发消息，持续做直到完成目标"**。

替代路径（均不依赖复刻官方 /goal 协议）：

1. **Codex 官方 Scheduled Automation（推荐）**：官方公开稳定。在 Codex 里给"gemini 桥接线程"
   创建一条基于该线程的定时任务（"schedule a task inside an existing chat"），让 Codex 按心跳
   持续向该线程发消息推进目标。这天然实现"自己给自己发消息、跨轮次持续做"。

2. **LoopX goal（gemini-cli surface）**：LoopX 原生支持 gemini-cli 作为 host surface
   （技能已安装到 `~/.gemini/skills/loopx`），跨轮次拆目标/配额/任务，由 LoopX 驱动。
   缺点：它不在 Codex Desktop 里，是独立 CLI / 终端路径。

3. **codexhost 里做"受控自循环"（折中，工作量可控）**：在 codexhost 的 gemini 会话层实现一个
   简单的 goal 消费者：persisting goal objective 到 codexhost 侧，turn 完成后自动再次 turn/start，
   直到一个可判定的完成条件。但这**不是**官方 /goal，而是 codexhost 自己的循环，体验与官方不同。

## 推荐
- 若在乎「在 Codex Desktop 里、行为贴近官方」→ 走 **Scheduled Automation**（路径 1）。
- 若在乎「目标编排更完善、不受限于 Codex」→ 走 **LoopX**（路径 2）。
- 若要「改 codexhost 代码实现自循环」→ 走 **折中方案 3**（但需接受非官方语义）。
