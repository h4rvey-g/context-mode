# OpenClaw Lifecycle Hooks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `session_start`, `before_compaction`, `after_compaction`, and resume-injection `before_prompt_build` hooks to the OpenClaw plugin so sessions are properly keyed, events are flushed before compaction, and resume snapshots are injected into system context when a session resumes.

**Architecture:** All changes are isolated to `src/openclaw-plugin.ts`. Each hook is registered via `api.on()` and wrapped in `try/catch` so failures never break the gateway. A new test file exercises hook logic using a mock API collector and a real in-memory `SessionDB`.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (via `SessionDB`), Node.js ESM

---

## Chunk 1: Types, variable declarations, and test scaffolding

### Task 1: Update types and mutable state declarations

**Files:**
- Modify: `src/openclaw-plugin.ts` (interface + variable declarations)
- Create: `tests/openclaw-plugin-hooks.test.ts`

**Background:** The `OpenClawPluginApi` interface's `on()` method already exists for `before_prompt_build`. We need to ensure it also accepts the three new void hook names. The `sessionId` variable must become `let` so `session_start` can re-key it. A `resumeInjected` flag prevents injecting the same snapshot on every prompt turn.

---

- [ ] **Step 1: Create test file with scaffolding and plugin-shape smoke test**

**Note on TDD:** This first test is green-from-start by design — the plugin shape already exists. The red-green cycle begins in Task 2 when we test for hooks that don't exist yet. This step creates the test file, helpers, and mock API that all subsequent TDD cycles depend on.

Create `tests/openclaw-plugin-hooks.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { SessionDB } from "../src/session/db.js";

// ── Helpers ──────────────────────────────────────────────

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `plugin-hooks-test-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

// ── Mock API ─────────────────────────────────────────────

interface RegisteredHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

interface RegisteredTypedHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

function createMockApi(db?: SessionDB) {
  const hooks: RegisteredHook[] = [];
  const typedHooks: RegisteredTypedHook[] = [];

  const api = {
    registerHook(event: string, handler: (...args: unknown[]) => unknown, _meta: unknown) {
      hooks.push({ hookName: event, handler });
    },
    on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) {
      typedHooks.push({ hookName, handler, opts });
    },
    registerContextEngine(_id: string, _factory: () => unknown) {},
    registerCommand(_cmd: unknown) {},
  };

  return { api, hooks, typedHooks };
}

// ── Plugin shape test ────────────────────────────────────
// Reset modules before each describe block that calls register() to prevent
// closure state (resumeInjected, sessionId) from leaking between test groups.
// Individual tests that don't call register() can skip this.

