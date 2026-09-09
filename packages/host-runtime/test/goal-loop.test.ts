import { describe, expect, it } from "vitest";

import {
  advanceGoalLoop,
  createGoalLoop,
  goalContinuePrompt,
  goalSeedPrompt,
  hasTurnProgress,
  isGoalDone,
  lastAgentMessageText,
  parseGoalDecision,
  parseGoalCommand,
  setGoalStatus,
  toThreadGoal,
  updateGoalActiveTime,
} from "../src/goal-loop.js";

describe("parseGoalCommand", () => {
  it("parses a plain goal command", () => {
    expect(parseGoalCommand("/goal 调研当前 AI 格局")).toEqual({
      objective: "调研当前 AI 格局",
    });
  });

  it("parses a goal with a Chinese budget suffix", () => {
    expect(parseGoalCommand("/goal 分析代码，预算: 50000")).toEqual({
      objective: "分析代码",
      tokenBudget: 50000,
    });
  });

  it("parses a goal with an ASCII budget suffix", () => {
    expect(parseGoalCommand("/goal 修个 bug; budget: 20000")).toEqual({
      objective: "修个 bug",
      tokenBudget: 20000,
    });
  });

  it("returns null for non-goal text", () => {
    expect(parseGoalCommand("帮我写段代码")).toBeNull();
  });

  it("returns null for an empty goal", () => {
    expect(parseGoalCommand("/goal")).toBeNull();
  });

  it("ignores a zero/negative budget and keeps the goal", () => {
    expect(parseGoalCommand("/goal 做点事，预算: 0")).toEqual({
      objective: "做点事",
    });
  });
});

describe("createGoalLoop / advanceGoalLoop", () => {
  it("starts active with zero counters", () => {
    const goal = createGoalLoop("目标", 1000);
    expect(goal.status).toBe("active");
    expect(goal.tokensUsed).toBe(0);
    expect(goal.loopTurnCount).toBe(0);
    expect(goal.tokenBudget).toBe(1000);
  });

  it("stays active while making progress under budget", () => {
    const goal = createGoalLoop("目标", 1000);
    advanceGoalLoop(goal, 100, true);
    expect(goal.status).toBe("active");
    expect(goal.tokensUsed).toBe(100);
    expect(goal.loopTurnCount).toBe(1);
    expect(goal.consecutiveNoProgress).toBe(0);
  });

  it("marks budget_limited when tokens reach the budget", () => {
    const goal = createGoalLoop("目标", 1000);
    advanceGoalLoop(goal, 600, true);
    advanceGoalLoop(goal, 400, true);
    expect(goal.status).toBe("budget_limited");
  });

  it("marks stalled after 3 consecutive no-progress turns", () => {
    const goal = createGoalLoop("目标");
    advanceGoalLoop(goal, 0, false);
    advanceGoalLoop(goal, 0, false);
    expect(goal.status).toBe("active");
    advanceGoalLoop(goal, 0, false);
    expect(goal.status).toBe("blocked");
    expect(goal.stopReason).toBe("no_progress");
  });

  it("resets the stall counter on progress", () => {
    const goal = createGoalLoop("目标");
    advanceGoalLoop(goal, 0, false);
    advanceGoalLoop(goal, 0, false);
    advanceGoalLoop(goal, 0, true);
    expect(goal.consecutiveNoProgress).toBe(0);
    expect(goal.status).toBe("active");
  });
});

