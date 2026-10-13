> Этап 7: Compose/health, snapshot/restore, обслуживание и обновление из панели.
> CLI restore только на остановленном процессе. [Обработчик](processor-development.md).

# Диспетчер: локальная разработка и запуск

Обновлено: 2026-10-13. Реализованы ядро, WSS, transfer, каталог, панель и поставка.
Production-веса whisper/NLLB ставятся командами на устройство.

## Требования и проверки

Go 1.27+, для контейнера — Docker. Python/jsonschema нужны только для проверки контрактов,
в runtime Python и npm не используются. Зависимости Go закреплены в go.mod/go.sum.

```powershell
go version
go mod download
go vet ./...
go test ./...
python contracts/validate.py
```

Или `./scripts/check.ps1`. На Linux проверить гонки: `go test -race ./...` с C-компилятором.
На Windows без C-компилятора использовать тестовый Docker target:

```powershell
docker build --target test -t titunki-dispatcher-tests:stage7 .
```

Тесты проверяют конкурентный приём/назначение, права и повторы renewal, fairness/FIFO,
изоляцию токенов, отключение сайтов, ресурсы, отмену/release, restart, аварийное завершение
процесса и tombstones. Содержимое HLS и качество моделей здесь не тестируются.

## Сборка и первоначальные настройки

Из корня репозитория:

```powershell
go build -trimpath -ldflags="-s -w" -o ./bin/dispatcher.exe ./cmd/dispatcher
./bin/dispatcher.exe init -db ./data/dispatcher.db
./bin/dispatcher.exe owner-bootstrap -db ./data/dispatcher.db -login owner -password "choose-a-long-password"
./bin/dispatcher.exe site-create -db ./data/dispatcher.db -name courses -weight 4 -operations media.transcode,media.transcribe,media.subtitles
./bin/dispatcher.exe site-list -db ./data/dispatcher.db
```

Создание сайта выводит его id. Подставить id в команду выпуска токена:

```powershell
./bin/dispatcher.exe token-issue -db ./data/dispatcher.db -purpose SITE -id <site-id>
./bin/dispatcher.exe device-create -db ./data/dispatcher.db -name windows-main
./bin/dispatcher.exe token-issue -db ./data/dispatcher.db -purpose DEVICE -id <device-id>
```

`<site-id>`/`<device-id>` — места для реальных UUID, не буквальный текст для PowerShell.
Секрет появляется только в ответе token-issue; повтор команды создаёт новый токен.
Сохранить секрет в защищённых настройках соответствующего клиента. В БД хранится SHA256,
список токенов содержит только метаданные. Если ответ потерян, найти id, отозвать и выпустить новый.

```powershell
./bin/dispatcher.exe token-list -db ./data/dispatcher.db
./bin/dispatcher.exe token-revoke -db ./data/dispatcher.db -id <token-id>
./bin/dispatcher.exe site-set -db ./data/dispatcher.db -id <site-id> -weight 4 -enabled=true -operations media.transcode
./bin/dispatcher.exe device-set -db ./data/dispatcher.db -id <device-id> -enabled=false
./bin/dispatcher.exe catalog-list -db ./data/dispatcher.db
./bin/dispatcher.exe catalog-import -db ./data/dispatcher.db -catalog ./catalog.json
./bin/dispatcher.exe command-enqueue -db ./data/dispatcher.db -id <device-id> -command ./install.json
./bin/dispatcher.exe command-get -db ./data/dispatcher.db -id <request-id>
./bin/dispatcher.exe serve -db ./data/dispatcher.db -listen 127.0.0.1:8090
```

`catalog-import` принимает JSON-массив ModelEntry. Production-записи whisper.cpp/NLLB
сеются при `init`. catalog-test — только для стенда без загрузки гигабайт.
Команды MODEL_INSTALL/ACTIVATE/DELETE исполняет подключённое устройство; CLI ставит
их в очередь при остановленном диспетчере. Скачанная модель не считается готовой,
пока нет ACTIVATE и ONLINE в возможностях устройства.

У site-set явно задаются текущие weight/enabled; operations без флага сохраняются.
Отключение сайта запрещает новые заявки, принятые завершаются; revoke токена устройства
закрывает сессию, но не даёт права немедленного резерва до stop/expiry.

Сайты/устройства/токены по-прежнему можно менять CLI **при остановленном диспетчере**.
После `owner-bootstrap` живое управление — панель `http://127.0.0.1:8090/panel/`
и `/api/v2/admin/*` (cookie + CSRF). Сброс пароля владельца без почты:

```powershell
./bin/dispatcher.exe owner-reset-password -db ./data/dispatcher.db -login owner -password "new-long-password"
```

Команда требует остановленный процесс и инвалидирует сессии. Ctrl+C/SIGTERM останавливают сервер.
Зависшее/аварийно завершённое приложение освобождает OS-блокировку; файл .lock удалять не нужно.

У нового устройства нет установленных возможностей. Поэтому заявки получают REJECTED,
пока совместимый исполнитель не зарегистрирован. Для проверенного стенда можно передать
device-create `-capabilities <file.json>`: файл содержит массив OperationCapability v2.
Это декларация стенда, не установка модели и не доказательство её работоспособности.
После этапа 3 реальное устройство обновляет возможности при соединении/heartbeat.

