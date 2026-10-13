# Модели обработчика

Дата: 2026-10-13. Распознавание и перевод исполняются отдельно от сетевого агента:
управляемый процесс, worker thread, независимый контроль аренды и остановка дерева.

Каталог:

- `whisper-cpp-base`, `ggml-base-hf-5359861`, около 148 MB.
- `whisper-cpp-small`, `ggml-small-hf-5359861`, около 488 MB.
- `opus-mt-en-ru-q8` и `opus-mt-ru-en-q8`, по 118 MB;
  точные версии/файлы в `contracts/translation-catalog.json`.

Base/small поддерживают 99 языков исходного Whisper, без Cantonese/yue из large-v3.
Язык auto берётся из JSON whisper.cpp. Аудио возвращается на исходном языке;
перевод выполняется для субтитров. FAST/QUALITY/AUTO выбирают среди активных моделей,
помещающихся в свободной RAM. Работают резерв RAM и независимые пороги CPU/RAM/диска.

Whisper требует `whisper-cli` и FFmpeg/ffprobe. Путь CLI задаётся `whisperCpp`.
[Официальная установка](https://github.com/ggml-org/whisper.cpp/tree/v1.7.6).
Windows тест использовал официальный whisper-bin-x64.zip v1.7.6.
Модели закреплены на immutable HF commit; размер и SHA-256 проверяются.

Перевод: Transformers.js 4.3.1, CPU ONNX q8, offline файлы в `workDir/models`.
Скачивания во время перевода запрещены. Модели Apache-2.0:
[EN→RU](https://huggingface.co/Helsinki-NLP/opus-mt-en-ru),
[RU→EN](https://huggingface.co/Helsinki-NLP/opus-mt-ru-en).
NLLB с фиктивными метаданными удалён. Другие направления добавляются через каталог;
язык распознавания не означает наличие перевода на него.

Optional `files` многофайловой ModelEntry содержит `{path, bytes, sha256, url}`.
`downloadBytes` — сумма; общий `sha256` — SHA-256 JCS массива files в заданном порядке.
Проверяется каждый файл. Установка отдельного пакета атомарно переключает журнал;
неудачная переустановка сохраняет предыдущий пакет. Незавершённые пакеты очищаются
при запуске. Перенос workDir с установленными моделями требует сначала удаления
моделей через панель, затем установки на новый диск.

После установки требуется активация. Отсутствующий CLI/файл и неподдерживаемый
исполнитель не дают успешную активацию или capabilities.
`catalog-test` разрешён только с `allowTestModels: true`, default false.

Повторяемый настоящий тест, из processor (первые загрузки около 384 MB):

```powershell
$env:WHISPER_CPP = "C:\absolute\path\whisper-cli.exe"
$env:MODEL_SMOKE_WORK_DIR = "$PWD\..\tmp\real-model-smoke"
npm run test:models
```

```sh
WHISPER_CPP=/absolute/path/whisper-cli MODEL_SMOKE_WORK_DIR=../tmp/real-model-smoke npm run test:models
```

Нужны FFmpeg/ffprobe. Проверяется официальный короткий WAV, auto язык, настоящий
текст и переводы EN→RU/RU→EN с сохранением таймингов. Тест не соединяется с сайтом.
На Windows выполнен успешно; Mac и длинные файлы — следующая приёмка.

Источники: FILE и незашифрованный VOD HLS. Все HLS части проверяются по размерам/хешам;
ссылки плейлистов должны вести к объявленным локальным частям. Сетевые ссылки,
выход из каталога, неоднозначный корень и шифрованный HLS отклоняются.
