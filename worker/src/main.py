"""
worker/src/main.py
------------------
Aquarela.io Worker entry point.

Connects to RabbitMQ and sets up the consumer pipeline.
Full fluid-simulation logic is implemented in Phase 6.
"""

import os
import sys
import logging
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [worker] %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


def main() -> None:
    """Start the worker process and verify environment connectivity."""
    rabbitmq_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
    logger.info("Worker starting. RabbitMQ target: %s", rabbitmq_url)
    logger.info("Worker ready. Waiting for simulation jobs... (Phase 4 will wire RabbitMQ consumers)")

    # Keep-alive loop so the container stays healthy during Phase 0
    while True:
        time.sleep(30)
        logger.info("Worker heartbeat — idle, no jobs yet.")


if __name__ == "__main__":
    main()
