import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import { start } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger } = setupCronServiceSuite({
  prefix: "openclaw-cron-stale-",
  baseTimeIso: "2026-03-26T10:00:00.000Z",
});

describe("CronService stale cleanup", () => {
  it("clears stuck running markers older than 1 hour during maintenance", async () => {
    const nowMs = Date.parse("2026-03-26T10:00:00.000Z");
    const staleMs = nowMs - (60 * 60 * 1000 + 1000); // 1 hour + 1 second
    const freshMs = nowMs - 30 * 60 * 1000; // 30 minutes

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "mock.json",
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    state.store = {
      version: 1,
      jobs: [
        {
          id: "stale-job",
          name: "Stale Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          state: { runningAtMs: staleMs },
        } as CronJob,
        {
          id: "fresh-job",
          name: "Fresh Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          state: { runningAtMs: freshMs },
        } as CronJob,
      ],
    };

    const changed = recomputeNextRunsForMaintenance(state, { nowMs });
    expect(changed).toBe(true);
    expect(state.store.jobs.find((j) => j.id === "stale-job")?.state.runningAtMs).toBeUndefined();
    expect(state.store.jobs.find((j) => j.id === "fresh-job")?.state.runningAtMs).toBe(freshMs);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "stale-job" }),
      "cron: clearing stuck running marker",
    );
  });

  it("clears ALL running markers on startup regardless of age", async () => {
    const nowMs = Date.parse("2026-03-26T10:00:00.000Z");
    const freshMs = nowMs - 5 * 60 * 1000; // 5 minutes

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "mock.json",
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    state.store = {
      version: 1,
      jobs: [
        {
          id: "startup-job",
          name: "Startup Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          state: { runningAtMs: freshMs },
        } as CronJob,
      ],
    };

    // We need to bypass ensureLoaded for this unit test
    // or mock persist. For simplicity in this test, we just want to verify the logic in start's loop.
    // Ops.start calls ensureLoaded and persist, so we mock those.

    vi.mock("./service/store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./service/store.js")>();
      return {
        ...actual,
        ensureLoaded: vi.fn(),
        persist: vi.fn(),
      };
    });

    await start(state);

    expect(state.store.jobs[0]?.state.runningAtMs).toBeUndefined();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-job" }),
      "cron: clearing stale running marker on startup (interrupted process recovery)",
    );
  });
});