describe("goal markers / prompts", () => {
  it("isGoalDone detects the marker anywhere in the response", () => {
    expect(isGoalDone("完成目标了\ngoal.done")).toBe(true);
    expect(isGoalDone("还在做")).toBe(false);
  });

  it("seed prompt embeds the objective and budget", () => {
    const prompt = goalSeedPrompt(createGoalLoop("调查 X", 5000));
    expect(prompt).toContain("调查 X");
    expect(prompt).toContain("5000");
    expect(prompt).toContain('"goal_event":"complete"');
    expect(prompt).toContain('"completion_evidence"');
  });

  it("continue prompt requests self-driven continuation", () => {
    expect(goalContinuePrompt()).toContain("JSON complete");
  });

  it("parses only an exact terminal JSON decision line", () => {
    expect(
      parseGoalDecision(
        'I am done discussing the marker.\n{"version":1,"goal_event":"complete","goal_revision":2,"completion_evidence":[{"type":"file","path":"REPORT.md"}]}',
      ),
    ).toMatchObject({
      kind: "complete",
      goalRevision: 2,
      completionEvidence: [{ type: "file", path: "REPORT.md" }],
    });
    expect(parseGoalDecision('The JSON is {"version":1,"goal_event":"complete"}')).toBeNull();
    expect(
      parseGoalDecision(
        '{"version":1,"goal_event":"blocked","blocker_fingerprint":"network:npm"}',
      ),
    ).toMatchObject({ kind: "blocked", blockerFingerprint: "network:npm" });
    expect(parseGoalDecision('{"version":1,"goal_event":"blocked"}')).toBeNull();
  });

  it("blocks only after the same blocker repeats three times", () => {
    const goal = createGoalLoop("目标");
    advanceGoalLoop(goal, 0, false, Date.now(), "network:npm");
    advanceGoalLoop(goal, 0, false, Date.now(), "network:npm");
    expect(goal.status).toBe("active");
    advanceGoalLoop(goal, 0, false, Date.now(), "network:npm");
    expect(goal.status).toBe("blocked");
    expect(goal.stopReason).toBe("same_blocker");
  });

  it("resets the blocker counter when the blocker changes or progress appears", () => {
    const goal = createGoalLoop("目标");
    advanceGoalLoop(goal, 0, false, Date.now(), "network:npm");
    advanceGoalLoop(goal, 0, false, Date.now(), "auth:github");
    expect(goal.blockerStallCount).toBe(1);
    advanceGoalLoop(goal, 0, true, Date.now(), "auth:github");
    expect(goal.blockerStallCount).toBe(0);
    expect(goal.blockerFingerprint).toBeUndefined();
  });

  it("recognizes concrete file, command, and tool work as progress", () => {
    expect(
      hasTurnProgress({ items: [{ type: "fileChange" }] }),
    ).toBe(true);
    expect(
      hasTurnProgress({ items: [{ type: "commandExecution", status: "completed", exitCode: 0 }] }),
    ).toBe(true);
    expect(
      hasTurnProgress({ items: [{ type: "toolExecution", status: "completed", success: true }] }),
    ).toBe(true);
    expect(hasTurnProgress({ items: [{ type: "agentMessage", text: "long prose" }] })).toBe(false);
  });
});

describe("lastAgentMessageText", () => {
  it("extracts text from agentMessage items using the projector's text field", () => {
    const turn = {
      items: [
        { type: "userMessage", output: { content: [{ type: "text", text: "hi" }] } },
        { type: "agentMessage", text: "final reply", itemId: "a" },
      ],
    };
    expect(lastAgentMessageText(turn)).toBe("final reply");
  });

  it("falls back to output.content[].text for harness snapshots", () => {
    const turn = {
      items: [
        {
          type: "agentMessage",
          output: {
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        },
      ],
    };
    expect(lastAgentMessageText(turn)).toBe("first\nsecond");
  });

  it("returns empty for malformed turns", () => {
    expect(lastAgentMessageText(null)).toBe("");
    expect(lastAgentMessageText({ items: "nope" })).toBe("");
    expect(lastAgentMessageText({ items: [{ type: "agentMessage" }] })).toBe("");
  });
});

describe("toThreadGoal & time tracking", () => {
  it("converts GoalLoopState to standard ThreadGoal format", () => {
    const goal = createGoalLoop("测试目标", 5000);
    const serialized = toThreadGoal(goal);

    expect(serialized.id).toBe(goal.goalId);
    expect(serialized.objective).toBe("测试目标");
    expect(serialized.status).toBe("active");
    expect(serialized.tokenBudget).toBe(5000);
    expect(serialized.tokensUsed).toBe(0);
    expect(serialized.timeUsedSeconds).toBe(0);
    expect(serialized.createdAt).toBe(Math.floor(goal.createdAtMs / 1000));
    expect(serialized.updatedAt).toBe(Math.floor(goal.updatedAtMs / 1000));
  });

  it("accumulates elapsed seconds and handles status transitions", () => {
    const goal = createGoalLoop("测试目标");
    const t0 = goal.createdAtMs;

    // Simulate 5 seconds elapsed while active
    updateGoalActiveTime(goal, t0 + 5000);
    expect(goal.timeUsedSeconds).toBe(5);
    expect(goal.updatedAtMs).toBe(t0 + 5000);

    // Pause the goal after another 3 seconds
    setGoalStatus(goal, "paused", t0 + 8000);
    expect(goal.status).toBe("paused");
    expect(goal.timeUsedSeconds).toBe(8);

    // While paused, time should not accumulate
    updateGoalActiveTime(goal, t0 + 15000);
    expect(goal.timeUsedSeconds).toBe(8);

    // Complete the goal
    setGoalStatus(goal, "complete", t0 + 15000);
    expect(goal.status).toBe("complete");
    expect(toThreadGoal(goal).status).toBe("complete");
  });
});