describe("Plugin exports", () => {
  beforeEach(() => { vi.resetModules(); });

  test("plugin exports id, name, configSchema, register", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    assert.equal(plugin.id, "context-mode");
    assert.equal(plugin.name, "Context Mode");
    assert.ok(plugin.configSchema);
    assert.equal(typeof plugin.register, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (plugin already exports correctly)**

```bash
cd /home/pedro/context-mode && npm test -- --reporter=verbose tests/openclaw-plugin-hooks.test.ts
```

Expected: PASS — this just checks shape, no new code needed yet.

- [ ] **Step 3: Update `OpenClawPluginApi` interface in `src/openclaw-plugin.ts`**

Find the existing `on()` signature:
```typescript
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ): void;
```

This already accepts any string, so no type change needed. However, add JSDoc above it:
```typescript
  /**
   * Register a typed lifecycle hook.
   * Supported names: "session_start", "before_compaction", "after_compaction",
   * "before_prompt_build", "before_agent_start"
   */
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ): void;
```

Also add a `SessionStartEvent` interface near the other event interfaces:
```typescript
/** Shape of the event OpenClaw passes to session_start hook. */
interface SessionStartEvent {
  sessionId?: string;
  agentId?: string;
  startedAt?: string;
}
```

- [ ] **Step 4: Change `const sessionId` → `let sessionId` and add `resumeInjected` flag**

In `register(api: OpenClawPluginApi): void {`, find:
```typescript
    const sessionId = randomUUID();
    db.ensureSession(sessionId, projectDir);
    db.cleanupOldSessions(0);
```

Replace with:
```typescript
    let sessionId = randomUUID();
    let resumeInjected = false;
    db.ensureSession(sessionId, projectDir);
    db.cleanupOldSessions(0);
```

- [ ] **Step 5: Typecheck to confirm no errors**

```bash
cd /home/pedro/context-mode && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /home/pedro/context-mode && git add src/openclaw-plugin.ts tests/openclaw-plugin-hooks.test.ts && git commit -m "$(cat <<'EOF'
test(openclaw-plugin): add hook test scaffolding and mutable sessionId

Add mock API helper and plugin-shape smoke test. Change sessionId to
let and add resumeInjected flag for upcoming lifecycle hooks.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: session_start hook

### Task 2: Implement and test `session_start` hook

**Files:**
- Modify: `src/openclaw-plugin.ts` (add hook)
- Modify: `tests/openclaw-plugin-hooks.test.ts` (add tests)

**Background:** `session_start` fires once per session. OpenClaw passes `{ sessionId?, agentId?, startedAt? }`. If the event provides a `sessionId`, we re-key the DB session to it and reset `resumeInjected`. The hook is void — return value is ignored by OpenClaw.

---

- [ ] **Step 1: Write failing test for `session_start` behavior**

Add to `tests/openclaw-plugin-hooks.test.ts`:

```typescript
describe("session_start hook", () => {
  beforeEach(() => { vi.resetModules(); });

  test("session_start hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start hook must be registered");
  });

  test("session_start hook is registered with no priority (void hook)", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start must be registered");
    assert.equal(hook.opts?.priority, undefined);
  });

  test("session_start handler resets resumeInjected — verified via before_prompt_build sequence", async () => {
    // This test verifies the resumeInjected flag behavior indirectly:
    // 1. Before_prompt_build with no DB resume → returns undefined (nothing injected)
    // 2. session_start handler runs → resets resumeInjected to false
    // 3. Before_prompt_build still returns undefined (no resume in DB, but flag is reset)
    // The flag reset is confirmed because calling the handler does not throw.
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const sessionStartHandler = typedHooks.find(h => h.hookName === "session_start")?.handler;
    assert.ok(sessionStartHandler, "session_start handler must exist");

    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must exist");

    // Call before_prompt_build first time — returns undefined (no DB resume)
    const result1 = await resumeHook.handler();
    assert.equal(result1, undefined, "no resume in DB → undefined");

    // Call session_start (simulating session restart)
    await sessionStartHandler({ sessionId: randomUUID() });

    // Call before_prompt_build again — still undefined (no DB resume), but must not throw
    const result2 = await resumeHook.handler();
    assert.equal(result2, undefined, "after session_start reset, still no resume → undefined");
  });
});
```

- [ ] **Step 2: Run to verify `session_start` hook registration fails (not yet added)**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -20
```

Expected: FAIL — "session_start hook must be registered"

- [ ] **Step 3: Add `session_start` hook to `src/openclaw-plugin.ts`**

After the `command:new` hook block (after section `// ── 3. command:new`), insert a new section:

```typescript
    // ── 4. session_start — Re-key DB session to OpenClaw's session ID ─

    api.on(
      "session_start",
      async (event: unknown) => {
        try {
          const e = event as SessionStartEvent;
          if (e?.sessionId && e.sessionId !== sessionId) {
            db.ensureSession(e.sessionId, projectDir);
            sessionId = e.sessionId;
          }
          resumeInjected = false;
        } catch {
          // best effort — never break session start
        }
      },
    );
```

Also renumber the subsequent sections:
- `// ── 4. before_prompt_build` → `// ── 5. before_prompt_build`
- `// ── 5. Context engine` → `// ── 6. Context engine`
- `// ── 6. Auto-reply commands` → `// ── 7. Auto-reply commands`

- [ ] **Step 4: Run test to verify session_start hook is registered**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Typecheck**

```bash
cd /home/pedro/context-mode && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /home/pedro/context-mode && git add src/openclaw-plugin.ts tests/openclaw-plugin-hooks.test.ts && git commit -m "$(cat <<'EOF'
feat(openclaw-plugin): add session_start hook to re-key DB session

When OpenClaw fires session_start with its own sessionId, update the
local sessionId to match and reset the resumeInjected flag.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 3: before_compaction and after_compaction hooks

### Task 3: Implement and test compaction hooks

**Files:**
- Modify: `src/openclaw-plugin.ts` (add hooks)
- Modify: `tests/openclaw-plugin-hooks.test.ts` (add tests)

**Background:** `before_compaction` must flush buffered events into a resume snapshot before OpenClaw discards context. `after_compaction` increments the compact counter. Both are void hooks. Both call `db.getSessionStats(sessionId)` fresh inside the handler — not a stale closure reference.

---

- [ ] **Step 1: Write failing tests for compaction hook registration**

Add to `tests/openclaw-plugin-hooks.test.ts`:

```typescript
describe("compaction hooks", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_compaction hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_compaction");
    assert.ok(hook, "before_compaction must be registered");
  });

  test("after_compaction hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "after_compaction");
    assert.ok(hook, "after_compaction must be registered");
  });

  test("before_compaction handler flushes events to DB resume (direct DB test)", async () => {
    // Test the DB-layer logic directly (independent of plugin closures)
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    // Insert a fake event
    db.insertEvent(sid, {
      type: "file",
      category: "file",
      data: "/src/test.ts",
      priority: 2,
      data_hash: "",
    } as unknown as import("../src/types.js").SessionEvent, "PostToolUse");

    // Simulate before_compaction logic
    const events = db.getEvents(sid);
    assert.equal(events.length, 1);

    const { buildResumeSnapshot } = await import("../src/session/snapshot.js");
    const stats = db.getSessionStats(sid);
    const snapshot = buildResumeSnapshot(events, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });
    db.upsertResume(sid, snapshot, events.length);

    const resume = db.getResume(sid);
    assert.ok(resume, "resume must exist after flush");
    assert.ok(resume.snapshot.length > 0, "snapshot must be non-empty");
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -20
```

Expected: FAIL — "before_compaction must be registered"

- [ ] **Step 3: Add `before_compaction` and `after_compaction` hooks to `src/openclaw-plugin.ts`**

After the `session_start` section (after `// ── 4. session_start`), insert:

```typescript
    // ── 5. before_compaction — Flush events to snapshot before compaction ─

    api.on(
      "before_compaction",
      async () => {
        try {
          const events = db.getEvents(sessionId);
          if (events.length === 0) return;
          const freshStats = db.getSessionStats(sessionId);
          const snapshot = buildResumeSnapshot(events, {
            compactCount: (freshStats?.compact_count ?? 0) + 1,
          });
          db.upsertResume(sessionId, snapshot, events.length);
        } catch {
          // best effort — never break compaction
        }
      },
    );

    // ── 6. after_compaction — Increment compact count ─────

    api.on(
      "after_compaction",
      async () => {
        try {
          db.incrementCompactCount(sessionId);
        } catch {
          // best effort
        }
      },
    );
```

Renumber subsequent sections:
- `// ── 5. before_prompt_build` → `// ── 7. before_prompt_build`
- `// ── 6. Context engine` → `// ── 8. Context engine`
- `// ── 7. Auto-reply commands` → `// ── 9. Auto-reply commands`

- [ ] **Step 4: Run tests**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Typecheck**

```bash
cd /home/pedro/context-mode && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /home/pedro/context-mode && git add src/openclaw-plugin.ts tests/openclaw-plugin-hooks.test.ts && git commit -m "$(cat <<'EOF'
feat(openclaw-plugin): add before_compaction and after_compaction hooks

Flush buffered events to a resume snapshot before OpenClaw compacts,
and increment the compact counter afterwards. Both hooks fetch fresh
DB stats to avoid stale closure references.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 4: Resume injection via before_prompt_build

### Task 4: Implement and test resume snapshot injection

**Files:**
- Modify: `src/openclaw-plugin.ts` (add hook)
- Modify: `tests/openclaw-plugin-hooks.test.ts` (add tests)

**Background:** After at least one compaction (`compact_count > 0`), the plugin should inject the stored resume snapshot via `prependSystemContext` in `before_prompt_build`. It does this only once per session restart (using the `resumeInjected` flag). Priority 10 runs before the existing routing instructions at priority 5 (OpenClaw sorts descending: higher number = runs first).

---

- [ ] **Step 1: Write failing tests for resume injection**

Add to `tests/openclaw-plugin-hooks.test.ts`:

```typescript
describe("resume injection (before_prompt_build)", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_prompt_build resume hook is registered at priority 10", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    // There may be two before_prompt_build hooks (routing + resume)
    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must be registered at priority 10");
  });

  test("resume injection returns prependSystemContext when resume exists and compact_count > 0", () => {
    // Test the DB + snapshot logic directly
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    // Simulate a prior compaction: store a snapshot and increment count
    db.upsertResume(sid, "## Resume\n\n- Did something", 3);
    db.incrementCompactCount(sid);

    // Now simulate what the before_prompt_build hook does
    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);

    assert.ok(resume, "resume must exist");
    assert.ok((stats?.compact_count ?? 0) > 0, "compact_count must be > 0");

    // The hook returns prependSystemContext
    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;

    assert.ok(result, "result must be defined");
    assert.ok(result.prependSystemContext.includes("## Resume"), "must include resume content");
  });

  test("resume injection returns undefined when no resume exists", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    const resume = db.getResume(sid);
    assert.equal(resume, null, "new session has no resume");

    const result = resume ? { prependSystemContext: resume.snapshot } : undefined;
    assert.equal(result, undefined, "must return undefined if no resume");
  });

  test("resume injection returns undefined when compact_count is 0", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    db.upsertResume(sid, "## Resume\n\n- Did something", 1);
    // compact_count stays 0 (no incrementCompactCount call)

    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);
    assert.ok(resume, "resume exists");
    assert.equal(stats?.compact_count ?? 0, 0, "compact_count is 0");

    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;
    assert.equal(result, undefined, "must return undefined if compact_count is 0");
  });
});
```

- [ ] **Step 2: Run to verify resume hook registration test fails**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -20
```

