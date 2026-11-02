# Сборки GitHub в приложении Worker

Управление: **Worker → Настройки → Сборки GitHub**. Официальный GitHub Actions Runner
работает дочерним процессом; медиатокен устройства и очередь диспетчера для сборок не используются.
Поддержка первого этапа: Windows с отдельной Linux x64 в WSL, либо Linux x64. macOS пока не поддержан.

## Окружение текущего компьютера

Выбран отдельный WSL `Worker-CI` на основе Ubuntu 24.04. Диск размещён в
`worker-server/data/ci-wsl`, вне Git; его нельзя удалять как временные файлы.
Пользователь runner — `worker`, папка — `/home/worker/worker-ci-runner`.
Дистрибутив Docker Desktop, production VPS и данные медиа не используются как рабочая папка CI.

Подготовка зависимостей для этой отдельной среды: `scripts/ci/prepare-linux.sh`, запуск root
только в Worker-CI. Нужны Java 21, Git, Bash, Docker Engine с Compose/Buildx, curl, tar,
sha256sum, util-linux (flock/setsid), Python 3, shellcheck, gh и зависимости .NET runner.
После смены wsl.conf нужно перезапустить только Worker-CI, не весь WSL/Docker Desktop.
Для произвольного Linux-хоста подготовить аналогичные зависимости самостоятельно.

Бюджет подготовленной среды: user slice для worker — до 4 CPU и 6 ГиБ RAM;
Docker build slice — отдельно до 4 CPU и 6 ГиБ RAM. Это два бюджета, суммарно до 8 CPU
и 12 ГиБ RAM, а не общий лимит 4/6. Проверить на реальной сборке и совместной медиаобработке.
Они не заменяют лимиты медиа в Worker. Диск и кэши требуют отдельного контроля.
В WSL отключены automount Windows-дисков и interop; эти настройки касаются только Worker-CI.

## Подключение из приложения

1. Закрыть Worker через «Выйти» перед обновлением Windows-поставки. Готовая сборка —
   `releases/windows/win-unpacked/Worker Processor.exe`.
2. В разделе сборок указать репозиторий `Nazarov-Dmitriy/dream-breasts-server`, дистрибутив
   `Worker-CI`, папку `/home/worker/worker-ci-runner`, уникальное имя runner.
3. Нажать «Проверить окружение», затем «Установить runner». Пакет берётся только из
   официального actions/runner, SHA-256 сверяется с GitHub release metadata; нет checksum — нет установки.
4. В репозитории GitHub открыть Settings → Actions → Runners → New self-hosted runner.
   Из команды конфигурации скопировать только значение после `--token` в поле временного токена
   приложения и нажать «Зарегистрировать runner». Не присылать токен в чат и не использовать PAT/DEVICE-токен.
5. Сохранить настройки, запустить сборки. Готовность подтверждается сообщением runner
   «Listening for Jobs»; в GitHub runner должен стать online с метками linux/x64/worker-build.
6. Галочка «Разрешить приём сборок для этих репозиториев» помечает записи как рабочие.
   Запуск при старте приложения включается отдельно: Настройки → Подключение →
   «Включать сборки GitHub автоматически» (по умолчанию включено). Автозапуск самого
   Worker в Windows остаётся третьей, независимой настройкой. Если при старте runner
   не поднялся, запись показывает ошибку с причиной вместо статуса «остановлен».

Временный registration token не записывается Worker в настройки. Официальный runner сохраняет
свои рабочие credentials и диагностические файлы внутри Linux-папки runner; доступ к ней
должен иметь только владелец. Использовать только доверенные репозитории и workflow.
Docker group даёт широкие права внутри этой Linux-среды; непроверенные fork PR сюда не направлять.

## Работа и восстановление

Вкладка показывает локальные состояния runner: подключение, ожидание, выполняется сборка,
потеря связи и остановка. Это не журнал всех workflow в GitHub. Подробные логи сборки — в GitHub Actions.
Скрытие окна в трей сохраняет процесс. Остановка и выход из приложения отказывают во время
известной активной сборки; закрытие окна само по себе не отменяет job.
После сна/потери сети runner переподключается; при завершении процесса повторить запуск в приложении.

Backend и frontend `deploy.yml` выбирают машину `worker-build` или резерв GitHub.
Регистрация runner привязана к одному репозиторию: для фронта нужна отдельная папка
(или org-runner с той же меткой). Итоги: [бэк](../../../serverBreasts/docs/plan/archive/plans-archive.md#ci-сборка-на-машине-worker-с-резервом-github--2026-11-01),
[фронт](../../../front/docs/archive/Plans/worker-ci-runner-plan.md).
GitHub не переключает недоступный self-hosted job на hosted автоматически. При исчерпанном
hosted лимите резерв также может быть заблокирован. Живой запуск и резерв ещё требуют приёмки.

## Настройки и секреты

Источник — отдельный `ci-settings.json` в userData приложения, ENV не требуется:

| Поле | Дефолт | Назначение / обязательность |
|---|---|---|
| repository | Nazarov-Dmitriy/dream-breasts-server | Обязательно, owner/repo; папка зарегистрированного runner должна соответствовать репозиторию |
| distribution | Worker-CI | Обязательно для Windows; WSL-дистрибутив, docker-desktop запрещён |
| directory | /home/worker/worker-ci-runner | Обязательно, отдельная абсолютная Linux-папка внутри /home или /opt |
| name | worker-build | Обязательно, уникальное имя регистрации; метка назначения worker-build фиксирована |
| enabled | true | Запись разрешена к запуску; фактический старт при открытии Worker зависит от launch.ciAutoStart |
| registrationToken | нет | Только для регистрации; не сохраняется Worker, поле UI очищается после отправки |

Смена репозитория/папки/дистрибутива запрещена при запущенном runner. Для другого репозитория
нужна другая папка; существующая регистрация не перезаписывается.

Источники: [установка runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
[официальные пакеты](https://github.com/actions/runner/releases).

## Проверка исходников

Из `processor/`: `npm run ci:test` (модуль runner и регрессии desktop),
`npm run ci:desktop:test` (отдельный профиль Electron, fixture runner без GitHub/медиа),
`npm run ci:linux:test` (одноразовый Docker Linux без сети, образ python:3.12-slim должен быть доступен локально),
`npm run build` (TypeScript). Fixture не является живой приёмкой runner в GitHub.
