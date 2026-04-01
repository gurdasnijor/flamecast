"""Minimal IBM ACP echo agent for E2E testing.

Echoes back all input messages with an "Echo: " prefix.
Runs on http://localhost:8000 by default.

Usage:
    cd tests/echo-agent
    uv run python server.py
"""

from acp_sdk.models import Message, MessagePart
from acp_sdk.server import Server

server = Server()


@server.agent(
    name="echo",
    description="Echoes back user messages for E2E testing",
)
async def echo(input: list[Message]) -> Message:
    """Echo agent: returns each input message with an 'Echo: ' prefix."""
    parts: list[MessagePart] = []
    for message in input:
        for part in message.parts:
            text = part.content or ""
            parts.append(
                MessagePart(
                    content_type=part.content_type or "text/plain",
                    content=f"Echo: {text}",
                )
            )
    return Message(role="agent", parts=parts)


if __name__ == "__main__":
    server.run(host="0.0.0.0", port=8000, self_registration=False)
