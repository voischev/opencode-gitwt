import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..");
const BINARY = process.env.GITWT_OPENCODE_BIN ?? "opencode";
const REQUIRED_VERSION = process.env.GITWT_OPENCODE_VERSION ?? "1.19.3";
const V2 = REQUIRED_VERSION.startsWith("2.");
const TOOLS = ["gitwt_create", "gitwt_list", "gitwt_cd", "gitwt_remove"];
const START_TIMEOUT = 30_000;
const requireIntegration = process.env.GITWT_REQUIRE_OPENCODE === "1";

function run(binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout.trim()));
  });
}

const version = (await run(BINARY, ["--version"])).replace(/^opencode v/, "");
const compatible = version === REQUIRED_VERSION;
const reason = version
  ? `нужен opencode ${REQUIRED_VERSION}, найден ${version}`
  : "opencode не найден в PATH";
const testOptions = { skip: compatible || requireIntegration ? false : reason, timeout: 90_000 };

describe("регистрация gitwt-плагина в opencode", () => {
  it(`OpenCode ${REQUIRED_VERSION}: интеграция`, testOptions, async (t) => {
    assert.equal(version, REQUIRED_VERSION, reason);
    const parent = join(tmpdir(), "opencode");
    await mkdir(parent, { recursive: true });
    const base = await realpath(await mkdtemp(join(parent, "gitwt-plugin-")));
    const root = join(base, "repo");
    const home = join(base, "home");
    await mkdir(root);
    await mkdir(home);
    await mkdir(join(base, "config"));
    await mkdir(join(base, "data"));
    await mkdir(join(base, "cache"));
    await mkdir(join(base, "state"));
    const npmrc = join(base, "npmrc");
    await writeFile(npmrc, "");

    const canonical = await realpath(root);
    const spec =
      process.env.GITWT_TEST_PLUGIN_SPEC ??
      (V2 ? REPO_ROOT : pathToFileURL(join(REPO_ROOT, "src/index.js")).href);
    const password = randomUUID();
    const headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    };
    const env = {
      ...process.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: "opencode",
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(base, "config"),
      XDG_DATA_HOME: join(base, "data"),
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
      NPM_CONFIG_USERCONFIG: npmrc,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Тест",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Тест",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    delete env.OPENCODE_CONFIG_CONTENT;
    delete env.OPENCODE_CONFIG;
    const git = (args, cwd = canonical) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    let oldHead;
    let remoteHead;
    let probe;
    if (V2) {
      const remote = join(base, "remote.git");
      git(["init", "--bare", "--initial-branch=main", remote], base);
      git(["init", "--initial-branch=main"]);
      await writeFile(join(root, "README.md"), "Начало\n");
      git(["add", "README.md"]);
      git(["commit", "-m", "Начало"]);
      oldHead = git(["rev-parse", "HEAD"]);
      git(["remote", "add", "origin", remote]);
      git(["push", "-u", "origin", "main"]);
      const other = join(base, "other");
      git(["clone", remote, other], base);
      await writeFile(join(other, "new.txt"), "Свежая база\n");
      git(["add", "new.txt"], other);
      git(["commit", "-m", "Обновление remote"], other);
      git(["push", "origin", "main"], other);
      remoteHead = git(["rev-parse", "HEAD"], other);
      probe = join(base, "probe");
      await mkdir(probe);
      await writeFile(join(probe, "package.json"), '{"type":"module"}');
      await writeFile(
        join(probe, "index.js"),
        `export default {
  id: "gitwt-probe",
  async setup(ctx) {
    const schema = { type: "object", additionalProperties: true };
    await ctx.rpc.register({ id: "gitwt-probe", events: {}, methods: {
      inspect: { input: schema, output: schema },
      execute: { input: schema, output: schema },
    } }, {
      inspect: async () => ({ projectID: ctx.location.project.id, tools: (await ctx.tool.list())
        .filter(tool => tool.name.startsWith("gitwt_"))
        .map(tool => ({ id: tool.id, name: tool.name, input: tool.input, options: tool.options })) }),
      execute: async ({ name, args }, { signal }) => {
        const tool = (await ctx.tool.list()).find(tool => tool.name === name && name.startsWith("gitwt_"));
        if (!tool) throw new Error("Инструмент не найден");
        return tool.execute(args, { signal, progress: async () => {}, sessionID: "test", messageID: "test", agent: "build", id: "test" });
      },
    });
  },
};\n`,
      );
    }
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify(
        V2 ? { plugins: [{ package: spec, options: {} }, probe] } : { plugin: [[spec, {}]] },
      ),
    );
    const server = spawn(BINARY, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: V2 ? base : canonical,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    server.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8000);
    });

    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        const stopped = new Promise((resolve) => server.once("close", resolve));
        server.kill("SIGTERM");
        const killTimer = setTimeout(() => server.kill("SIGKILL"), 3000);
        await stopped;
        clearTimeout(killTimer);
      }
      await rm(base, { recursive: true, force: true });
    });

    const url = await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("opencode serve не стартовал")),
        START_TIMEOUT,
      );
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      server.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve завершился с кодом ${code}`));
      });
    });

    if (V2) {
      const query = new URLSearchParams({ "location[directory]": canonical });
      const request = async (pathname, method = "GET", body) => {
        const response = await fetch(`${url}${pathname}`, {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        assert.ok(response.ok, `${response.status}: ${text}`);
        return text ? JSON.parse(text) : undefined;
      };
      let plugins;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        plugins = await request(`/api/plugin?${query}`);
        const selected = plugins.data.filter((plugin) =>
          ["opencode-gitwt", "gitwt-probe"].includes(plugin.id),
        );
        if (selected.some((plugin) => plugin.state.status === "failed")) break;
        if (selected.length === 2 && selected.every((plugin) => plugin.state.status === "active"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(
        plugins.data.find((plugin) => plugin.id === "opencode-gitwt")?.state.status,
        "active",
        `${JSON.stringify(plugins)}\n${diagnostics}`,
      );
      assert.equal(
        plugins.data.find((plugin) => plugin.id === "gitwt-probe")?.state.status,
        "active",
        JSON.stringify(plugins),
      );
      const inspect = (
        await request(`/api/rpc/gitwt-probe/inspect?${query}`, "POST", { input: {} })
      ).output;
      assert.deepEqual(inspect.tools.map((tool) => tool.name).sort(), [...TOOLS].sort());
      const schemas = Object.fromEntries(inspect.tools.map((tool) => [tool.name, tool.input]));
      assert.deepEqual(schemas.gitwt_create.required, ["branch"]);
      assert.deepEqual(schemas.gitwt_list.required, []);
      assert.deepEqual(schemas.gitwt_remove.required, ["target"]);
      assert.equal(schemas.gitwt_remove.properties.force.type, "boolean");
      assert.ok(inspect.tools.every((tool) => tool.options.codemode === false));
      const execute = async (name, args) =>
        JSON.parse(
          (
            await request(`/api/rpc/gitwt-probe/execute?${query}`, "POST", {
              input: { name, args },
            })
          ).output.content,
        );
      const native = await request("/api/worktree", "POST", {
        projectID: inspect.projectID,
        name: "native",
        directory: join(base, "copies"),
      });
      assert.equal(git(["rev-parse", "HEAD"], native.directory), oldHead);
      assert.equal(git(["branch", "--show-current"], native.directory), "");
      const created = await execute("gitwt_create", {
        branch: "feature/v2",
        base: "main",
        path: join(base, "gitwt-copy"),
        noHooks: true,
      });
      assert.equal(created.head, remoteHead);
      assert.equal(git(["branch", "--show-current"], created.worktreePath), "feature/v2");
      assert.equal(
        (await execute("gitwt_cd", { target: "feature/v2" })).worktreePath,
        created.worktreePath,
      );
      assert.ok(
        (await execute("gitwt_list", { status: true })).some(
          (item) => item.worktreePath === native.directory,
        ),
      );
      await execute("gitwt_remove", { target: "feature/v2", keepBranch: true });
      assert.equal(git(["rev-parse", "HEAD"]), oldHead);
      assert.equal(git(["branch", "--show-current"]), "main");
      return;
    }
    const query = `directory=${encodeURIComponent(canonical)}`;
    const response = await fetch(`${url}/experimental/tool/ids?${query}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok);
    const ids = await response.json();
    for (const tool of TOOLS) assert.ok(ids.includes(tool), `нет инструмента ${tool}`);

    const schemasResponse = await fetch(
      `${url}/experimental/tool?${query}&provider=openai&model=gpt-5`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    assert.ok(schemasResponse.ok);
    const definitions = await schemasResponse.json();
    const schemas = Object.fromEntries(
      definitions
        .filter((tool) => TOOLS.includes(tool.id))
        .map((tool) => [tool.id, tool.parameters]),
    );
    assert.deepEqual(schemas.gitwt_create.required, ["branch"]);
    assert.deepEqual(schemas.gitwt_list.required, []);
    assert.deepEqual(schemas.gitwt_cd.required, ["target"]);
    assert.deepEqual(schemas.gitwt_remove.required, ["target"]);
    assert.equal(schemas.gitwt_create.properties.branch.type, "string");
    assert.equal(schemas.gitwt_create.properties.noHooks.type, "boolean");
    assert.equal(schemas.gitwt_remove.properties.force.type, "boolean");
    assert.equal(schemas.gitwt_remove.additionalProperties, false);
  });
});
