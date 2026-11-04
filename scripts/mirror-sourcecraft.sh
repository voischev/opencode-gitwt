#!/usr/bin/env bash
set -eu

export GIT_TERMINAL_PROMPT=0

fail() {
  printf 'Ошибка: %s\n' "$1" >&2
  exit 1
}

require_env() {
  [ -n "$2" ] || fail "переменная окружения $1 пуста"
}

require_env SOURCECRAFT_TOKEN "${SOURCECRAFT_TOKEN:-}"
require_env SOURCECRAFT_OWNER "${SOURCECRAFT_OWNER:-}"
require_env GITHUB_REPOSITORY "${GITHUB_REPOSITORY:-}"
require_env GITHUB_REF "${GITHUB_REF:-}"

case "$GITHUB_REPOSITORY" in
  */*) ;;
  *) fail "GITHUB_REPOSITORY должен иметь вид owner/repo" ;;
esac

repo="${GITHUB_REPOSITORY#*/}"

case "$repo" in
  "" | *[!A-Za-z0-9._-]*) fail "некорректное имя репозитория в GITHUB_REPOSITORY" ;;
esac

case "$SOURCECRAFT_OWNER" in
  "" | *[!A-Za-z0-9._-]*) fail "некорректное имя SOURCECRAFT_OWNER" ;;
esac

case "$GITHUB_REF" in
  refs/heads/main | refs/tags/v*) ;;
  *) fail "неподдерживаемый GITHUB_REF: $GITHUB_REF" ;;
esac

remote_url="https://git@git.sourcecraft.dev/${SOURCECRAFT_OWNER}/${repo}.git"
credential_helper='!f() { printf "%s\n" "username=git" "password=$SOURCECRAFT_TOKEN"; }; f'

printf 'Зеркалирование %s в SourceCraft\n' "$GITHUB_REPOSITORY"

git fetch origin main:refs/remotes/origin/main
git -c credential.helper= -c "credential.helper=$credential_helper" \
  push "$remote_url" origin/main:refs/heads/main
printf 'SourceCraft main обновлён\n'

if [ "$GITHUB_REF" != "refs/heads/main" ]; then
  tag="${GITHUB_REF#refs/tags/}"
  [ -n "$tag" ] || fail "не удалось определить имя тега из GITHUB_REF"

  git rev-parse --verify "refs/tags/${tag}^{commit}" >/dev/null 2>&1 ||
    fail "локальный тег $tag не найден или не указывает на коммит"

  git -c credential.helper= -c "credential.helper=$credential_helper" \
    push "$remote_url" "refs/tags/${tag}:refs/tags/${tag}"
  printf 'SourceCraft тег %s обновлён\n' "$tag"
fi
