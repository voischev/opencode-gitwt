import { run } from "./process.js";

export async function runHooks(commands, cwd, env, signal) {
  for (const command of commands) {
    const argv = Array.isArray(command)
      ? command
      : process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
        : ["bash", "-c", command];
    await run(argv[0], argv.slice(1), { cwd, env, signal });
  }
}
