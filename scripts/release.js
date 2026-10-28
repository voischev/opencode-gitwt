import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GitwtError, run as runCommand } from "../src/process.js";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const NOT_FOUND_PATTERN = /E404|404 Not Found|is not in this registry/i;
const SECRET_FILE_PATTERN = /(^|\/)\.npmrc$|(^|\/)\.env(\.|$)|\.(pem|key)$/i;

export function expectedTag(version) {
  return `v${version}`;
}

export function validateTag({ tag, version }) {
  if (!tag) {
    throw new GitwtError(
      "release_tag_missing",
      "Не задано имя тега релиза: переменная SOURCECRAFT_COMMIT_REF_NAME пуста",
    );
  }
  if (tag !== expectedTag(version)) {
    throw new GitwtError(
      "release_tag_mismatch",
      `Тег ${tag} не совпадает с версией пакета ${expectedTag(version)}`,
    );
  }
  return tag;
}

export function buildNpmrc({ registry = NPM_REGISTRY, tokenVar = "NPM_TOKEN" } = {}) {
  const url = new URL(registry);
  const authPath = `//${url.host}${url.pathname.replace(/\/?$/, "/")}`;
  const placeholder = `\${${tokenVar}}`;
  return `registry=${registry}\n${authPath}:_authToken=${placeholder}\n`;
}

function normalizeEntry(value) {
  return value.replace(/^\.\//, "");
}

export function collectEntryPoints(pkg) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === "string") {
      paths.add(normalizeEntry(value));
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) {
        add(nested);
      }
    }
  };
  add(pkg.main);
  add(pkg.exports);
  add(pkg.bin);
  return [...paths];
}

export function assertExportsPacked({ manifest, pkg }) {
  const packed = new Set((manifest.files ?? []).map((file) => normalizeEntry(file.path)));
  const missing = collectEntryPoints(pkg).filter((entry) => !packed.has(entry));
  if (missing.length > 0) {
    throw new GitwtError(
      "release_exports_missing",
      `В пакет не попадают точки входа: ${missing.join(", ")}`,
    );
  }
}

export function assertNoSecretArtifacts({ manifest }) {
  const forbidden = (manifest.files ?? [])
    .map((file) => normalizeEntry(file.path))
    .filter((path) => SECRET_FILE_PATTERN.test(path));
  if (forbidden.length > 0) {
    throw new GitwtError(
      "release_secret_artifact",
      `В пакет попадают запрещённые файлы: ${forbidden.join(", ")}`,
    );
  }
}

export function validateManifest({ manifest, pkg }) {
  if (!manifest?.filename) {
    throw new GitwtError("release_pack_failed", "npm pack не вернул имя файла пакета");
  }
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    throw new GitwtError(
      "release_pack_mismatch",
      `Пакет ${manifest.name}@${manifest.version} не совпадает с package.json ${pkg.name}@${pkg.version}`,
    );
  }
  assertExportsPacked({ manifest, pkg });
  assertNoSecretArtifacts({ manifest });
}

export async function resolveCommits({ runner = runCommand, cwd, tag, env = process.env }) {
  const headResult = await runner("git", ["rev-parse", "HEAD"], { cwd });
  const head = headResult.stdout.trim();
  if (!SHA_PATTERN.test(head)) {
    throw new GitwtError("release_head_missing", "Не удалось определить HEAD текущего чекаута");
  }
  const tagResult = await runner("git", ["rev-parse", "--verify", `${tag}^{commit}`], {
    cwd,
    allowFailure: true,
  });
  const tagSha = (tagResult.stdout ?? "").trim();
  if (tagResult.code !== 0 || !SHA_PATTERN.test(tagSha)) {
    throw new GitwtError("release_tag_missing", `Тег ${tag} не найден в локальном репозитории`);
  }
  if (head !== tagSha) {
    throw new GitwtError(
      "release_head_mismatch",
      `HEAD (${head}) не совпадает с коммитом тега ${tag} (${tagSha})`,
    );
  }
  const declared = (env.SOURCECRAFT_COMMIT_SHA ?? "").trim();
  if (declared && declared !== head) {
    throw new GitwtError(
      "release_sha_mismatch",
      `SOURCECRAFT_COMMIT_SHA (${declared}) не совпадает с коммитом тега (${head})`,
    );
  }
  return head;
}

