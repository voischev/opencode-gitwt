import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertAncestor,
  assertExportsPacked,
  assertNoSecretArtifacts,
  assertNotPublished,
  buildNpmrc,
  checkPackage,
  collectEntryPoints,
  expectedTag,
  fetchMain,
  release,
  resolveCommits,
  validateTag,
} from "../scripts/release.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const PACKAGE = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
const SHA = "a".repeat(40);
const TARBALL_NAME = `${PACKAGE.name}-${PACKAGE.version}.tgz`;
const PACK_FILES = [{ path: "package.json" }, { path: "src/index.js" }];
const FETCH_MAIN = ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"];

function createRunner({
  head = SHA,
  tagSha = SHA,
  shallow = false,
  ancestor = true,
  published = false,
  packFiles = PACK_FILES,
  pack = {},
} = {}) {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "git" && args[0] === "rev-parse") {
      if (args[1] === "--is-shallow-repository") {
        return { stdout: `${shallow}`, stderr: "", code: 0 };
      }
      if (args[1] === "--verify") {
        return { stdout: tagSha ? `${tagSha}\n` : "", stderr: "", code: tagSha ? 0 : 1 };
      }
      return { stdout: `${head}\n`, stderr: "", code: 0 };
    }
    if (command === "git" && args[0] === "fetch") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (command === "git" && args[0] === "merge-base") {
      return { stdout: "", stderr: "", code: ancestor ? 0 : 1 };
    }
    if (command === "npm" && args[0] === "view") {
      return published
        ? { stdout: `${PACKAGE.version}\n`, stderr: "", code: 0 }
        : { stdout: "", stderr: "npm error code E404", code: 1 };
    }
    if (command === "npm" && args[0] === "pack") {
      return {
        stdout: JSON.stringify([
          {
            name: pack.name ?? PACKAGE.name,
            version: pack.version ?? PACKAGE.version,
            filename: pack.filename ?? TARBALL_NAME,
            files: packFiles,
          },
        ]),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

function releaseEnv(extra = {}) {
  return {
    RELEASE_TAG: expectedTag(PACKAGE.version),
    RELEASE_SHA: SHA,
    NPM_TOKEN: "granular-token-value",
    ...extra,
  };
}

describe("проверка тега релиза", () => {
  it("ожидаемый тег строится из версии", () => {
    assert.equal(expectedTag("0.1.0"), "v0.1.0");
  });

  it("совпадающий тег проходит проверку", () => {
    assert.equal(validateTag({ tag: "v0.1.0", version: "0.1.0" }), "v0.1.0");
  });

  it("пустой тег отклоняется", () => {
    assert.throws(() => validateTag({ tag: "", version: "0.1.0" }), {
      code: "release_tag_missing",
    });
  });

  it("несовпадающий тег отклоняется", () => {
    assert.throws(() => validateTag({ tag: "v0.2.0", version: "0.1.0" }), {
      code: "release_tag_mismatch",
    });
  });
});

describe("сверка HEAD, тега и SHA", () => {
  it("совпадающие HEAD, тег и RELEASE_SHA проходят", async () => {
    const { runner } = createRunner();
    const sha = await resolveCommits({
      runner,
      cwd: REPO_ROOT,
      tag: "v0.1.0",
      env: { RELEASE_SHA: SHA },
    });
    assert.equal(sha, SHA);
  });

  it("без RELEASE_SHA сверяются только HEAD и тег", async () => {
    const { runner } = createRunner();
    const sha = await resolveCommits({ runner, cwd: REPO_ROOT, tag: "v0.1.0", env: {} });
    assert.equal(sha, SHA);
  });

  it("расхождение HEAD и коммита тега отклоняется", async () => {
    const { runner } = createRunner({ head: "b".repeat(40) });
    await assert.rejects(() => resolveCommits({ runner, cwd: REPO_ROOT, tag: "v0.1.0", env: {} }), {
      code: "release_head_mismatch",
    });
  });

  it("расхождение RELEASE_SHA и коммита тега отклоняется", async () => {
    const { runner } = createRunner();
    await assert.rejects(
      () =>
        resolveCommits({
          runner,
          cwd: REPO_ROOT,
          tag: "v0.1.0",
          env: { RELEASE_SHA: "c".repeat(40) },
        }),
      { code: "release_sha_mismatch" },
    );
  });

  it("отсутствующий в репозитории тег отклоняется", async () => {
    const { runner } = createRunner({ tagSha: "" });
    await assert.rejects(() => resolveCommits({ runner, cwd: REPO_ROOT, tag: "v0.1.0", env: {} }), {
      code: "release_tag_missing",
    });
  });
});

describe("свежесть origin/main", () => {
  it("всегда выполняет fetch origin main", async () => {
    const { runner, calls } = createRunner();
    await fetchMain({ runner, cwd: REPO_ROOT });
    const fetch = calls.find((entry) => entry.args[0] === "fetch");
    assert.deepEqual(fetch.args, FETCH_MAIN);
    assert.equal(fetch.args.includes("--unshallow"), false);
  });

  it("для shallow-репозитория добавляет --unshallow", async () => {
    const { runner, calls } = createRunner({ shallow: true });
    await fetchMain({ runner, cwd: REPO_ROOT });
    const fetch = calls.find((entry) => entry.args[0] === "fetch");
    assert.equal(fetch.args.includes("--unshallow"), true);
  });

  it("релиз обновляет origin/main перед проверкой ancestry", async () => {
    const { runner, calls } = createRunner();
    await release({ runner, cwd: REPO_ROOT, env: releaseEnv(), dryRun: true, log: () => {} });
    const fetchIndex = calls.findIndex((entry) => entry.args[0] === "fetch");
    const ancestorIndex = calls.findIndex((entry) => entry.args[0] === "merge-base");
    assert.equal(fetchIndex >= 0, true);
    assert.equal(fetchIndex < ancestorIndex, true);
  });
});

describe("принадлежность коммита origin/main", () => {
  it("коммит в истории main проходит", async () => {
    const { runner, calls } = createRunner({ ancestor: true });
    await assert.doesNotThrow(() => assertAncestor({ runner, cwd: REPO_ROOT, sha: SHA }));
    const call = calls.find((entry) => entry.args[0] === "merge-base");
    assert.deepEqual(call.args, ["merge-base", "--is-ancestor", SHA, "origin/main"]);
  });

  it("коммит вне истории main отклоняется", async () => {
    const { runner } = createRunner({ ancestor: false });
    await assert.rejects(() => assertAncestor({ runner, cwd: REPO_ROOT, sha: SHA }), {
      code: "release_not_in_main",
    });
  });
});

describe("временный npmrc", () => {
  it("содержит плейсхолдер токена и не раскрывает секрет", () => {
    const content = buildNpmrc();
    assert.match(content, /\$\{NPM_TOKEN\}/);
    assert.match(content, /_authToken=\$\{NPM_TOKEN\}/);
    assert.equal(content.includes("granular-token-value"), false);
  });

  it("учитывает нестандартный registry и переменную токена", () => {
    const content = buildNpmrc({ registry: "https://npm.example.com/", tokenVar: "MY_TOKEN" });
    assert.match(content, /registry=https:\/\/npm\.example\.com\//);
    assert.match(content, /\/\/npm\.example\.com\/:_authToken=\$\{MY_TOKEN\}/);
  });
});

describe("точки входа и секреты в пакете", () => {
  it("точки входа собираются из main, exports и bin без дублей", () => {
    const pkg = {
      main: "./src/index.js",
      exports: { ".": "./src/index.js", "./server": "./src/index.js" },
      bin: { gitwt: "./bin/gitwt.js" },
    };
    assert.deepEqual(collectEntryPoints(pkg).sort(), ["bin/gitwt.js", "src/index.js"]);
  });

  it("отсутствующая точка входа в упаковке отклоняется", () => {
    const pkg = { main: "./src/index.js", exports: { ".": "./src/index.js" }, bin: {} };
    assert.throws(
      () => assertExportsPacked({ manifest: { files: [{ path: "package.json" }] }, pkg }),
      { code: "release_exports_missing" },
    );
  });

  it("упаковка со всеми точками входа проходит", () => {
    assert.doesNotThrow(() =>
      assertExportsPacked({ manifest: { files: PACK_FILES }, pkg: PACKAGE }),
    );
  });

  it(".npmrc в пакете отклоняется", () => {
    assert.throws(() => assertNoSecretArtifacts({ manifest: { files: [{ path: ".npmrc" }] } }), {
      code: "release_secret_artifact",
    });
  });

  it("файлы секретов не находятся в обычной упаковке", () => {
    assert.doesNotThrow(() => assertNoSecretArtifacts({ manifest: { files: PACK_FILES } }));
  });
});

describe("защита от перезаписи версии", () => {
  it("уже опубликованная версия отклоняется", async () => {
    const { runner } = createRunner({ published: true });
    await assert.rejects(
      () =>
        assertNotPublished({
          runner,
          cwd: REPO_ROOT,
          name: PACKAGE.name,
          version: PACKAGE.version,
        }),
      { code: "release_version_published" },
    );
  });

  it("неизвестная версия проходит проверку", async () => {
    const { runner } = createRunner({ published: false });
    await assert.doesNotThrow(() =>
      assertNotPublished({ runner, cwd: REPO_ROOT, name: PACKAGE.name, version: PACKAGE.version }),
    );
  });

  it("недоступность реестра не проглатывается", async () => {
    const runner = async () => ({ stdout: "", stderr: "network timeout", code: 1 });
    await assert.rejects(
      () =>
        assertNotPublished({
          runner,
          cwd: REPO_ROOT,
          name: PACKAGE.name,
          version: PACKAGE.version,
        }),
      { code: "release_registry_unavailable" },
    );
  });
});

describe("режим проверки упаковки", () => {
  it("делает dry-run упаковку и валидирует экспорт без внешнего npm", async () => {
    const { runner, calls } = createRunner();
    const manifest = await checkPackage({ runner, cwd: REPO_ROOT, log: () => {} });
    assert.equal(manifest.filename, TARBALL_NAME);
    const pack = calls.find((entry) => entry.args[0] === "pack");
    assert.equal(pack.args.includes("--dry-run"), true);
  });

  it("падает при отсутствующей точке входа в dry-run упаковке", async () => {
    const { runner } = createRunner({ packFiles: [{ path: "package.json" }] });
    await assert.rejects(() => checkPackage({ runner, cwd: REPO_ROOT, log: () => {} }), {
      code: "release_exports_missing",
    });
  });
});

describe("сценарий релиза", () => {
  it("dry-run проходит проверки и не публикует", async () => {
    const { runner, calls } = createRunner();
    const result = await release({
      runner,
      cwd: REPO_ROOT,
      env: releaseEnv(),
      dryRun: true,
      log: () => {},
    });
    assert.equal(result.published, false);
    assert.equal(result.tarball.endsWith(TARBALL_NAME), true);
    assert.equal(
      calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"),
      false,
    );
    assert.equal(
      calls.some((entry) => entry.args[0] === "pack"),
      true,
    );
  });

  it("публикация использует временный npmrc, пробрасывает токен и не раскрывает секрет", async () => {
    const { runner, calls } = createRunner();
    const result = await release({
      runner,
      cwd: REPO_ROOT,
      env: releaseEnv(),
      dryRun: false,
      log: () => {},
    });
    assert.equal(result.published, true);
    const publish = calls.find((entry) => entry.command === "npm" && entry.args[0] === "publish");
    assert.ok(publish);
    assert.equal(publish.options.env.NPM_CONFIG_USERCONFIG.endsWith(".npmrc"), true);
    assert.equal(publish.options.env.NPM_TOKEN, "granular-token-value");
    assert.equal(
      publish.args.some((arg) => String(arg).includes("granular-token-value")),
      false,
    );
    assert.equal(publish.args.includes("--access"), true);
    assert.equal(publish.args.includes("public"), true);
    assert.equal(publish.args.includes("--ignore-scripts"), true);
  });

  it("секретный файл в упаковке останавливает релиз", async () => {
    const { runner, calls } = createRunner({
      packFiles: [...PACK_FILES, { path: ".npmrc" }],
    });
    await assert.rejects(
      release({ runner, cwd: REPO_ROOT, env: releaseEnv(), dryRun: true, log: () => {} }),
      { code: "release_secret_artifact" },
    );
    assert.equal(
      calls.some((entry) => entry.args[0] === "publish"),
      false,
    );
  });

  it("несовпадающий тег останавливает релиз до обращений к git и npm", async () => {
    const { runner, calls } = createRunner();
    await assert.rejects(
      release({
        runner,
        cwd: REPO_ROOT,
        env: releaseEnv({ RELEASE_TAG: "v9.9.9" }),
        dryRun: true,
        log: () => {},
      }),
      { code: "release_tag_mismatch" },
    );
    assert.equal(calls.length, 0);
  });

  it("пустой тег останавливает релиз до обращений к git и npm", async () => {
    const { runner, calls } = createRunner();
    await assert.rejects(
      release({
        runner,
        cwd: REPO_ROOT,
        env: releaseEnv({ RELEASE_TAG: "" }),
        dryRun: true,
        log: () => {},
      }),
      { code: "release_tag_missing" },
    );
    assert.equal(calls.length, 0);
  });

  it("отсутствие NPM_TOKEN останавливает публикацию", async () => {
    const { runner } = createRunner();
    await assert.rejects(
      release({
        runner,
        cwd: REPO_ROOT,
        env: releaseEnv({ NPM_TOKEN: "" }),
        dryRun: false,
        log: () => {},
      }),
      { code: "release_token_missing" },
    );
  });
});
