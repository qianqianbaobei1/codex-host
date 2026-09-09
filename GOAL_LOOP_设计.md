# codexhost gemini goal 自循环 — 实现设计（方案 A）

## 目标
在 codexhost 里让 **gemini(antigravity) 桥接线程** 具备"自己给自己发消息、持续做直到目标完成"的能力。
用户通过 gemini 对话输入 `/goal <目标>[，预算: <token>]` 触发；codexhost 自主持续驱动 gemini
连续 turn，直到 模型判定完成 / 达到预算 / 连续 N 轮无进展 / 用户中断，才停止。全程进度实时投影给
Codex Desktop。

## 复用现有机制（关键：不新建并行体系）

### 1. 自主 turn 启动模板（来自 `#startDelegatedExternalTurn`，app-server-host.ts:2853）
codexhost 已能在**不经过前端**的情况下给外部线程主动发起 turn：
```ts
const projection: ProjectedTurn = { projector: new CodexTurnProjector({ threadId, turnId, cwd, startedAtMs, initialInput }) };
thread.running = true; thread.activeTurnId = turnId;
thread.projectedTurns.set(turnId, projection);
thread.responseGates.set(turnId, { promise: Promise.resolve(), resolve: () => undefined });
const result = await thread.session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] });
```

### 2. 自主 turn 投影（`#projectHarnessOutput`）
`turn.autonomous.started` 事件已有处理 → 创建投影并置 running；`turn.completed` 会自动投影给前端、
push 到 `thread.turns`、把 `thread.running=false`、`activeTurnId=null`。

### 3. 完成后的钩子（`#consumeHarnessOutputs` 的 finally 块）
turn 完成后 `thread.running=false`、状态置 idle。这是挂载"下一步该不该续"逻辑的天然位置。

## Goal 状态结构（新增，存到 ExternalThread / 侧表）
```ts
interface GoalLoopState {
  goalId: string;          // uuid
  objective: string;       // 目标文本
  tokenBudget?: number;    // 预算上限（可选）
  tokensUsed: number;      // 累计
  consecutiveNoProgress: number;  // 连续无进展计数
  status: "active" | "paused" | "completed" | "stopped";
  createdAtMs: number; updatedAtMs: number;
  loopTurnCount: number;
}
```

## 实现模块（都在 app-server-host.ts / 一个独立 goal-loop.ts）

### 1. `/goal` 指令解析（在 `#startExternalTurn` / `#startDelegatedExternalTurn` 的入口拦截）
- 识别 `text.startsWith("/goal ")` → 解析目标 + 可选预算 → 初始化 goal state → **不**把 `/goal` 传给 gemini，
  而是转为一条"启动信号"（首轮注入：目标是 X，请开始，完成后用 `goal.done` 报告）。
- 非 `/goal` 的普通消息 → 原样走现有 turn 流程。

### 2. 首轮注入（goal 启动 turn）
- 第一条 turn 的 input 文本 = 目标 + goal 契约（含完成判定提示、预算提示）。

### 3. turn 完成后判定（在 finally / turn.completed 处）
- 读取本次 turn 结果（`#projectHarnessOutput` 投影后的 completedTurn / 或从 thread.turns 尾部）。
- 判定：
  - gemini 是否报告 `goal.done`（模型自判完成）→ completed
  - 累计 tokens 是否 ≥ budget → budget_limited
  - 连续 N 轮（默认 3）无实质进展 → stalled / blocked
  - 以上都不满足 → 继续
- 若继续 → 用模板再发起一轮 turn（input 为一条简短的"%goal continue%"提示）。

### 4. 停止写入
- 把最终状态（completed/stopped/budget）写入 goal state，向前端发 `thread/goal/updated` 投影事件
  + 一条 agent message 告知用户结果。

### 5. 手动中断
- 复用现有 `turn/interrupt` → `session.execute({type:"turn.cancel"})`，并把 goal 置为 stopped。

## 进度可见性（给 Codex Desktop）
- 每次自循环 turn 用 `CodexTurnProjector` 正常投影（前端能看到每一轮的 agent message）。
- 另发一个 `thread/goal/updated` 事件（含 status / tokensUsed / loopTurnCount），前端可展示进度条。

## 停止条件汇总（防失控）
| 条件 | 阈值 | 状态 |
|------|------|------|
| 模型自判完成（goal.done） | 一轮内 | completed |
| token 预算 | tokenBudget | budget_limited |
| 连续无进展 | 3 轮 | stalled |
| 用户中断 | /interrupt | stopped |
| 会话关闭 | thread close | stopped |

## 风险与边界
- `/goal` 会占用 gemini 的对话入口；普通消息不受影响。
- 自循环 turn 的 input 是 codexhost 注入的短提示，不是用户消息，前端显示会区分开（用 autonomous 语义）。
- 防失控：默认循环上限（如 50 轮）作为保底停止。