export async function fetchMain({ runner = runCommand, cwd, branch = "origin/main" }) {
  const shallowResult = await runner("git", ["rev-parse", "--is-shallow-repository"], { cwd });
  const shallow = shallowResult.stdout.trim() === "true";
  const remote = branch.replace(/^origin\//, "");
  const refspec = `${remote}:refs/remotes/${branch}`;
  const args = shallow
    ? ["fetch", "--unshallow", "--no-tags", "origin", refspec]
    : ["fetch", "--no-tags", "origin", refspec];
  await runner("git", args, { cwd, timeout: 600_000 });
}

export async function assertAncestor({ runner = runCommand, cwd, sha, branch = "origin/main" }) {
  const result = await runner("git", ["merge-base", "--is-ancestor", sha, branch], {
    cwd,
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new GitwtError(
      "release_not_in_main",
      `Коммит ${sha} тега не входит в историю ${branch}: релиз возможен только после влития PR в main`,
    );
  }
}

export async function assertNotPublished({
  runner = runCommand,
  cwd,
  name,
  version,
  registry = NPM_REGISTRY,
}) {
  const result = await runner(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", registry],
    { cwd, allowFailure: true },
  );
  if (result.code === 0) {
    throw new GitwtError(
      "release_version_published",
      `Версия ${name}@${version} уже опубликована в npm, публикация отменена`,
    );
  }
  if (!NOT_FOUND_PATTERN.test(result.stderr ?? "")) {
    const reason = (result.stderr ?? "").trim() || "неизвестная ошибка";
    throw new GitwtError(
      "release_registry_unavailable",
      `Не удалось проверить наличие ${name}@${version} в npm: ${reason}`,
    );
  }
}

async function runPack({ runner, cwd, pkg, args }) {
  const result = await runner("npm", args, { cwd, timeout: 300_000 });
  let manifest;
  try {
    const parsed = JSON.parse(result.stdout);
    manifest = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new GitwtError("release_pack_failed", "Не удалось разобрать вывод npm pack");
  }
  validateManifest({ manifest, pkg });
  return manifest;
}

async function packPackage({ runner, cwd, pkg, dir }) {
  const manifest = await runPack({
    runner,
    cwd,
    pkg,
    args: ["pack", "--json", "--pack-destination", dir, "--registry", NPM_REGISTRY],
  });
  return join(dir, manifest.filename);
}

export async function checkPackage({ runner = runCommand, cwd = process.cwd(), log = defaultLog }) {
  const pkg = await readPackage(cwd);
  const manifest = await runPack({
    runner,
    cwd,
    pkg,
    args: ["pack", "--dry-run", "--json", "--registry", NPM_REGISTRY],
  });
  log(`Пакет ${pkg.name}@${pkg.version} упаковывается корректно`);
  return manifest;
}

async function readPackage(cwd) {
  return JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
}

async function publishPackage({ runner, cwd, tarball, env }) {
  if (!env.NPM_TOKEN) {
    throw new GitwtError(
      "release_token_missing",
      "Не задан NPM_TOKEN: добавьте granular-токен npm в секрет SourceCraft",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "opencode-gitwt-npmrc-"));
  const npmrc = join(dir, ".npmrc");
  await writeFile(npmrc, buildNpmrc(), { mode: 0o600 });
  try {
    await runner(
      "npm",
      ["publish", tarball, "--access", "public", "--registry", NPM_REGISTRY, "--ignore-scripts"],
      {
        cwd,
        env: { NPM_CONFIG_USERCONFIG: npmrc, NPM_TOKEN: env.NPM_TOKEN },
        timeout: 600_000,
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function release(options = {}) {
  const runner = options.runner ?? runCommand;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? defaultLog;

  const pkg = await readPackage(cwd);
  const tag = validateTag({ tag: env.SOURCECRAFT_COMMIT_REF_NAME, version: pkg.version });
  const sha = await resolveCommits({ runner, cwd, tag, env });
  await fetchMain({ runner, cwd });
  await assertAncestor({ runner, cwd, sha });
  await assertNotPublished({ runner, cwd, name: pkg.name, version: pkg.version });

  const dir = await mkdtemp(join(tmpdir(), "opencode-gitwt-pack-"));
  try {
    const tarball = await packPackage({ runner, cwd, pkg, dir });
    if (dryRun) {
      log(`dry-run: проверки пройдены, публикация пропущена (${tarball})`);
      return { published: false, tarball };
    }
    await publishPackage({ runner, cwd, tarball, env });
    log(`Опубликован ${pkg.name}@${pkg.version}`);
    return { published: true, tarball };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function defaultLog(message) {
  process.stdout.write(`${message}\n`);
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const action = args.includes("--check")
    ? checkPackage({})
    : release({ dryRun: args.includes("--dry-run") });
  action.catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
