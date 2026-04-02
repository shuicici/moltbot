import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import {
  CHROME_LAUNCH_READY_POLL_MS,
  CHROME_LAUNCH_READY_WINDOW_MS,
  CHROME_STOP_PROBE_TIMEOUT_MS,
  CHROME_STOP_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import { isChromeReachable, type RunningChrome } from "./chrome.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

const log = createSubsystemLogger("browser").child("lightpanda");

export function getLightpandaExecutablePath(): string {
  return path.join(CONFIG_DIR, "bin", "lightpanda");
}

function getLightpandaDownloadUrl(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return "https://github.com/lightpanda-io/browser/releases/latest/download/lightpanda-aarch64-macos";
  } else if (platform === "linux" && arch === "arm64") {
    return "https://github.com/lightpanda-io/browser/releases/latest/download/lightpanda-aarch64-linux";
  } else if (platform === "linux" && arch === "x64") {
    return "https://github.com/lightpanda-io/browser/releases/latest/download/lightpanda-x86_64-linux";
  } else {
    throw new Error(`Lightpanda does not provide pre-built binaries for ${platform} ${arch}`);
  }
}

export async function ensureLightpandaInstalled(): Promise<string> {
  const exePath = getLightpandaExecutablePath();
  if (fs.existsSync(exePath)) {
    return exePath;
  }

  log.info("Lightpanda executable not found. Downloading...");
  const binDir = path.dirname(exePath);
  fs.mkdirSync(binDir, { recursive: true });

  const url = getLightpandaDownloadUrl();
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Lightpanda from ${url}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(exePath, Buffer.from(arrayBuffer));
  fs.chmodSync(exePath, 0o755); // Make it executable

  log.info(`Successfully downloaded Lightpanda to ${exePath}`);
  return exePath;
}

export async function launchLightpanda(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Lightpanda.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exePath = await ensureLightpandaInstalled();
  const userDataDir = path.join(CONFIG_DIR, "browser", profile.name, "user-data-lightpanda");
  fs.mkdirSync(userDataDir, { recursive: true });

  const args: string[] = ["serve", "--host", "127.0.0.1", "--port", String(profile.cdpPort)];

  const startedAt = Date.now();
  const proc = spawn(exePath, args, {
    stdio: "pipe",
    env: {
      ...process.env,
      HOME: os.homedir(),
    },
  });

  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => {
    stderrChunks.push(chunk);
  };
  proc.stderr?.on("data", onStderr);

  const readyDeadline = Date.now() + CHROME_LAUNCH_READY_WINDOW_MS;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl)) {
      break;
    }
    await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
  }

  if (!(await isChromeReachable(profile.cdpUrl))) {
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stderrHint = stderrOutput ? `\nLightpanda stderr:\n${stderrOutput.slice(0, 1000)}` : "";
    try {
      proc.kill("SIGKILL");
    } catch {}
    throw new Error(
      `Failed to start Lightpanda CDP on port ${profile.cdpPort} for profile "${profile.name}".${stderrHint}`,
    );
  }

  proc.stderr?.off("data", onStderr);
  stderrChunks.length = 0;

  const pid = proc.pid ?? -1;
  log.info(
    `🐼 openclaw browser started (lightpanda) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe: { kind: "custom", path: exePath },
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopLightpanda(running: RunningChrome, timeoutMs = CHROME_STOP_TIMEOUT_MS) {
  const proc = running.proc;
  if (proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {}

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
    if (!(await isChromeReachable(cdpUrl, CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {}
}
