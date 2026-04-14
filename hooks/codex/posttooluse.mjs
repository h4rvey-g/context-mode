#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Codex CLI postToolUse hook — session event capture.
 */

import { readStdin, getSessionId, getSessionDBPath, getInputProjectDir, CODEX_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract } = createSessionLoaders(HOOK_DIR);
const OPTS = CODEX_OPTS;

function normalizeToolName(toolName) {
  // Codex CLI tool_name is always "Bash" (single tool type)
  if (toolName === "Shell") return "Bash";
  return toolName;
}

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { extractEvents } = await loadExtract();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const normalizedInput = {
    tool_name: normalizeToolName(input.tool_name ?? ""),
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
  };

  const events = extractEvents(normalizedInput);
  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  db.close();
} catch {
  // Swallow errors — hook must not fail
}

// Codex PostToolUse requires hookEventName in hookSpecificOutput
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "" },
}) + "\n");
