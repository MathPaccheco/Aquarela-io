"""
worker/src/amqp_connection.py
------------------------------
Manages the aio-pika AMQP connection lifecycle for the Worker.

Responsibilities:
  - Open a robust aio-pika connection with exponential-backoff retry.
  - Declare the AMQP exchange, queues, and DLQ bindings used by the Worker.
  - Expose ``connect_with_retry`` and ``declare_topology`` coroutines
    consumed by ``main.py``.

AMQP topology (declared on both Gateway and Worker for idempotency):

  Exchange : aquarela_events (direct, durable)
  Queue    : fluid_simulation_jobs        — Worker consumes
  Queue    : fluid_simulation_jobs.dlq    — dead letters from failed jobs
  Queue    : simulation_results           — Worker publishes, Gateway consumes
"""

import asyncio
import logging
import os

import aio_pika

logger = logging.getLogger(__name__)

RABBITMQ_URL: str = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")

EXCHANGE_NAME: str = "aquarela_events"
JOB_QUEUE_NAME: str = "fluid_simulation_jobs"
DLQ_NAME: str = "fluid_simulation_jobs.dlq"
RESULTS_QUEUE_NAME: str = "simulation_results"

#: Maximum number of connection attempts before the worker aborts.
MAX_RETRY_ATTEMPTS: int = int(os.getenv("AMQP_MAX_RETRIES", "10"))

#: Base delay in seconds for the first retry (doubles on each failure).
BASE_RETRY_DELAY_S: float = float(os.getenv("AMQP_BASE_RETRY_DELAY_S", "2.0"))


async def connect_with_retry() -> aio_pika.abc.AbstractRobustConnection:
    """
    Establishes a robust AMQP connection with exponential-backoff retry.

    Uses ``aio_pika.connect_robust`` which handles reconnection transparently
    after the initial connection is established.  The outer retry loop covers
    the startup race where the Worker container starts before RabbitMQ is
    healthy.

    :returns: An open ``aio_pika.RobustConnection`` instance.
    :raises RuntimeError: If all retry attempts are exhausted without success.
    """
    delay = BASE_RETRY_DELAY_S

    for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
        try:
            connection = await aio_pika.connect_robust(RABBITMQ_URL)
            logger.info("Connected to RabbitMQ (attempt %d).", attempt)
            return connection
        except Exception as exc:
            logger.warning(
                "RabbitMQ connection attempt %d/%d failed: %s. Retrying in %.1fs…",
                attempt, MAX_RETRY_ATTEMPTS, exc, delay,
            )
            if attempt == MAX_RETRY_ATTEMPTS:
                raise RuntimeError(
                    f"Could not connect to RabbitMQ after {MAX_RETRY_ATTEMPTS} attempts."
                ) from exc
            await asyncio.sleep(delay)
            # Exponential backoff capped at 60 s.
            delay = min(delay * 2, 60.0)

    # Unreachable — loop always raises or returns before here.
    raise RuntimeError("AMQP connection loop exited unexpectedly.")  # pragma: no cover


async def declare_topology(channel: aio_pika.abc.AbstractChannel) -> None:
    """
    Idempotently declares the AMQP exchange, queues, and DLQ bindings.

    All entities are durable so they survive a RabbitMQ broker restart.
    Calling this function multiple times or from multiple services is safe
    — amqp ``declare`` is an idempotent operation when attributes match.

    :param channel: An open aio_pika channel.
    """
    exchange = await channel.declare_exchange(
        EXCHANGE_NAME,
        aio_pika.ExchangeType.DIRECT,
        durable=True,
    )

    # Dead-letter queue: receives messages nack'd by the Worker.
    dlq = await channel.declare_queue(DLQ_NAME, durable=True)
    await dlq.bind(exchange, routing_key=DLQ_NAME)

    # Main jobs queue: failed messages are dead-lettered instead of
    # re-queued indefinitely, preventing runaway retry amplification.
    job_queue = await channel.declare_queue(
        JOB_QUEUE_NAME,
        durable=True,
        arguments={
            "x-dead-letter-exchange": EXCHANGE_NAME,
            "x-dead-letter-routing-key": DLQ_NAME,
        },
    )
    await job_queue.bind(exchange, routing_key=JOB_QUEUE_NAME)

    # Results queue: Worker publishes here; Gateway consumes.
    results_queue = await channel.declare_queue(RESULTS_QUEUE_NAME, durable=True)
    await results_queue.bind(exchange, routing_key=RESULTS_QUEUE_NAME)

    logger.info(
        "AMQP topology declared: exchange=%s, queues=%s, %s, %s.",
        EXCHANGE_NAME, JOB_QUEUE_NAME, DLQ_NAME, RESULTS_QUEUE_NAME,
    )
