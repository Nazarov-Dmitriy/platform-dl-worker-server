# Local Test Guide: Generation Queue

The queue lives on the dispatcher. An installed model stays in `/generation/models` while a generation is running. A new job is accepted as `QUEUED` and is offered only after that device has a free slot and no open generation assignment. The processor still refuses a second generation if one is already running.

## Checks

1. Submit a generation and wait until it is `RUNNING`.
2. The model is still returned by `GET /api/v2/site/generation/models`.
3. A second job is accepted as `QUEUED`, not `MODEL_UNAVAILABLE`, and stays `QUEUED` while the first runs.
4. Cancelling the queued job returns `CANCELLED` and does not stop the running one.
5. After the first job finishes, the dispatcher offers the next queued job. It becomes `RUNNING`, then `SUCCEEDED`.

`scripts/test-generation-queue.sh` and `scripts/test-generation-queue.bat` follow this sequence against a local dispatcher.
