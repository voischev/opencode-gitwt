#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import {
  createWorktree,
  inspectHooks,
  listWorktrees,
  removeWorktree,
  repository,
  resolveWorktree,
} from "../src/worktree.js";

const machine = process.argv.includes("--json") || process.argv.includes("--porcelain");

async function main() {
  const {
    values,
    positionals: [command, target, ...extra],
  } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      porcelain: { type: "boolean" },
      status: { type: "boolean" },
      remote: { type: "string" },
      base: { type: "string" },
      from: { type: "string" },
      prefix: { type: "string" },
      path: { type: "string" },
      dir: { type: "string" },
      "no-hooks": { type: "boolean" },
      force: { type: "boolean" },
      "keep-branch": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (!command || values.help) {
    process.stdout.write(
      "git-wt add <ветка> [--base <remote-ветка> | --from <ref>] [--path <путь> | --dir <каталог>] [--no-hooks] [--json]\ngit-wt list [--status] [--json | --porcelain]\ngit-wt cd <ветка|путь>\ngit-wt hooks <ветка|путь>\ngit-wt remove <ветка|путь> [--force] [--keep-branch]\ngit-wt config\n",
    );
    return;
  }
  if (extra.length || (!["add", "cd", "remove", "hooks"].includes(command) && target))
    throw new Error("Лишние позиционные аргументы");
  if (values["no-hooks"] && command !== "add")
    throw new Error("--no-hooks допустим только при создании worktree");
  const cwd = process.cwd();
  const config = {
    remote: values.remote,
    base: values.base,
    prefix: values.prefix,
    worktreeDir: values.dir,
  };
  let result;
  switch (command) {
    case "add":
      result = await createWorktree(cwd, {
        branch: target,
        path: values.path,
        from: values.from,
        noHooks: values["no-hooks"],
        config,
      });
      break;
    case "list":
      result = await listWorktrees(cwd, { status: values.status });
      break;
    case "cd":
      result = await resolveWorktree(cwd, target);
      break;
    case "hooks":
      result = await inspectHooks(cwd, target);
      break;
    case "remove":
      result = await removeWorktree(cwd, target, {
        force: values.force,
        deleteBranch: !values["keep-branch"],
      });
      break;
    case "config":
      result = await loadConfig((await repository(cwd)).root, config);
      break;
    default:
      throw new Error(`Неизвестная команда: ${command}`);
  }
  process.stdout.write(
    command === "cd" && !machine
      ? `${result.worktreePath}\n`
      : `${JSON.stringify(result, null, machine ? 0 : 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    machine
      ? `${JSON.stringify({ code: error.code ?? "unexpected_error", error: error.message, ...error.details })}\n`
      : `Ошибка: ${error.message}\n`,
  );
  process.exitCode = 1;
});