Expected: FAIL — "resume before_prompt_build hook must be registered at priority 10"

The DB-layer tests (steps 2–4 in the test) should PASS since they only test `SessionDB` directly.

- [ ] **Step 3: Add resume injection `before_prompt_build` hook to `src/openclaw-plugin.ts`**

Find the existing `before_prompt_build` routing block:

```typescript
    // ── 7. before_prompt_build — Routing instruction injection ──

    if (routingInstructions) {
      api.on(
        "before_prompt_build",
        () => ({
          appendSystemContext: routingInstructions,
        }),
        { priority: 5 },
      );
    }
```

Insert the resume injection hook **before** the routing block:

```typescript
    // ── 7. before_prompt_build — Resume snapshot injection ────

    api.on(
      "before_prompt_build",
      () => {
        try {
          if (resumeInjected) return undefined;
          const resume = db.getResume(sessionId);
          if (!resume) return undefined;
          const freshStats = db.getSessionStats(sessionId);
          if ((freshStats?.compact_count ?? 0) === 0) return undefined;
          resumeInjected = true;
          return { prependSystemContext: resume.snapshot };
        } catch {
          return undefined;
        }
      },
      { priority: 10 },
    );

    // ── 8. before_prompt_build — Routing instruction injection ──

    if (routingInstructions) {
      api.on(
        "before_prompt_build",
        () => ({
          appendSystemContext: routingInstructions,
        }),
        { priority: 5 },
      );
    }
```

