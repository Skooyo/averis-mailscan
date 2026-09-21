"""Thin provider adapter: structured (JSON-schema) completions via Groq.

Every LLM stage calls structured_completion()/astructured_completion() with a
pydantic schema and gets a validated model back. Swap provider/model here only.
"""

import asyncio
import copy
import os
import re
import time
from typing import TypeVar

from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError

load_dotenv()

DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
T = TypeVar("T", bound=BaseModel)

_client = None
_async_client = None


def get_client():
    global _client
    if _client is None:
        from groq import Groq

        _client = Groq(max_retries=2)  # reads GROQ_API_KEY; retries honour retry-after on 429
    return _client


def get_async_client():
    global _async_client
    if _async_client is None:
        from groq import AsyncGroq

        _async_client = AsyncGroq(max_retries=2)
    return _async_client


def strict_schema(model: type[BaseModel]) -> dict:
    """Pydantic JSON schema tightened for Groq strict mode: every object gets
    additionalProperties=false and all properties required."""
    schema = copy.deepcopy(model.model_json_schema())

    def tighten(node):
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"].keys())
            for v in node.values():
                tighten(v)
        elif isinstance(node, list):
            for v in node:
                tighten(v)

    tighten(schema)
    return schema


def _request_kwargs(system: str, user: str, schema: type[BaseModel], model: str) -> dict:
    kwargs = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "strict": True, "schema": strict_schema(schema)},
        },
    }
    if "gpt-oss" in model:
        kwargs["reasoning_effort"] = "low"  # reasoning tokens count against the free-tier TPM/TPD
    return kwargs


def _parse(content: str, schema: type[T]) -> T:
    return schema.model_validate_json(content)


_RETRY_IN_RE = re.compile(r"try again in ([\d.]+)s")
MAX_RATE_LIMIT_WAITS = 30


def _retry_after_seconds(err: Exception) -> float:
    """How long to wait before retrying: Groq's retry-after header, else the 429 message, else 15s
    (also used as a flat backoff for transient connection errors)."""
    headers = getattr(getattr(err, "response", None), "headers", None) or {}
    if headers.get("retry-after"):
        try:
            return float(headers["retry-after"]) + 1
        except ValueError:
            pass
    m = _RETRY_IN_RE.search(str(err))
    return float(m.group(1)) + 1 if m else 15.0


def structured_completion(system: str, user: str, schema: type[T], model: str = DEFAULT_MODEL) -> T:
    from groq import APIConnectionError, RateLimitError

    kwargs = _request_kwargs(system, user, schema, model)
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            resp = get_client().chat.completions.create(**kwargs)
        except (RateLimitError, APIConnectionError) as e:
            waits += 1
            if waits > MAX_RATE_LIMIT_WAITS:
                raise
            time.sleep(_retry_after_seconds(e))
            continue
        try:
            return _parse(resp.choices[0].message.content, schema)
        except ValidationError as e:  # one retry if the model returns invalid JSON
            if last_error is not None:
                raise
            last_error = e


async def astructured_completion(system: str, user: str, schema: type[T], model: str = DEFAULT_MODEL) -> T:
    from groq import APIConnectionError, RateLimitError

    kwargs = _request_kwargs(system, user, schema, model)
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            resp = await get_async_client().chat.completions.create(**kwargs)
        except (RateLimitError, APIConnectionError) as e:
            waits += 1
            if waits > MAX_RATE_LIMIT_WAITS:
                raise
            await asyncio.sleep(_retry_after_seconds(e))
            continue
        try:
            return _parse(resp.choices[0].message.content, schema)
        except ValidationError as e:
            if last_error is not None:
                raise
            last_error = e
