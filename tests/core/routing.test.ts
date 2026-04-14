import { describe, it, expect } from "vitest";
import { routePreToolUse } from "../../hooks/core/routing.mjs";
import { createRoutingBlock } from "../../hooks/routing-block.mjs";
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

// Subagent routing uses createRoutingBlock(t, { includeCommands: false })
const _t = createToolNamer("claude-code");
const SUBAGENT_BLOCK = createRoutingBlock(_t, { includeCommands: false });

describe("Routing: Subagents (Agent only — Task removed per #241)", () => {
  it("Agent tool injects routing block into prompt field", () => {
    const fields = ["prompt", "request", "objective", "question", "query", "task"];

    for (const field of fields) {
      const toolInput = { [field]: "hello" };
      const decision = routePreToolUse("Agent", toolInput, "/test");

      expect(decision.action).toBe("modify");
      expect(decision.updatedInput[field]).toBe("hello" + SUBAGENT_BLOCK);
    }
  });

  it("Agent falls back to 'prompt' field if no known field is present", () => {
    const toolInput = { unknown_field: "content" };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe(SUBAGENT_BLOCK);
  });

  it("Agent converts subagent_type='Bash' to 'general-purpose'", () => {
    const toolInput = {
      prompt: "do something",
      subagent_type: "Bash"
    };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.prompt).toBe("do something" + SUBAGENT_BLOCK);
    expect(decision.updatedInput.subagent_type).toBe("general-purpose");
  });

  it("Agent preserves other fields when modifying", () => {
    const toolInput = {
      request: "analyze this",
      other_param: 123,
      nested: { a: 1 }
    };
    const decision = routePreToolUse("Agent", toolInput, "/test");

    expect(decision.action).toBe("modify");
    expect(decision.updatedInput.request).toBe("analyze this" + SUBAGENT_BLOCK);
    expect(decision.updatedInput.other_param).toBe(123);
    expect(decision.updatedInput.nested).toEqual({ a: 1 });
  });

  it("Agent routing block contains label guidance for batch_execute (#256)", () => {
    const decision = routePreToolUse("Agent", { prompt: "test" }, "/test");
    const prompt = decision.updatedInput.prompt;
    expect(prompt).toContain("label");
    expect(prompt).toContain("descriptive");
    expect(prompt).toContain("FTS5 chunk title");
  });

  it("Task tool is NOT routed — returns null (passthrough) (#241)", () => {
    const toolInput = { prompt: "create a task" };
    const decision = routePreToolUse("Task", toolInput, "/test");

    // Task should not be intercepted — it matches TaskCreate/TaskUpdate via substring
    expect(decision).toBeNull();
  });

  it("TaskCreate is NOT routed — returns null (passthrough)", () => {
    const decision = routePreToolUse("TaskCreate", { title: "my task" }, "/test");
    expect(decision).toBeNull();
  });

  it("TaskUpdate is NOT routed — returns null (passthrough)", () => {
    const decision = routePreToolUse("TaskUpdate", { id: "123", status: "done" }, "/test");
    expect(decision).toBeNull();
  });
});
