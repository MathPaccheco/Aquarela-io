"""
worker/src/main.py
------------------
Aquarela.io Worker entry point — Phase 6 (Fluid Simulation Engine).

Bootstrap sequence:
  1. Configure structured logging.
  2. Open an asyncpg connection pool to PostgreSQL.
  3. Connect to RabbitMQ via aio-pika with exponential-backoff retry.
  4. Declare the AMQP topology (idempotent).
  5. Initialise a ThreadPoolExecutor for CPU-bound NumPy simulation work.
  6. Register SIGTERM / SIGINT handlers for graceful shutdown.
  7. Start the RabbitMQ consumer loop (runs until a shutdown signal).

Shutdown sequence (SIGTERM / SIGINT):
  - Stop the consumer task.
  - Drain the ThreadPoolExecutor (wait for in-flight simulations to finish).
  - Close the AMQP connection and PostgreSQL pool cleanly.
"""

import asyncio
import logging
import os
import signal
import sys
from concurrent.futures import ThreadPoolExecutor

import asyncpg

from amqp_connection import connect_with_retry, declare_topology
from consumer import start_consumer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [worker] %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql://aquarela:aquarela@postgres:5432/aquarela",
)

#: Number of threads dedicated to CPU-bound NumPy simulation work.
WORKER_THREAD_COUNT: int = int(os.getenv("WORKER_THREAD_COUNT", "4"))


async def main() -> None:
    """
    Main coroutine — initialises all infrastructure and starts the consumer.

    Uses a single asyncio event loop for all I/O (AMQP + PostgreSQL) while
    delegating CPU-bound simulation to a ThreadPoolExecutor, ensuring the
    event loop stays responsive even under heavy simulation load.
    """
    logger.info("Aquarela Worker starting (Phase 6 — Fluid Simulation Engine)…")

    # ── PostgreSQL connection pool ─────────────────────────────────────────────
    logger.info("Connecting to PostgreSQL…")
    pg_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    logger.info("PostgreSQL pool ready.")

    # ── AMQP connection ────────────────────────────────────────────────────────
    amqp_connection = await connect_with_retry()

    # Declare topology on a short-lived channel to avoid holding a channel
    # open longer than necessary during the startup handshake.
    topology_channel = await amqp_connection.channel()
    await declare_topology(topology_channel)
    await topology_channel.close()

    # ── Thread pool for CPU-bound NumPy simulation ─────────────────────────────
    # Naming threads aids profiling and debugging in process monitors.
    executor = ThreadPoolExecutor(
        max_workers=WORKER_THREAD_COUNT,
        thread_name_prefix="fluid-sim",
    )
    logger.info("ThreadPoolExecutor ready (%d worker threads).", WORKER_THREAD_COUNT)

    # ── Graceful shutdown ──────────────────────────────────────────────────────
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _on_shutdown_signal(sig: signal.Signals) -> None:
        """Sets the stop event when a POSIX shutdown signal is received."""
        logger.info("%s received — initiating graceful shutdown…", sig.name)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _on_shutdown_signal, sig)

    # ── Start consumer ─────────────────────────────────────────────────────────
    consumer_task = asyncio.create_task(
        start_consumer(amqp_connection, pg_pool, executor)
    )

    logger.info("Worker ready — consuming fluid simulation jobs.")

    # Block here until a shutdown signal is received.
    await stop_event.wait()

    # ── Shutdown sequence ──────────────────────────────────────────────────────
    logger.info("Stopping consumer loop…")
    consumer_task.cancel()
    try:
        await consumer_task
    except asyncio.CancelledError:
        pass

    # Wait for any in-flight NumPy simulations in the thread pool to finish
    # before closing the AMQP connection so results are not lost.
    logger.info("Draining thread pool executor…")
    executor.shutdown(wait=True)

    await amqp_connection.close()
    await pg_pool.close()
    logger.info("Worker shut down cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
