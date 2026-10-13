# Установка обработчиков Windows/macOS/Linux

Обновлено: 2026-10-13. Сервис проверен на Windows/Linux; установка автозапуска
на свежих ОС и реальный Mac требуют приёмки.

Сначала выполнить [инструкцию запуска](processor-development.md): Node.js,
`npm ci`, `npm run build`, FFmpeg/ffprobe, рабочий каталог, ключ устройства и
`--doctor`. Модели ставятся командами панели на выбранное устройство.
Whisper требует отдельно установленного `whisper-cli` (параметр `whisperCpp`).
Локальный перевод использует поставляемые с npm Transformers.js и ONNX Runtime.

Для автозапуска создать UTF-8 файл с одной строкой `PROCESSOR_TOKEN=<ключ>`.
Параметр `tokenFile` задаёт его путь. Не добавлять файл в Git.

Windows, из папки processor:

```powershell
.\packaging\install.ps1 -Config "$PWD\config.json" -TokenFile "$PWD\data\processor.token"
.\packaging\install.ps1 -Disable
```

ACL токена ограничивается владельцем и SYSTEM; создаётся одна задача при входе
текущего пользователя, без видимого окна. Ключ не включается в XML задания.
Unicode пути передаются аргументами PowerShell.

macOS/Linux, из папки processor:

```sh
CONFIG="$PWD/config.json" TOKEN_FILE="$PWD/data/processor.token" sh packaging/install.sh
sh packaging/install.sh --disable
```

macOS: LaunchAgent, автоматическое создание LaunchAgents, экранирование XML,
права 600. Linux: user systemd, экранирование путей с пробелами и `%`,
EnvironmentFile с правами 600. Для работы после выхода из сессии настроить linger.
Отключение автозапуска сохраняет текущий процесс.

Переключатель панели вызывает установщик ОС; успех подтверждается после его
выполнения. Отсутствие файла токена/службы возвращает ошибку.
Для этого нужен штатный запуск `dist/main.js <config.json>`.
Подтверждённые параметры панели переживают перезапуск.

[Модели и настоящая проверка](processor-models.md).
