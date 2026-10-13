# Состояния, право исполнения и устойчивые записи

Сайт хранит свою продуктовую задачу, диспетчер — задачу внешней попытки, устройство —
локальный журнал назначения. id сайта не равен assignmentId устройства.
Протокол: [protocol.md](protocol.md), fixtures/scenarios.json проверяет допустимые трассы.

## Таблица состояний диспетчера

| Состояние | Смысл | Допустимые следующие |
| --- | --- | --- |
| QUEUED | Запись без скачанного файла | ASSIGNED, REJECTED, FAILED, CANCELLED, RELEASED |
| ASSIGNED | Offer, ещё нет права работать | RUNNING, QUEUED, CANCELLED, RELEASED |
| RUNNING | Право на скачивание/обработку/upload | QUEUED, AWAITING_PUBLICATION, CANCELLING, RELEASING, FAILED |
| AWAITING_PUBLICATION | Upload complete сохранён; исполнитель больше не владеет задачей | PUBLISHING, CANCELLED, RELEASED, FAILED |
| PUBLISHING | Claim сайта; результат закреплён до durable решения | SUCCEEDED, PARTIAL, FAILED |
| CANCELLING | Новых прав нет, старое ждёт остановки/expiry | CANCELLED |
| RELEASING | Отсечение перед передачей серверу сайта | RELEASED |
| SUCCEEDED / PARTIAL | Сайт подтвердил публикацию | Терминальные |
| FAILED / REJECTED / CANCELLED / RELEASED | Окончательный исход | Терминальные |

RUNNING→QUEUED только после stop/expiry/закрытия прежнего права. Новое назначение имеет
новый assignmentId и generation+1. ASSIGNED→QUEUED до grant не требует ждать120с:
устройство никогда не получало право. ack после offer expiry не принимается.
RUNNING→AWAITING_PUBLICATION атомарно сохраняет complete+manifest и закрывает lease.
Нельзя после этого переисполнить работу из-за offline устройства.
PUBLISHING не имеет принудительного таймерного перехода в очередь: publication outbox
на сайте может уже содержать READY, даже если решение не дошло до диспетчера.

## Долговечные записи для реализации

1. sites, tokens (purpose/principal/hash), accounts, devices, model_catalog,
   device_models и подтверждённые/желаемые конфигурации.
2. jobs: site/id UNIQUE, fingerprint, type, immutable request, status, revision,
   history timestamps, current assignment, steps, artifact, publication claim/outcome.
3. assignments: UUID, job, generation, epoch, device/session, offer expiry,
   granted lease expiry, last renewal sequence/ID, окончательный исход права.
4. control_messages/dedup: commandId, grant renewalId/replay outcome, pending deliveries;
   передача сообщения выполняется после commit, не внутри транзакции с сетью.
5. transfers: requestId, fence, kind, revision, pages и object mapping, срок ссылок.
   Ссылки хранятся как секретные краткоживущие данные, не в логах/истории.
6. publications/release_requests: request/claim IDs, fingerprints, receipt/outcome,
   terminal dedup tombstones отдельно от очищаемой истории.

Один писатель SQLite, транзакции короткие, busy timeout. Назначение выполняется
условным update QUEUED+текущая revision с созданием assignment в той же транзакции;
UNIQUE/ограничение на один действующий assignment. Сеть и загрузки не держат транзакцию.
Продление/complete/cancel/release проверяют status, session, fence и expiry внутри
одной транзакции. Не проверять право до транзакции и затем писать без повторной проверки.

При dispatcher restart durable expiry сохраняется, epoch тот же. Старые connection
sessions закрыты; устройства reconnect/reconcile. После restore старого snapshot epoch
новый, приём/назначение в maintenance до сверки с сайтами. Tombstones/публикации нельзя
считать отсутствующими только потому, что snapshot старый.

## Планировщик и ресурсы

Smooth weighted round robin по сайтам, имеющим совместимые задания для конкретного
свободного устройства. Default weight1, диапазон1–100. Нормализация/reset credits
при изменении состава eligible сайтов предотвращает накопление неограниченного кредита.
Внутри сайта FIFO по времени приёма среди совместимых задач; несовместимая первая запись
не блокирует остальные. Новое задание не прерывает исполняемое ради приоритета.
Алгоритм распределяет число запусков, а не гарантирует равные CPU-секунды.

Нет начальных количественных site quotas. Metadata/HTTP rate limits и глобальное
отсутствие места для durable записи могут дать отказ до приёма; принятую очередь не терять.
Устройство предлагает availableSlots, проверяет пороги самостоятельно; dispatcher
учитывает зарезервированные ASSIGNED slots и RUNNING jobs, чтобы не назначать лишние.

CPU/RAM/disk threshold80% регулируются, initial parallel1. Stable admission15с,
HIGH memory pressure/недоступный диск/недостаток ожидаемых bytes → ждать.
Порог80% диска — заполненность выбранного тома, не скорость I/O. Загруженный encoder
может ограничить запуск даже при свободном CPU. Оценки расходов по операции уточняются
замерами, поэтому текущая малая нагрузка не доказывает возможность запустить большую модель.

## Наблюдение, повторы и очистка

heartbeat15с; task lease120с; offer10с; queue delay600с.
Нет роста activitySequence600с → warning/suspect, не автоматический kill.
Нужна диагностика процесса/этапа и policy timeout операции. Рост heartbeat не снимает
warning об отсутствии работы. Поддерживать этапы без числового progress.

Скачивание/upload: первая попытка+3 повтора (5/15/45с), URL refresh не меняет объект.
Процесс исполнителя: до3 запусков с новым assignment на временной ошибке; transient
resource shortage до старта не тратит process attempt. Publication verification:
до3 повторов проверки временного сбоя. Permanent ошибка — без автоматического retry.

Терминальные файлы удаляем после подтверждения исхода; outbox cleanup повторяемый.
История/audit30д; tombstones без автоматического expiry. Orphan24ч только после reconcile.
Незавершённый publication или неизвестное состояние offline не является мусором.
Системные ограничения диска могут остановить приём, но не разрешают удалить активный файл.

## Семантические инварианты сверх JSON Schema

- Все identity/fence/message/manifest IDs совпадают с durable назначением и principal.
- Один namespace site/id, уникальны пути/языки/дорожки, размеры bounded и суммируются.
- Manifest sha256 соответствует JCS; file.sha256 относится к реальным байтам.
- Для transcode есть успешный video и master/renditions; каждый referenced path существует.
  Не объявлять качество выше исходного или менять profileVersion/encoderPolicy.
- TRANSCRIPT только для audio-text; SUBTITLE содержит language и согласованный формат;
  не выдавать failed шагу фиктивный файл, успешный шаг имеет соответствующий результат.
- Полная страница grant не даёт права на чужие файлы; GET соответствует source,
  PUT соответствует неизменяемому artifact и попытке. Не смешивать страницы разных fence.
- PUBLISHED возможен только после текущего publication claim и проверки сайта;
  отмена/замена загрузки сайта проверяется до READY в локальной транзакции.
- ReleaseReceipt только у RELEASED и охватывает все внешние попытки. После него
  никакой поздний complete не может возобновить эту задачу.
- Нельзя превращать терминальную задачу в QUEUED через повтор HTTP или удаление истории.

Эти правила должны стать проверками runtime и fault-тестами этапов2–8.
Валидация схем/трасс этапа1 проверяет спецификацию, не доказывает эти свойства живого сервиса.
