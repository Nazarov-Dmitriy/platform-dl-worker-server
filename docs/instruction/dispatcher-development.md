> Этап 3 реализован: `/api/v2/device/connect` принимает WSS через HTTPS-прокси.
> [Обработчик и запуск](processor-development.md). Миграция 002 применяется при открытии БД,
> сохраняет прежние задания и добавляет подтверждения terminal сообщений.
> Сроки serve: `-heartbeat 15s -lease 120s -stop-safety 5s -admission-stable 15s`.
> Файлы/публикация и admin API пока не реализованы.

# Диспетчер: локальная разработка и запуск

Обновлено: 2026-10-13. Реализованы ядро Go/SQLite и WSS устройств с Node.js-обработчиком.
Передача файлов/публикация — этап 4,
модели — этап 5, аккаунты/сессии/панель — этап 6. Это ещё не готовая обработка видео.

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
docker build --target test -t titunki-dispatcher-tests:stage2 .
```

Тесты проверяют конкурентный приём/назначение, права и повторы renewal, fairness/FIFO,
изоляцию токенов, отключение сайтов, ресурсы, отмену/release, restart, аварийное завершение
процесса и tombstones. Содержимое HLS и качество моделей здесь не тестируются.

## Сборка и первоначальные настройки

Из корня репозитория:

```powershell
go build -trimpath -ldflags="-s -w" -o ./bin/dispatcher.exe ./cmd/dispatcher
./bin/dispatcher.exe init -db ./data/dispatcher.db
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
./bin/dispatcher.exe serve -db ./data/dispatcher.db -listen 127.0.0.1:8090
```

У site-set явно задаются текущие weight/enabled; operations без флага сохраняются.
Отключение сайта запрещает новые заявки, принятые завершаются; revoke токена устройства
закрывает сессию, но не даёт права немедленного резерва до stop/expiry.

В этапе 2 административные изменения делаются CLI **при остановленном диспетчере**.
Эксклюзивная OS-блокировка БД не позволяет второму CLI/сервису работать с тем же файлом.
Живое управление через admin API/панель появится на этапе 6. Ctrl+C/SIGTERM останавливают сервер.
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
- отказ legacy operations/jobs с PROTOCOL_UPGRADE_REQUIRED.

Сайт использует `Authorization: Bearer <site-token>` и JSON v2, см. [контракт](../../contracts/README.md).
Повтор идентичного задания сохраняет UUID и возвращает текущее состояние; другое содержимое
с тем же UUID —409. UUID задания и ревизии источника приводятся к нижнему регистру.
Опрос доступен только своему сайту, cursor также относится к сайту.
Неподдержанный основной исполнитель сохраняет REJECTED; offline известного исполнителя — QUEUED.

Не реализованные WSS, transfer/publication и admin endpoints отвечают 501 STAGE_NOT_IMPLEMENTED;
ответ не означает готовности функций. Назначение/accept/renew/reconcile реализованы как
внутренний API ядра и проверены тестами; production-устройство ими ещё не пользуется.

Результаты video/audio/subtitles пока не создаются. Сайты остаются в прежнем SERVER-режиме
до доработки клиента и полной приёмки. Не включать EXTERNAL на рабочем сайте по одному healthz.

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
docker compose run --rm dispatcher site-create -db /data/dispatcher.db -name courses -weight 4
docker compose up -d
docker compose logs dispatcher
```

CLI после запуска: сначала `docker compose stop dispatcher`, затем `docker compose run --rm ...`;
после изменений `docker compose up -d`. Именованный том dispatcher-data сохраняет БД и WAL.
Compose ограничивает контейнер 256 MiB/1 CPU, публикует порт только на localhost.
HTTPS-прокси/домен, backup/restore и безопасное обновление ещё требуют этапа 7.
Образ запускается UID10001; существующий bind mount должен принадлежать этому UID.

## Воспроизводимый нагрузочный стенд

```powershell
docker build -t titunki-dispatcher:stage2 .
./scripts/load-docker.ps1 -Jobs 2000
```

Скрипт создаёт свои контейнер/том с уникальными именами, 10 сайтов и 20 offline устройств,
выпускает временные тестовые токены, отправляет metadata по HTTP и проверяет очередь/replay
после restart. Всё созданное им удаляется в finally; рабочий compose-том не используется.
Это тест метаданных, без скачивания файлов, WSS, FFmpeg или реальных моделей.
Печатает CPU seconds, throughput, memory.peak cgroup (включая cache) и Docker memory;
секреты не печатает. [Отчёт этапа 2](../audits/dispatcher-stage2-2026-10-13.md).
