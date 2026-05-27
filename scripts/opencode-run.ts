import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 180_000;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (value === "0") return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function usage(): never {
  console.error(`Usage: tsx scripts/opencode-run.ts [--timeout-ms <ms>] -- <opencode args...>

Environment:
  OPENCODE_RUN_TIMEOUT_MS   Default timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, 0 disables)

Examples:
  tsx scripts/opencode-run.ts -- run "Say hello" --model cursor-api/composer-2.5-fast
  OPENCODE_RUN_TIMEOUT_MS=120000 tsx scripts/opencode-run.ts -- run "Use websearch only" --model cursor-api/composer-2.5-fast
`);
  process.exit(1);
}

function splitArgs(argv: string[]): { timeoutMs: number; opencodeArgs: string[] } {
  let timeoutMs = parseTimeoutMs(process.env.OPENCODE_RUN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const opencodeArgs: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      opencodeArgs.push(...argv.slice(index));
      break;
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) usage();
      timeoutMs = parseTimeoutMs(value, DEFAULT_TIMEOUT_MS);
      index += 2;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
      index += 1;
      continue;
    }
    opencodeArgs.push(arg);
    index += 1;
  }

  if (!opencodeArgs.length) usage();
  return { timeoutMs, opencodeArgs };
}

async function main() {
  const { timeoutMs, opencodeArgs } = splitArgs(process.argv.slice(2));
  const command = opencodeArgs[0] === "run" ? "opencode" : "opencode";
  const child = spawn(command, opencodeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_NO_SANDBOX: process.env.OPENCODE_NO_SANDBOX || "1"
    }
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[opencode-run] Timed out after ${timeoutMs}ms; sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref();
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`[opencode-run] Failed to start opencode: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        resolve(124);
        return;
      }
      if (signal) {
        console.error(`[opencode-run] opencode exited via signal ${signal}`);
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (timer) clearTimeout(timer);
  if (timedOut) {
    console.error("[opencode-run] Increase OPENCODE_RUN_TIMEOUT_MS if the run needs more time.");
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
