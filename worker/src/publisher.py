"""
worker/src/publisher.py
------------------------
Publishes fluid simulation results to the ``simulation_results`` AMQP queue.

Each result message contains only the pixels that changed during the simulation
(diff approach), keeping message sizes small even for heavily painted chunks.
The Gateway consumes this queue and rebroadcasts the pixels to all WebSocket
clients in the room as a ``pixel_update`` event.

Responsibilities (SRP):
  - Serialise the simulation result into the expected JSON schema.
  - Publish the message with ``PERSISTENT`` delivery mode.
  - Skip publish when there are no changed pixels (no-op optimisation).
"""

import json
import logging

import aio_pika

from amqp_connection import EXCHANGE_NAME, RESULTS_QUEUE_NAME

logger = logging.getLogger(__name__)


async def publish_simulation_result(
    channel: aio_pika.abc.AbstractChannel,
    room_id: str,
    chunk_id: str,
    pixels: list[dict],
) -> None:
    """
    Publishes a ``simulation_results`` message to RabbitMQ.

    Skips publishing when ``pixels`` is empty to avoid triggering unnecessary
    WebSocket broadcasts and frontend repaints for unchanged chunks.

    The payload schema matches what ``simulationResultsConsumer.js`` on the
    Gateway side expects:

    .. code-block:: json

        {
          "roomId": "sala-principal",
          "chunkId": "2_3",
          "pixels": [
            { "x": 45, "y": 12, "r": 18, "g": 10, "b": 143, "a": 200 }
          ]
        }

    :param channel: An open aio_pika channel with topology already declared.
    :param room_id: Room the result belongs to.
    :param chunk_id: Chunk the pixels originated from.
    :param pixels: List of ``ChangedPixel`` dicts (canvas-absolute coordinates).
    """
    if not pixels:
        logger.debug(
            "No changed pixels for room=%s chunk=%s — skipping publish.",
            room_id, chunk_id,
        )
        return

    payload = {
        "roomId": room_id,
        "chunkId": chunk_id,
        "pixels": pixels,
    }

    exchange = await channel.get_exchange(EXCHANGE_NAME)
    message = aio_pika.Message(
        body=json.dumps(payload).encode(),
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        content_type="application/json",
    )

    await exchange.publish(message, routing_key=RESULTS_QUEUE_NAME)

    logger.info(
        "Published simulation_result: room=%s chunk=%s pixels=%d.",
        room_id, chunk_id, len(pixels),
    )
