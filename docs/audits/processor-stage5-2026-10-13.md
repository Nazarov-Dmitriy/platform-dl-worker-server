# Этап 5: каталог моделей, аудио и субтитры

Дата: 2026-10-13. Закреплены исполнители, каталог, команды установки/активации/удаления,
расшифровка в сплошной текст и дорожки субтитров с частичным успехом. Соседние
serverBreasts/front, production VPS и пользовательские медиа не изменялись.

## Закреплённые исполнители

| Назначение | Исполнитель | Модели | Лицензия | Языки |
| --- | --- | --- | --- | --- |
| Распознавание | whisper.cpp | ggml-base, ggml-small | MIT | список multilingual tokenizer OpenAI Whisper, не ru/en сайта |
| Перевод | nllb-ct2 (NLLB-200 distilled 600M int8) | ct2-2024-01 | CC-BY-NC-4.0 | взаимные пары en/ru/de/es/fr/uk/zh из карточки модели |
| CI без гигабайтных весов | catalog-test | JSON-пакеты по HTTP localhost | MIT | языки из импортированной записи каталога |

Скачанный файл ≠ активный исполнитель: `MODEL_INSTALL` пишет в `models/<id>/<revision>/`,
`MODEL_ACTIVATE` даёт языки в heartbeat. Режим контракта FAST/QUALITY/AUTO выбирает
base/small/по RAM среди активных recognition-моделей.

SHA256 ggml-файлов и NLLB в каталоге — закреплённые значения для контроля загрузки.
Пока хеш NLLB-пакета не сверен с фактическим архивом, production-установка NLLB
отклоняется. Для приёмки без загрузки весов используется catalog-test.

## Диспетчер

Миграция `004_models.sql`: каталог, `device_models`, очередь `device_commands`.
CLI при остановленном сервисе: `catalog-list`, `catalog-import -catalog`,
`command-enqueue -id <device> -command`, `command-get -id <requestId>`.
WSS `device.command` / `device.command.result`. Неподдерживаемое направление
при приёме — REJECTED и `manualEntryOffered`. PARTIAL публикации предлагает
ручной текст/дорожку. Ошибка дополнительного шага не требует успешного видео
для transcribe, а для transcode+субтитры видео шаг должен остаться SUCCEEDED.

## Обработчик

Возможности `media.transcribe` / `media.subtitles` объявляются только после ACTIVE
моделей. Аудио → UTF-8 `transcript.txt` без перевода и таймкодов. Субтитры —
отдельные VTT; сбой языка даёт FAILED шаг и PARTIAL, файлы видео и успешные
дорожки сохраняются. `media.preview` обработчик не исполняет.

## Проверки

- Windows: `go vet ./...`, `go test ./...`; 20 Node tests: tokenizer-языки,
  catalog-test текст без перевода, неподдерживаемый zh → REJECTED,
  transcribe FILE JSON → SUCCEEDED transcript, видео COPY + ru VTT + uk FAILED → PARTIAL.
- Реальный whisper.cpp/nllb-ct2, Mac, SSD и плеер сайта здесь не измерялись.

Запуск: [диспетчер](../instruction/dispatcher-development.md),
[обработчик](../instruction/processor-development.md).
Следующий этап — общая панель.
