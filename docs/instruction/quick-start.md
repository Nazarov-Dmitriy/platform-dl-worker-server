# Коротко: запуск на Windows, Mac и Linux

На компьютерах запускается **обработчик**. Диспетчер запускается отдельно, один
на все устройства. Управление — через его веб-панель.

## Перед первым запуском

Установить Node.js 22.12+ и FFmpeg (вместе с ffprobe), доступные в PATH.
Скопировать проект на компьютер. В панели диспетчера создать устройство и получить
его ID и DEVICE-токен. Для каждого компьютера — своё устройство и свой токен.

## Windows — PowerShell

Открыть терминал в папке проекта:

```powershell
cd processor
npm ci
npm run build
Copy-Item config.example.json config.json
New-Item -ItemType Directory -Force ./data/work
notepad config.json
```

В config.json поставить свой deviceId и адрес диспетчера в url:
`wss://ВАШ-ДОМЕН/api/v2/device/connect`.
Затем выполнить, заменив текст ключа:

```powershell
$env:PROCESSOR_TOKEN = 'ВАШ-DEVICE-ТОКЕН'
npm start -- config.json --doctor
npm start -- config.json
```

## Mac — Терминал

Открыть терминал в папке проекта:

```sh
cd processor
npm ci
npm run build
cp config.example.json config.json
mkdir -p data/work
open -e config.json
```

В config.json поставить свой deviceId и адрес диспетчера в url:
`wss://ВАШ-ДОМЕН/api/v2/device/connect`.
Затем выполнить, заменив текст ключа:

```sh
export PROCESSOR_TOKEN='ВАШ-DEVICE-ТОКЕН'
npm start -- config.json --doctor
npm start -- config.json
```

## Linux — Терминал

Открыть терминал в папке проекта:

```sh
cd processor
npm ci
npm run build
cp config.example.json config.json
mkdir -p data/work
nano config.json
```

В config.json поставить свой deviceId и адрес диспетчера в url:
`wss://ВАШ-ДОМЕН/api/v2/device/connect`.
Затем выполнить, заменив текст ключа:

```sh
export PROCESSOR_TOKEN='ВАШ-DEVICE-ТОКЕН'
npm start -- config.json --doctor
npm start -- config.json
```

## Следующие запуски

Из папки processor задать PROCESSOR_TOKEN командой своей ОС выше и выполнить:

```sh
npm start -- config.json
```

Сборка и копирование config.json нужны только при первой подготовке; существующий
конфиг повторно не заменять. CONNECTED означает, что устройство подключено.
При ручном запуске терминал оставить открытым. Остановить — Ctrl+C.

Для запуска без открытого терминала включить
[автозапуск по инструкции своей ОС](processor-installation.md).
Видео работает с FFmpeg; для расшифровки и субтитров нужны
[установка whisper-cli и активация моделей](processor-models.md).

## Где диспетчер и панель

Если диспетчер уже работает на сервере, на компьютерах повторно его не запускать.
Панель открывается по адресу `https://ВАШ-ДОМЕН/panel/`.

Для первого теста можно запустить диспетчер на Windows по
[инструкции первоначальной настройки](dispatcher-development.md).
После настройки команда из корня проекта:

```powershell
.in\dispatcher.exe serve -db ./data/dispatcher.db -listen 127.0.0.1:8090
```

Панель: `http://127.0.0.1:8090/panel/`.
В обработчике на этом же компьютере url:
`ws://127.0.0.1:8090/api/v2/device/connect`.
Этот локальный адрес не подходит для подключения другого компьютера.
