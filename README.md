# opencode-gitwt

Тонкая обёртка над `git worktree` для OpenCode и CLI. Подход как в `arc-wt`:
создать отдельный checkout, проверить его, получить путь и продолжить работу
в текущей сессии. Git остаётся единственным реестром worktree.

Требования: Node.js от 22.14, Git, OpenCode от 1.19.3 до 2.0.

## Подключение

После первого релиза в npm добавьте в `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gitwt@0.1.0"]
}
```

Для установки из SourceCraft используйте Git-spec вместо имени пакета:

```text
git+https://git@git.sourcecraft.dev/voischev/opencode-gitwt.git#<commit>
```

Замените `<commit>` нужным хешем. Сборка и install-скрипты не нужны.
Для локальной разработки укажите `file://`-путь к `src/index.js`.
После подключения перезапустите OpenCode.

## Работа агента

- `gitwt_create`: создать новую ветку и worktree, проверить корень, ветку и HEAD,
  вернуть `worktreePath`.
- `gitwt_list`: показать реестр Git; `status: true` добавляет live-статус.
- `gitwt_cd`: найти точную ветку или полный путь, вернуть путь, HEAD и статус.
- `gitwt_remove`: явно удалить конкретный worktree, убедившись, что он больше
  не используется.

```json
{ "branch": "feature/login", "base": "main" }
```

Агент продолжает ту же сессию. Возвращённый путь нужно использовать в `workdir`
команд и в путях файловых инструментов. `gitwt_cd` только находит каталог:
он не меняет cwd процесса или контекст сессии. Завершение ответа, чистый статус
или merge ветки не являются командой на удаление. При паузе и передаче задачи
сохраните worktree и передайте его путь, ветку и оставшуюся работу.

## CLI

После публикации: `npm install -g opencode-gitwt`. Из клона: `node bin/git-wt.js`.

```bash
git-wt add feature/login --base main --json
git-wt add review-copy --from origin/feature/login --path "/tmp/review copy"
git-wt list --status --json
git-wt cd feature/login
git-wt hooks feature/login
git-wt remove feature/login
git-wt config
```

`add` всегда создаёт новую ветку. Для существующей работы укажите проверенный
ref или commit в `--from`, а новой копии дайте другое имя. По умолчанию база
обновляется из remote: `trunk`, затем `main`, затем `master`, затем remote HEAD.
Fetch повторяется один раз при ошибке. Грязный исходный checkout не мешает
созданию, его изменения не переносятся. Ошибка создания может оставить копию:
сначала осмотрите сообщённый путь, не повторяйте создание вслепую.

`--path` — полный путь копии; `--dir` — базовый каталог. Без них используется
`~/git-wt/<имя-репо>-<id>/<ветка>`. Имена веток сохраняются и проверяются Git.
`--remote` и `--prefix` переопределяют настройки.

`cd` печатает только каталог. `--json` выдаёт один JSON-объект или массив,
ошибки идут в stderr с ненулевым exit code. `list --porcelain` также выдаёт
JSON-массив. Неизвестные ahead/behind отсутствуют в ответе, а не равны нулю.

## Опциональные хуки

Один формат настроек: JSONC. Приоритет: значения по умолчанию →
`~/.config/opencode/gitwt.jsonc` → `.opencode/gitwt.jsonc` исходного checkout →
параметры плагина → аргументы операции.

```jsonc
{
  "remote": "origin",
  "base": "auto",
  "worktreeDir": "~/worktrees",
  "hooks": {
    "postCreate": [["npm", "ci"]],
    "preRemove": [["docker", "compose", "down"]]
  }
}
```

Команда — argv-массив или явная shell-строка (`bash -c` / `cmd /c`).
В хуках доступны `BRANCH`, `WORKTREE_PATH`, `HEAD`; в postCreate дополнительно
`SOURCE_PATH`. cwd — целевой worktree. Подготовку окружения, например копирование
локального `.env`, при необходимости выполняет postCreate.

Снимок обоих хуков сохраняется в служебном каталоге конкретного Git worktree,
не в рабочих файлах. Текущий конфиг не подменяет preRemove существующей копии.
`add --no-hooks` явно сохраняет отключённые хуки; ради JSON отключать их не надо.
Ошибка postCreate возвращается предупреждением при сохранённой копии.
Ошибка preRemove блокирует удаление даже с `--force`.

`hooks` — read-only диагностика без текста команд. Только `snapshot: "present"`
и `preRemove: "none"` подтверждают сохранённое отключение. У вручную созданного
worktree снимка может не быть; это не считается доказательством отключения.
Повреждённый снимок вызывает ошибку, автоматически не исправляется.

## Удаление

Удаление выполняется сразу и только явно. Основной и текущий worktree защищены;
удаляйте из другого checkout. Dirty проверяется до и после preRemove.
`--force` разрешает потерю локальных изменений, но не обходит ошибку хука.
После удаления используется `git branch -d`: неслитая ветка сохраняется
с предупреждением. `--keep-branch` оставляет ветку в любом случае.

Терминалы, перенос сессий, lease, отдельная база состояний и очистка по idle
не используются. Нет автокоммитов, push, reset и фонового удаления.

## Проверка и npm-релиз

```bash
npm ci --ignore-scripts
npm run check
npm test
node scripts/release.js --check
```

Тесты используют реальные временные Git-репозитории. При наличии OpenCode
1.19.3 smoke-тест проверяет регистрацию инструментов в изолированном сервере
без LLM. Для сквозной Git-установки задайте `GITWT_TEST_PLUGIN_SPEC` равным
Git-spec и запустите `node --test test/plugin.test.js`.

SourceCraft CI проверяет PR и main. Для публикации добавьте granular npm-токен
в секрет репозитория `NPM_TOKEN`, влейте PR и отправьте тег версии `v0.1.0`.
Workflow проверяет тесты, линт, тег/HEAD, историю origin/main и tarball перед
публикацией. Токен доступен только кубику publish, временный `.npmrc` создаётся
вне репозитория. npm Trusted Publishing для SourceCraft не поддерживается.

Репозиторий:
https://sourcecraft.dev/voischev/opencode-gitwt
