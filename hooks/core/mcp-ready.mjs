/**
 * MCP readiness sentinel — checks if MCP server has started.
 * Server writes sentinel (containing its PID) after connect(),
 * hooks check before denying tools that redirect to MCP alternatives.
 *
 * Sentinel path: ${tmpdir()}/context-mode-mcp-ready-${process.ppid}
 * Both hooks and MCP server share the same ppid (Claude Code process).
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Compute the sentinel file path, scoped to session via parent PID. */
export function sentinelPath() {
  return resolve(tmpdir(), `context-mode-mcp-ready-${process.ppid}`);
}

/**
 * Check if MCP server is alive by reading sentinel PID and probing it.
 * Handles stale sentinels from crashed servers (SIGKILL, OOM) — if the
 * PID in the sentinel is dead, returns false so hooks allow fallback.
 */
export function isMCPReady() {
  try {
    const pid = parseInt(readFileSync(sentinelPath(), "utf8"), 10);
    process.kill(pid, 0); // throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
}
