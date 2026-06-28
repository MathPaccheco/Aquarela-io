"""
worker/src/consumer.py
-----------------------
Asynchronous RabbitMQ consumer for fluid simulation jobs.

Each incoming ``fluid_simulation_jobs`` message is deserialized and dispatched
through the full simulation pipeline.  The CPU-bound NumPy work runs in a
``ThreadPoolExecutor`` so it never blocks the asyncio event loop.

Concurrency design:
  - ``asyncio.Semaphore(MAX_CONCURRENT_CHUNKS)`` limits the number of chunks
    processed simultaneously, providing back-pressure and preventing OOM
    when many large-chunk jobs arrive in a burst.
  - RabbitMQ QoS prefetch is set to ``MAX_CONCURRENT_CHUNKS`` so the broker
    only delivers as many unacknowledged messages as the Worker can handle.
  - Failed messages are nack'd with ``requeue=False`` so they fall into the
    dead-letter queue (DLQ) instead of cycling indefinitely.

Responsibilities (SRP):
  - Listen on ``fluid_simulation_jobs``.
  - Deserialise the job payload and validate required fields.
  - Coordinate grid initialisation (async DB read) and simulation (sync CPU).
  - Publish results and acknowledge / nack messages.
"""

import asyncio
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import aio_pika
import asyncpg

from amqp_connection import JOB_QUEUE_NAME
from chunk_processor import (
    get_or_init_chunk_grid,
    preload_neighbor_grids,
    process_job_sync,
)
from publisher import publish_simulation_result

logger = logging.getLogger(__name__)

#: Maximum number of chunks processed concurrently.
MAX_CONCURRENT_CHUNKS: int = int(os.getenv("MAX_CONCURRENT_CHUNKS", "4"))


async def _handle_job(
    message: aio_pika.abc.AbstractIncomingMessage,
    channel: aio_pika.abc.AbstractChannel,
    pg_pool: asyncpg.Pool,
    executor: ThreadPoolExecutor,
    semaphore: asyncio.Semaphore,
) -> None:
    """
    Processes a single simulation job message end-to-end.

    Uses ``message.process(requeue=False)`` as an async context manager which
    automatically nacks the message (sending it to the DLQ) if any exception
    propagates out of the block, and acks it on clean exit.

    Steps:
      1. Acquire the concurrency semaphore to bound simultaneous processing.
      2. Deserialise and validate the job payload.
      3. Fetch or initialise the in-memory chunk grid (async, may hit DB).
      4. Run the CPU-bound simulation in the thread executor (non-blocking).
      5. Publish changed pixels to ``simulation_results``.

    :param message: The incoming AMQP message from ``fluid_simulation_jobs``.
    :param channel: The aio_pika channel used for publishing results.
    :param pg_pool: Asyncpg connection pool for DB access on cache miss.
    :param executor: ``ThreadPoolExecutor`` for CPU-bound NumPy simulation.
    :param semaphore: Concurrency limiter shared across all in-flight jobs.
    """
    async with semaphore:
        async with message.process(requeue=False):
            try:
                job = json.loads(message.body.decode())
                room_id: str = job["roomId"]
                chunk_id: str = job["chunkId"]
                strokes: list[dict] = job.get("strokes", [])
            except (json.JSONDecodeError, KeyError, UnicodeDecodeError) as exc:
                # Malformed payload — nack'd by the context manager; goes to DLQ.
                logger.error("Malformed simulation job — dropping: %s", exc)
                return

            logger.info(
                "Processing job: room=%s chunk=%s strokes=%d.",
                room_id, chunk_id, len(strokes),
            )

            # Async DB access (if cache miss) — safe to await on the event loop.
            grid = await get_or_init_chunk_grid(room_id, chunk_id, pg_pool)

            # When the stroke footprint is close to chunk borders, preload
            # immediate neighbors so cross-chunk diffusion runs with a complete
            # local boundary state instead of transparent placeholders.
            await preload_neighbor_grids(room_id, chunk_id, strokes, pg_pool)

            # Offload CPU-bound NumPy simulation to a thread so the event loop
            # remains responsive to other incoming jobs during diffusion.
            # Rationale: run_in_executor releases the GIL for numpy operations,
            # allowing true parallelism across the thread pool.
            loop = asyncio.get_running_loop()
            changed_pixels = await loop.run_in_executor(
                executor,
                process_job_sync,
                room_id,
                chunk_id,
                strokes,
                grid,
            )

            await publish_simulation_result(channel, room_id, chunk_id, changed_pixels)


async def start_consumer(
    connection: aio_pika.abc.AbstractRobustConnection,
    pg_pool: asyncpg.Pool,
    executor: ThreadPoolExecutor,
) -> None:
    """
    Opens a dedicated channel, configures QoS prefetch, and starts the
    message consumption loop.

    QoS prefetch is set to ``MAX_CONCURRENT_CHUNKS`` so RabbitMQ delivers
    only as many unacknowledged messages as the Worker can handle concurrently.
    This provides natural back-pressure without complex custom throttling.

    Each message is handled as a separate ``asyncio.Task`` so multiple jobs
    can be in-flight simultaneously up to the semaphore limit.

    :param connection: An open aio_pika robust connection.
    :param pg_pool: Asyncpg connection pool for DB access on grid cache miss.
    :param executor: ``ThreadPoolExecutor`` for CPU-bound simulation work.
    """
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=MAX_CONCURRENT_CHUNKS)

    queue = await channel.get_queue(JOB_QUEUE_NAME)
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_CHUNKS)

    logger.info("Worker listening on queue '%s'…", JOB_QUEUE_NAME)

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            # Fire each job as a Task so the iterator can immediately accept
            # the next message up to the QoS prefetch limit.
            asyncio.create_task(
                _handle_job(message, channel, pg_pool, executor, semaphore)
            )
