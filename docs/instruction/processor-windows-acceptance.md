# Временный запуск Windows для приёмки

2026-10-26: приёмка ещё идёт. Desktop-приложение Windows/macOS запланировано отдельно:
[план](../plan/processor-desktop-plan.md). Сейчас запускаем существующий processor в терминале.
Закрытие этого терминала/VS Code может остановить процесс; автоматический фон пока не включаем.

В панели диспетчера создать устройство Windows, сохранить его ID и выдать DEVICE-токен.
Токен в чат/Git не отправлять. Публичный `device-ca.crt` положить в папку `processor`
рядом с `config.json`. Адрес подключения:
`wss://194.5.79.198:8090/api/v2/device/connect`.

PowerShell, из папки проекта worker-server:

```powershell
cd processor
npm ci
npm run build
New-Item -ItemType Directory -Force .\data\work | Out-Null
```

Node.js и FFmpeg/ffprobe должны быть установлены. На текущем компьютере владельца
они найдены при проверке. Устройства Mac/Windows имеют разные ID и DEVICE-токены.

Первый конфиг, только если `config.json` ещё не существует:

```powershell
if (Test-Path .\config.json) { throw 'config.json уже существует — не перезаписывайте действующее подключение' }
if (!(Test-Path .\device-ca.crt)) { throw 'Положите скачанный device-ca.crt в папку processor' }
$cfg = Get-Content .\config.example.json -Raw | ConvertFrom-Json
$cfg.url = 'wss://194.5.79.198:8090/api/v2/device/connect'
$cfg.deviceId = (Read-Host 'ID устройства Windows из панели').Trim()
$cfg | Add-Member -NotePropertyName tlsCaFile -NotePropertyValue './device-ca.crt' -Force
[IO.File]::WriteAllText((Join-Path $PWD 'config.json'), ($cfg | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
```

Запуск (каждый раз в новом терминале токен вводится заново, скрытым вводом):

```powershell
$env:PROCESSOR_TOKEN = [Net.NetworkCredential]::new('', (Read-Host 'DEVICE-токен' -AsSecureString)).Password
npm start -- config.json --doctor
```

Если диагностика прошла (`ok: true`), запустить:

```powershell
npm start -- config.json
```

Терминал оставить открытым. В панели устройство должно перейти в состояние «В сети»;
это ещё не подтверждает обработку файла. Проверяем отдельное реальное задание до
включения внешней обработки рабочих загрузок сайта. Ctrl+C — остановить обработчик;
затем `Remove-Item Env:PROCESSOR_TOKEN -ErrorAction SilentlyContinue` — убрать токен из окружения терминала.
Конфиг повторно не копировать, рабочую папку и журнал не удалять.

Для видео нужен FFmpeg/ffprobe; распознавание речи/субтитры требуют whisper-cli и активных моделей.
Документация: [модели](processor-models.md), [запуск](processor-development.md).
