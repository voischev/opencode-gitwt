import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..");
const REQUIRED_VERSION = "1.19.3";
const TOOLS = ["gitwt_create", "gitwt_list", "gitwt_cd", "gitwt_remove"];
const START_TIMEOUT = 30_000;

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

const version = await run("opencode", ["--version"]);
const compatible = version === REQUIRED_VERSION;
const reason = version
  ? `нужен opencode ${REQUIRED_VERSION}, найден ${version}`
  : "opencode не найден в PATH";

describe("регистрация gitwt-плагина в opencode", () => {
  it("serve отдаёт четыре инструмента gitwt", { skip: compatible ? false : reason }, async (t) => {
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
      process.env.GITWT_TEST_PLUGIN_SPEC ?? pathToFileURL(join(REPO_ROOT, "src/index.js")).href;
    const env = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "",
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(base, "config"),
      XDG_DATA_HOME: join(base, "data"),
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "state"),
      NPM_CONFIG_USERCONFIG: npmrc,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [[spec, {}]] }),
    };
    const server = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: canonical,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGTERM");
        await new Promise((resolve) => server.once("close", resolve));
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

    const query = `directory=${encodeURIComponent(canonical)}`;
    const response = await fetch(`${url}/experimental/tool/ids?${query}`);
    assert.ok(response.ok);
    const ids = await response.json();
    for (const tool of TOOLS) assert.ok(ids.includes(tool), `нет инструмента ${tool}`);

    const schemasResponse = await fetch(
      `${url}/experimental/tool?${query}&provider=openai&model=gpt-5`,
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