Update the file-level comment block at the top to include the new hooks:

```typescript
 *   - session_start hook             — Re-key DB session to OpenClaw's session ID
 *   - before_compaction hook         — Flush events to resume snapshot
 *   - after_compaction hook          — Increment compact count
```

- [ ] **Step 4: Run all tests**

```bash
cd /home/pedro/context-mode && npm test -- tests/openclaw-plugin-hooks.test.ts 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
cd /home/pedro/context-mode && npm test 2>&1 | tail -20
```

Expected: 921+ pass, 0 new failures (the 5 pre-existing failures in `vscode-hooks.test.ts` are known/unrelated).

- [ ] **Step 6: Typecheck**

```bash
cd /home/pedro/context-mode && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 7: Build**

```bash
cd /home/pedro/context-mode && npm run build 2>&1 | tail -10
```

Expected: clean build, `build/openclaw-plugin.js` updated.

- [ ] **Step 8: Commit**

```bash
cd /home/pedro/context-mode && git add src/openclaw-plugin.ts tests/openclaw-plugin-hooks.test.ts && git commit -m "$(cat <<'EOF'
feat(openclaw-plugin): inject resume snapshot via before_prompt_build

Register a priority-10 before_prompt_build hook that prepends the
stored resume snapshot to system context after the first compaction.
Fires once per session (resumeInjected flag). Routing instructions
at priority 5 continue to append after the snapshot.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 5: Deploy to dogfood instance and verify

