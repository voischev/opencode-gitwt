#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { openTerminal } from "../src/terminal.js";
import { createWorktree, listWorktrees, removeWorktree, repository } from "../src/worktree.js";

let json = process.argv.includes("--json");
let porcelain = process.argv.includes("--porcelain");

function output(value) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`);
  else if (porcelain) {
    for (const [key, item] of Object.entries({ ok: true, ...value })) {
      process.stdout.write(`${key}=${typeof item === "object" ? JSON.stringify(item) : item}\n`);
    }
  } else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      porcelain: { type: "boolean" },
      status: { type: "boolean" },
      slug: { type: "string" },
      remote: { type: "string" },
      base: { type: "string" },
      from: { type: "string" },
      prefix: { type: "string" },
      path: { type: "string" },
      dir: { type: "string" },
      setup: { type: "string" },
      "lease-owner": { type: "string" },
      "lease-reason": { type: "string" },
      force: { type: "boolean" },
      reuse: { type: "boolean" },
      "keep-branch": { type: "boolean" },
      open: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  json = values.json;
  porcelain = values.porcelain;
  if (values.help || (!positionals.length && !values.slug)) {
    process.stdout.write(
      "git-wt <описание> [--slug <ветка>] [--base <ветка> | --from <ref>] [--dir <каталог> | --path <путь>] [--json | --porcelain]\ngit-wt list [--status] [--json]\ngit-wt config\ngit-wt remove <ветка> [--lease-owner <владелец>] [--force] [--keep-branch]\n",
    );
    return;
  }
  const cwd = process.cwd();
  const config = {
    remote: values.remote,
    base: values.base,
    prefix: values.prefix,
    worktreeDir: values.dir,
    setup: values.setup,
  };
  if (positionals[0] === "list")
    return output({ worktrees: await listWorktrees(cwd, { status: values.status }) });
  if (positionals[0] === "config") {
    const repo = await repository(cwd);
    return output({ config: await loadConfig(repo.root, config) });
  }
  if (positionals[0] === "remove") {
    return output(
      await removeWorktree(cwd, positionals[1], {
        config,
        owner: values["lease-owner"],
        force: values.force,
        deleteBranch: !values["keep-branch"],
      }),
    );
  }
  const result = await createWorktree(cwd, {
    config,
    branch: values.slug,
    description: positionals.join(" "),
    path: values.path,
    from: values.from,
    owner: values["lease-owner"],
    reason: values["lease-reason"],
    reuse: values.reuse,
  });
  const { config: resolved, ...record } = result;
  if (values.open)
    record.terminal = await openTerminal({
      cwd: record.worktreePath,
      branch: record.branch,
      config: resolved,
    });
  output(record);
}

main().catch((error) => {
  const result = {
    ok: false,
    code: error.code ?? "unexpected_error",
    error: error.message,
    ...error.details,
  };
  if (json) process.stderr.write(`${JSON.stringify(result)}\n`);
  else if (porcelain)
    process.stderr.write(`ok=false\ncode=${result.code}\nerror=${result.error}\n`);
  else process.stderr.write(`Ошибка: ${error.message}\n`);
  process.exitCode = 1;
});
