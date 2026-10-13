# Обработчик: запуск Windows/macOS/Linux

Этап 7, 2026-10-13. Node.js 22.12+ (закреплено в package.json engines и образе тестов
`node:22.19.0-bookworm-slim`). Без `ffmpeg`/`ffprobe` нет media.transcode.
`media.transcribe`/`media.subtitles` появляются после ACTIVE моделей.
`testExecutor: true` только для транспорта и никогда не даёт READY.

## Подготовка

Нужны Node.js 22.12+ и npm. Go нужен для сборки диспетчера, на машине обработчика
его устанавливать не требуется. Из корня репозитория:

```powershell
cd processor
npm ci
npm run build
Copy-Item config.example.json config.json
New-Item -ItemType Directory -Force ./data/work
```

macOS/Linux:

```sh
cd processor
npm ci
npm run build
cp config.example.json config.json
mkdir -p ./data/work
```

Создать устройство и выпустить DEVICE-токен по [инструкции диспетчера](dispatcher-development.md).
CLI пока используют при остановленном диспетчере. В `processor/config.json` указать
полученный `deviceId` и адрес `wss://<домен>/api/v2/device/connect`.
Для localhost допускается `ws://127.0.0.1:8090/api/v2/device/connect`.
Для LAN/сервера нужен WSS с доверенным сертификатом и проксированием WebSocket Upgrade.

Windows, в терминале запуска:

```powershell
$env:PROCESSOR_TOKEN = '<DEVICE-токен>'
npm start -- config.json
```

macOS/Linux:

```sh
export PROCESSOR_TOKEN='<DEVICE-токен>'
npm start -- config.json
```

`CONNECTED` означает установленную сессию. Ctrl+C останавливает собственные исполнители
и сохраняет сообщения для повторной отправки. SITE-токен не подходит. Токен берётся из
окружения; в конфиг, журнал и дочерний исполнитель не записывается.
Панель задаёт паузу/параллельность/каталог через CONFIGURE. Проверка среды:

```powershell
npm start -- --doctor
npm start -- config.json --doctor
```

Автозапуск (токен в `processor/data/processor.token` строкой `PROCESSOR_TOKEN=…`, режим 600):

```powershell
.\packaging\install.ps1
.\packaging\install.ps1 -Disable
```

```sh
chmod +x packaging/install.sh packaging/package.sh
./packaging/package.sh
echo "PROCESSOR_TOKEN=…" > data/processor.token
chmod 600 data/processor.token
./packaging/install.sh
./packaging/install.sh --disable
```

Linux — user systemd `titunki-processor.service`, macOS — LaunchAgent
`com.titunki.processor`, Windows — задача `TitunkiProcessor` при входе.

## Параметры и диск

Пути разрешаются относительно текущей папки запуска. `stateDir` содержит журнал,
`workDir` — медиа попыток. Журнал держать на доступном локальном диске,
а `workDir` можно направить на SSD док-станции. Попытки пишутся в
`files/YYYY-MM-DD/<assignment-id>/`; каталог `models/` не очищается с датой.
Рабочая папка должна существовать: программа не создаёт её при отключённом накопителе.
Нужны `ffmpeg` и `ffprobe` в PATH либо поля `ffmpeg`/`ffprobe` в config.json.

Первую привязку внешнего диска выполнять с подключённым накопителем.
При первом запуске сохраняется идентичность рабочей папки/тома. Отсутствие или подмена
блокирует новые задания. Для намеренного переноса остановить обработчик, дождаться
подтверждения прежних сообщений, изменить путь в конфиге и явно привязать его:

```powershell
npm start -- config.json --bind-work-volume
```

Команда откажет, если в журнале остались попытки или неподтверждённые сообщения.
Она не удаляет файлы. Сначала восстановить связь и согласовать прежние попытки.

| Параметр | Назначение |
| --- | --- |
| `maxParallel` | Верхний предел 1–64, по умолчанию 2 |
| `threshold` | CPU/RAM/занятость диска: при достижении новые работы ждут; максимум 80% |
| `reserveMemoryBytes` | Резерв RAM для системы, по умолчанию 2 GiB |
| `taskMemoryBytes` | Оценка памяти задачи, по умолчанию 1 GiB; уточнить замерами |
| `reserveDiskBytes` | Резерв места, по умолчанию 2 GiB |
| `paused` | Запрет новых заданий; текущие сохраняют продление |
| `testExecutor` | Только для отдельного тестового устройства/сайта; по умолчанию false |
| `testDurationMs` | Длительность тестового исполнителя, по умолчанию 3000 мс |
| `ffmpeg` / `ffprobe` | Имена или пути программ; по умолчанию `ffmpeg` и `ffprobe` |
| `catalogExtra` | Дополнительный JSON-массив ModelEntry |
| `allowTestModels` | Разрешение catalog-test только для стенда, default false |
| `tokenFile` | Файл ключа для автозапуска из панели |
| `cpuThresholdPercent` / `memoryThresholdPercent` / `diskThresholdPercent` | Независимые пороги 1–80%, default threshold |
| `whisperCpp` | Путь к `whisper-cli`; при отсутствии распознавание не объявляется доступным |

Параллельность уменьшается по доступной RAM и нагрузке. Диспетчер ждёт 15 секунд
устойчиво допустимых ресурсов. Место для исходника и максимального результата
резервируется для принятых работ. GPU/VRAM пока неизвестны: GPU-исполнителя ещё нет;
выбор моделей — команды диспетчера на это устройство. Подтверждённые настройки панели переживают перезапуск.
Модели лежат в `workDir/models/` и не чистятся с датой попыток.

## Проверка без видео

У отдельного тестового устройства поставить `testExecutor: true`. Оно сообщает
`media.transcode`, HLS и `X264_EXACT`, но выполняет только тест соединения и процессов.
Результат — понятная ошибка `TEST_EXECUTOR_ONLY`, никогда готовое видео.
Не подключать этот режим к рабочему сайту.

Из папки processor:

```powershell
npm test
$env:E2E_DISPATCHER = (Resolve-Path ../bin/dispatcher.exe).Path
npm test
```

Без `E2E_DISPATCHER` интеграционный тест явно пропускается. Остальные тесты выполняются.
Полная проверка Linux из корня:

```powershell
docker build -f processor/Dockerfile -t titunki-processor:stage7-test .
docker build --target test -t titunki-dispatcher:stage3-test .
```

Образы предназначены для разработки. Тесты создают свои временные БД и устройства;
в интеграции нагрузка задана контролируемым снимком, чтобы результат не зависел
от занятости машины разработчика.

## Восстановление

Heartbeat — 15 секунд, право исполнения — 120 секунд, запас остановки — 5 секунд.
Отключение соединения не выдаёт нового права. Срок отсчитывается от отправки запроса
на принятие/продление, проверяется по монотонным и календарным часам. Запоздалый ответ
не запускает и не оживляет истёкшую попытку. Отдельный сторож работает при зависшем
основном цикле; потеря IPC останавливает его собственное дерево процессов.

При обычном reconnect действующая попытка сверяется и сохраняет исполнитель.
После перезапуска программы старый исполнитель не запускается по журналу;
отправляется ошибка прежней попытки. Сохранённые PID не используются для убийства
чужих процессов. Ошибки/остановки повторяются до `protocol.ack`, подтверждающего
сохранённую транзакцию. Истёкшая попытка не меняет новое назначение.
10 минут ожидания/отсутствия продвижения — предупреждение, не автоматическая отмена.

[Настоящие модели](processor-models.md). [Автозапуск](processor-installation.md).