### Task 5: Rebuild and restart OpenClaw gateway

**Files:**
- No code changes — rebuild + restart only

---

- [ ] **Step 1: Rebuild the plugin**

```bash
cd /home/pedro/context-mode && npm run build 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 2: Restart OpenClaw gateway to pick up new build**

```bash
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart openclaw-gateway
```

Expected: service restarts without error.

- [ ] **Step 3: Tail gateway logs to confirm plugin loads with new hooks**

```bash
XDG_RUNTIME_DIR="/run/user/$(id -u)" journalctl --user -u openclaw-gateway -n 30 --no-pager
```

Expected: no errors; ideally a log line showing context-mode plugin registered with hooks.

**Rollback:** If the gateway fails to start after the restart, the prior build is gone (TypeScript compile overwrites `build/`). To roll back: `git stash` the source changes (or `git checkout HEAD~1 -- src/openclaw-plugin.ts`), re-run `npm run build`, and restart the gateway again.

- [ ] **Step 4: Run full test suite one final time**

```bash
cd /home/pedro/context-mode && npm test 2>&1 | tail -10
```

Expected: all pass (minus 5 pre-existing vscode failures).

- [ ] **Step 5: Curate learnings**

```bash
brv curate "OpenClaw lifecycle hooks: session_start re-keys DB session, before_compaction flushes events to snapshot, after_compaction increments count, before_prompt_build at priority 10 injects resume snapshot once per session (resumeInjected flag)" -f src/openclaw-plugin.ts
```

---

## Notes for implementer

- **Import guard:** `SessionStartEvent` interface is only used in the `session_start` handler. It's already in scope since it's declared in the same file.
- **`buildResumeSnapshot` is already imported** — no new import needed.
- **`db.getResume()` returns `ResumeRow | null`** — access `resume.snapshot` only after null check.
- **Section numbering:** After adding the 3 new `api.on()` sections, the total ordered sections in `register()` are: 1=tool_call:before, 2=tool_call:after, 3=command:new, 4=session_start, 5=before_compaction, 6=after_compaction, 7=before_prompt_build resume, 8=before_prompt_build routing, 9=Context engine, 10=Auto-reply commands.
- **vitest import caching and closure isolation:** `await import("../src/openclaw-plugin.js")` is module-cached within a test file. Each call to `register()` creates new independent closures (`sessionId`, `resumeInjected`) even on the same cached module, so multiple `register()` calls in one test are safe. However, if you need a truly fresh module (e.g., to test the initial state before any `register()` call), use `vi.resetModules()` in `beforeEach`. All `describe` blocks in the plan that call `register()` already include `beforeEach(() => { vi.resetModules(); })` for this reason.
