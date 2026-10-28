import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export class GitwtError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GitwtError";
    this.code = code;
    this.details = details;
  }
}

export async function run(command, args = [], options = {}) {
  try {
    const result = await execute(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      signal: options.signal,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (options.allowFailure && typeof error.code === "number") {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    }
    throw new GitwtError(
      "command_failed",
      `Команда ${command} завершилась с ошибкой: ${error.stderr?.trim() || error.message}`,
      { command, exitCode: error.code },
    );
  }
}

export function git(args, cwd, options = {}) {
  return run("git", args, { ...options, cwd });
}
