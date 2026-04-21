import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import type { OpenClawConfig } from "./types.js";

describe("agent-limits", () => {
  type AgentLimitsTestConfig = Pick<OpenClawConfig, "agents">;

  it("resolves default concurrency when config is missing", () => {
    expect(resolveAgentMaxConcurrent()).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent()).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("resolves configured concurrency", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 10,
          subagents: {
            maxConcurrent: 30,
          },
        },
      },
    } satisfies AgentLimitsTestConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(10);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(30);
  });

  it("enforces minimum concurrency of 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: {
            maxConcurrent: 0.5,
          },
        },
      },
    } satisfies AgentLimitsTestConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });
});