## HTTP и границы текущей реализации

Работают:

- `GET /healthz`;
- `GET /api/v2/site/capabilities`;
- `POST /api/v2/site/jobs`, `GET /api/v2/site/jobs`, `GET /api/v2/site/jobs/{id}`;
- `POST /api/v2/site/jobs/{id}/cancel` и `/release`;
- `GET /api/v2/site/jobs/{id}/transfers`, `POST .../transfer-grants`;
- `POST .../publication-claim` и `.../publication-decision`;
- отказ legacy operations/jobs с PROTOCOL_UPGRADE_REQUIRED.

Сайт использует `Authorization: Bearer <site-token>` и JSON v2, см. [контракт](../../contracts/README.md).
Повтор идентичного задания сохраняет UUID и возвращает текущее состояние; другое содержимое
с тем же UUID —409. UUID задания и ревизии источника приводятся к нижнему регистру.
Опрос доступен только своему сайту, cursor также относится к сайту.
Неподдержанный основной исполнитель сохраняет REJECTED; offline известного исполнителя — QUEUED.

Admin API: session/sites/devices/accounts/tokens/commands/models, плюс очередь
`GET /api/v2/admin/jobs?siteId=` и отмена. Сайт выдаёт GET/PUT хранилища сам;
диспетчер хранит только метаданные и краткоживущие страницы grant.

Результаты видео создаёт обработчик с FFmpeg; аудио/субтитры — активные модели на устройстве.
Сайты остаются в SERVER-режиме до клиента v2. Не включать EXTERNAL на рабочем
сайте до приёмки интеграции.

## Долговечность, планировщик и хранение

SQLite WAL + synchronous FULL, один писатель, миграция 001, постоянный epoch.
При restart закрываются сетевые сессии, сохраняются заявки/права/сроки; expired назначение
закрывается прежде нового. После восстановления старого snapshot запуск ещё не поддержан:
нужны maintenance, новый epoch и сверка сайтов на этапе 7; не подменять файл работающей БД.

Планировщик — smooth weighted round robin по eligible сайтам, FIFO среди совместимых
задач сайта. Изменение eligible состава сбрасывает credits. Отключённый сайт завершает backlog.
Профиль и возможности проверяются по конкретному устройству, не объединяются в выдуманный конвейер.
Текущая версия консервативно вычитает все ASSIGNED/RUNNING/STOPPING права из availableSlots:
показатель трактуется как верхняя граница допуска по текущему снимку. Детали мониторинга
реального исполнителя уточняются на этапе 3.

История и audit по умолчанию 30 дней (`-history-days`, `-audit-days`). Очистка при старте
и ежечасно удаляет только терминальную историю, оставляя ID/fingerprint/status в tombstones
без автоматического expiry. Активные задания, неполученный результат и публикация не удаляются.
Диспетчер не хранит медиа или веса моделей. Состояния и интервалы: [states.md](../../contracts/v2/states.md).

## Контейнер

```powershell
docker compose build
docker compose run --rm dispatcher init -db /data/dispatcher.db
docker compose run --rm dispatcher owner-bootstrap -db /data/dispatcher.db -login owner -password "choose-a-long-password"
docker compose up -d
docker compose exec dispatcher wget -q -O - http://127.0.0.1:8090/readyz
docker compose logs dispatcher
```

Пока `serve` держит файл БД, второй CLI к тому же тому не открывается. Сайты/токены —
панель `http://127.0.0.1:8090/panel/` или `docker compose stop dispatcher` и затем
`docker compose run --rm dispatcher …`. Именованный том dispatcher-data хранит БД, WAL и `backups/`.
Compose: 256 MiB / 1 CPU, порт только localhost, json-file логи 10m×3, restart unless-stopped.
Образ UID 10001. Пример HTTPS/WSS: [nginx-dispatcher.conf](../../deploy/nginx-dispatcher.conf).
Серверная процедура: [dispatcher-server.md](dispatcher-server.md).

```powershell
# Снимок при работающем serve: панель «Согласованный снимок» или суточный цикл (03:00 UTC).
# CLI backup/restore к тому же файлу — только после stop (эксклюзивная блокировка).
docker compose stop dispatcher
docker compose run --rm dispatcher restore -db /data/dispatcher.db -from /data/backups/dispatcher-YYYYMMDDThhmmssZ.db
docker compose up -d
```

Restore меняет epoch, закрывает активные назначения и включает обслуживание.
Снимок не содержит задания, принятые после него.

## Воспроизводимый нагрузочный стенд

```powershell
docker build -t titunki-dispatcher:stage7 .
./scripts/load-docker.ps1 -Jobs 2000
```

Скрипт создаёт свои контейнер/том с уникальными именами, 10 сайтов и 20 offline устройств,
выпускает временные тестовые токены, отправляет metadata по HTTP и проверяет очередь/replay
после restart. Всё созданное им удаляется в finally; рабочий compose-том не используется.
Это тест метаданных, без скачивания файлов, WSS, FFmpeg или реальных моделей.
Печатает CPU seconds, throughput, memory.peak cgroup (включая cache) и Docker memory;
секреты не печатает. [Отчёт этапа 2](../audits/dispatcher-stage2-2026-10-13.md).
