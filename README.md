# opencode-gitwt

A standalone `git worktree` CLI with an optional OpenCode plugin.
Create a branch, verify its checkout, and keep working in the returned directory.

Requires Node.js 22.14+ and Git. The plugin supports OpenCode 1.19.3–<2.

## CLI

```sh
npm install -g opencode-gitwt
git-wt add feature/login --base main --json
git-wt list --status --json
git-wt cd feature/login
git-wt remove feature/login
```

`add` creates a new branch from a freshly fetched remote base and verifies the
checkout. Use `--from <ref>` for a local ref or commit, `--path` for an exact
destination, or `--dir` for a base directory. `cd` prints the path; `--json`
provides machine-readable output.

Removal protects the main/current checkout and local changes. `--force` allows
discarding changes; unmerged branches are kept. Use `--keep-branch` to preserve
the branch regardless of merge status.

## OpenCode

Add to `opencode.json`, then restart OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gitwt@0.1.0"]
}
```

Exposes `gitwt_create`, `gitwt_list`, `gitwt_cd`, and `gitwt_remove` as agent tools.
Use the returned `worktreePath` as the command working directory or in file paths;
the current session stays in place.

## Configuration and hooks

Project settings: `.opencode/gitwt.jsonc`. Global defaults:
`~/.config/opencode/gitwt.jsonc`. Options: `remote`, `base`, `prefix`,
`worktreeDir`, and `hooks`.

```json
{ "hooks": { "postCreate": [["npm", "ci"]] } }
```

Hooks accept argument arrays or shell commands. Each worktree saves its own
`postCreate`/`preRemove` snapshot; `add --no-hooks` disables both for that copy.
A failed `postCreate` returns a warning; a failed `preRemove` blocks removal even
with `--force`. Inspect settings with `git-wt config` and snapshots with
`git-wt hooks <branch-or-path>`.

## Development and releases

```sh
npm ci --ignore-scripts
npm run check
npm test
node scripts/release.js --check
```

Version tags (`vX.Y.Z`) on `main` publish through SourceCraft CI using the
repository's `NPM_TOKEN` secret.
