"""Thin provider adapter: structured (JSON-schema) completions.

Primary provider is the Vercel AI Gateway (the same one
frontend/src/lib/classify.ts uses). Groq is kept as a fallback for when the
Gateway is rate-limited, erroring, or its key is unset/rejected -- set
GROQ_API_KEY to enable it; without it, a Gateway failure just raises as
before. Every LLM stage calls structured_completion()/astructured_completion()
with a pydantic schema and gets a validated model back -- this is the only
file that knows about either provider.
"""

import asyncio
import copy
import json
import os
import re
import sys
import time
from typing import TypeVar

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError

load_dotenv()

# --- Vercel AI Gateway (primary) --------------------------------------------
# https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

GATEWAY_BASE_URL = os.environ.get("AI_GATEWAY_BASE_URL", "https://ai-gateway.vercel.sh/v1")
GATEWAY_MODEL = os.environ.get("AI_GATEWAY_MODEL", "alibaba/qwen3.8-omni-flash")
GATEWAY_MAX_WAITS = 3  # kept short -- the Groq fallback below picks up from here

# --- Groq (fallback only) ----------------------------------------------------

GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_MAX_WAITS = 30  # last resort -- nothing left to fall back to past this

T = TypeVar("T", bound=BaseModel)

# Not every model behind the gateway enforces response_format, so also spell it out in words --
# matches the guard frontend/src/lib/classify.ts uses for the same reason.
FORMAT_HINT = "\n\nReply with only valid JSON matching the response schema -- no markdown code fences, no other text."

_client = None
_async_client = None
_groq_client = None
_groq_async_client = None


class GatewayAuthError(Exception):
    """401/402/403 from the AI Gateway -- bad key, or the account has no credit left. Doesn't fix itself."""


def _gateway_token() -> str | None:
    """The AI Gateway API key, or (when running on Vercel) its OIDC token."""
    return os.environ.get("AI_GATEWAY_API_KEY") or os.environ.get("VERCEL_OIDC_TOKEN")


def gateway_configured() -> bool:
    """Whether a Gateway token is set -- used by backend/ocr_llm.py to decide
    "unavailable" (skip straight to LLMOCRUnavailable, no image rendering)
    vs. "configured but the call itself failed" (a real error worth
    surfacing), same distinction backend/ocr.py draws for Document AI."""
    return bool(_gateway_token())


def _groq_enabled() -> bool:
    return bool(os.environ.get("GROQ_API_KEY"))


def get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(base_url=GATEWAY_BASE_URL, timeout=60.0)
    return _client


def get_async_client() -> httpx.AsyncClient:
    global _async_client
    if _async_client is None:
        _async_client = httpx.AsyncClient(base_url=GATEWAY_BASE_URL, timeout=60.0)
    return _async_client


def get_groq_client():
    global _groq_client
    if _groq_client is None:
        from groq import Groq

        _groq_client = Groq(max_retries=2)  # reads GROQ_API_KEY
    return _groq_client


def get_groq_async_client():
    global _groq_async_client
    if _groq_async_client is None:
        from groq import AsyncGroq

        _groq_async_client = AsyncGroq(max_retries=2)
    return _groq_async_client


def strict_schema(model: type[BaseModel]) -> dict:
    """Pydantic JSON schema tightened for structured-output mode: every object gets
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


# --- response parsing (shared by both providers) -----------------------------

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _unfence(text: str) -> str:
    """Some models wrap JSON in a Markdown code fence even when asked not to."""
    return _FENCE_RE.sub("", text.strip())


def _coerce_to_schema_shape(text: str, schema: type[BaseModel]) -> str:
    """Some models return a bare array (or wrap it under an unexpected key) even when the
    schema asks for a single-array-field object, e.g. {"results": [...]}. If schema is
    exactly one object with one array-typed property, adapt a bare list -- or an object
    holding exactly one list -- into that shape. Returns text unchanged if it doesn't apply.

    Mirror case, added after backend/ocr_llm.py's vision transcription call (schema
    {"text": str}) live-reproduced it against email_513_SI.pdf: a schema with exactly one
    *string*-typed property, but the model wraps its answer in a bare list of objects (each
    carrying that field, plus whatever extra keys it invented, e.g.
    [{"type": "PageTranscript", "text": "..."}]) instead of a single object. Join every list
    item's value for that field, in order.
    """
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text

    properties = schema.model_json_schema().get("properties", {})

    array_fields = [k for k, v in properties.items() if v.get("type") == "array"]
    if len(array_fields) == 1:
        field = array_fields[0]
        if isinstance(data, list):
            return json.dumps({field: data})
        if isinstance(data, dict) and field not in data:
            list_items = [v for v in data.values() if isinstance(v, list)]
            if len(list_items) == 1:
                return json.dumps({field: list_items[0]})
        return text

    string_fields = [k for k, v in properties.items() if v.get("type") == "string"]
    if len(properties) == 1 and len(string_fields) == 1 and isinstance(data, list):
        field = string_fields[0]
        parts = [item[field] for item in data if isinstance(item, dict) and isinstance(item.get(field), str)]
        if len(parts) == len(data) and parts:
            return json.dumps({field: "\n\n".join(parts)})

    return text


def _parse(content: str, schema: type[T]) -> T:
    unfenced = _unfence(content)
    coerced = _coerce_to_schema_shape(unfenced, schema)
    last_error: ValidationError | None = None
    for candidate in dict.fromkeys([content, unfenced, coerced]):  # dedup, keep order
        try:
            return schema.model_validate_json(candidate)
        except ValidationError as e:
            last_error = e
    assert last_error is not None
    raise last_error


# --- Vercel AI Gateway calls --------------------------------------------------

_RETRY_IN_RE = re.compile(r"try again in ([\d.]+)s")


def _gateway_request_body(system: str, user: str, schema: type[BaseModel], model: str) -> dict:
    return {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system + FORMAT_HINT},
            {"role": "user", "content": user},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": strict_schema(schema)},
        },
    }


def _gateway_content(response: httpx.Response) -> str:
    return response.json()["choices"][0]["message"]["content"]


def _gateway_retry_after_seconds(response: httpx.Response) -> float:
    """How long to wait before retrying: the gateway's retry-after header, else a
    "try again in Ns" in the body, else 15s (also used as a flat backoff for 5xxs)."""
    header = response.headers.get("retry-after")
    if header:
        try:
            return float(header) + 1
        except ValueError:
            pass
    m = _RETRY_IN_RE.search(response.text)
    return float(m.group(1)) + 1 if m else 15.0


def _check_gateway_auth(response: httpx.Response) -> None:
    if response.status_code in (401, 402, 403):
        raise GatewayAuthError(
            f"AI Gateway refused the request ({response.status_code}): "
            "check AI_GATEWAY_API_KEY and the account's credit"
        )


def _gateway_structured_completion(system: str, user: str, schema: type[T], model: str) -> T:
    token = _gateway_token()
    if not token:
        raise GatewayAuthError("AI_GATEWAY_API_KEY is not set")

    body = _gateway_request_body(system, user, schema, model)
    headers = {"Authorization": f"Bearer {token}"}
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            response = get_client().post("/chat/completions", json=body, headers=headers)
        except httpx.TransportError:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                raise
            time.sleep(5.0)
            continue
        _check_gateway_auth(response)  # unretryable -- raises straight out, caller may fall back
        if response.status_code == 429 or response.status_code >= 500:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                response.raise_for_status()
            time.sleep(_gateway_retry_after_seconds(response))
            continue
        response.raise_for_status()
        try:
            return _parse(_gateway_content(response), schema)
        except ValidationError as e:  # one retry if the model returns invalid JSON
            if last_error is not None:
                raise
            last_error = e


async def _gateway_astructured_completion(system: str, user: str, schema: type[T], model: str) -> T:
    token = _gateway_token()
    if not token:
        raise GatewayAuthError("AI_GATEWAY_API_KEY is not set")

    body = _gateway_request_body(system, user, schema, model)
    headers = {"Authorization": f"Bearer {token}"}
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            response = await get_async_client().post("/chat/completions", json=body, headers=headers)
        except httpx.TransportError:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                raise
            await asyncio.sleep(5.0)
            continue
        _check_gateway_auth(response)
        if response.status_code == 429 or response.status_code >= 500:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                response.raise_for_status()
            await asyncio.sleep(_gateway_retry_after_seconds(response))
            continue
        response.raise_for_status()
        try:
            return _parse(_gateway_content(response), schema)
        except ValidationError as e:
            if last_error is not None:
                raise
            last_error = e


# --- Vercel AI Gateway, vision (last-resort OCR fallback only) --------------
# Used only by backend/ocr_llm.py, itself only reached after Document AI OCR
# (backend/ocr.py) has already been tried and either isn't configured or
# failed -- see readers.py::_read_pdf for the exact order. No Groq fallback:
# GROQ_MODEL (openai/gpt-oss-120b) isn't vision-capable, and every caller
# here is already a last resort, so there's nothing left to fall back to.


def vision_structured_completion(
    system: str, user: str, image_b64_png: str, schema: type[T], model: str | None = None
) -> T:
    """Like _gateway_structured_completion, but the user message also carries
    one base64-encoded PNG image (OpenAI-compatible `image_url` content
    part). Raises GatewayAuthError if no token is configured -- callers that
    want "unavailable" treated differently from "configured but failed"
    should check gateway_configured() first, the way backend/ocr_llm.py
    does, rather than relying on exception type alone."""
    token = _gateway_token()
    if not token:
        raise GatewayAuthError("AI_GATEWAY_API_KEY is not set")

    body = {
        "model": model or GATEWAY_MODEL,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system + FORMAT_HINT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64_png}"}},
                ],
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": strict_schema(schema)},
        },
    }
    headers = {"Authorization": f"Bearer {token}"}
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            response = get_client().post("/chat/completions", json=body, headers=headers)
        except httpx.TransportError:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                raise
            time.sleep(5.0)
            continue
        _check_gateway_auth(response)
        if response.status_code == 429 or response.status_code >= 500:
            waits += 1
            if waits > GATEWAY_MAX_WAITS:
                response.raise_for_status()
            time.sleep(_gateway_retry_after_seconds(response))
            continue
        response.raise_for_status()
        try:
            return _parse(_gateway_content(response), schema)
        except ValidationError as e:
            if last_error is not None:
                raise
            last_error = e


# --- Groq calls (fallback only) ----------------------------------------------


def _groq_request_kwargs(system: str, user: str, schema: type[BaseModel], model: str) -> dict:
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


def _groq_retry_after_seconds(err: Exception) -> float:
    headers = getattr(getattr(err, "response", None), "headers", None) or {}
    if headers.get("retry-after"):
        try:
            return float(headers["retry-after"]) + 1
        except ValueError:
            pass
    m = _RETRY_IN_RE.search(str(err))
    return float(m.group(1)) + 1 if m else 15.0


def _groq_structured_completion(system: str, user: str, schema: type[T], model: str) -> T:
    from groq import APIConnectionError, RateLimitError

    kwargs = _groq_request_kwargs(system, user, schema, model)
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            resp = get_groq_client().chat.completions.create(**kwargs)
        except (RateLimitError, APIConnectionError) as e:
            waits += 1
            if waits > GROQ_MAX_WAITS:
                raise
            time.sleep(_groq_retry_after_seconds(e))
            continue
        try:
            return _parse(resp.choices[0].message.content, schema)
        except ValidationError as e:
            if last_error is not None:
                raise
            last_error = e


async def _groq_astructured_completion(system: str, user: str, schema: type[T], model: str) -> T:
    from groq import APIConnectionError, RateLimitError

    kwargs = _groq_request_kwargs(system, user, schema, model)
    last_error: Exception | None = None
    waits = 0
    while True:
        try:
            resp = await get_groq_async_client().chat.completions.create(**kwargs)
        except (RateLimitError, APIConnectionError) as e:
            waits += 1
            if waits > GROQ_MAX_WAITS:
                raise
            await asyncio.sleep(_groq_retry_after_seconds(e))
            continue
        try:
            return _parse(resp.choices[0].message.content, schema)
        except ValidationError as e:
            if last_error is not None:
                raise
            last_error = e


# --- public entry points: Gateway first, Groq on failure --------------------


def structured_completion(system: str, user: str, schema: type[T], model: str | None = None) -> T:
    gateway_error: Exception | None = None
    if _gateway_token():
        try:
            return _gateway_structured_completion(system, user, schema, model or GATEWAY_MODEL)
        except Exception as e:
            if not _groq_enabled():
                raise
            print(f"[llm] AI Gateway failed ({e!r}); falling back to Groq", file=sys.stderr)
            gateway_error = e
    elif not _groq_enabled():
        raise GatewayAuthError("Neither AI_GATEWAY_API_KEY nor GROQ_API_KEY is set")

    try:
        return _groq_structured_completion(system, user, schema, model or GROQ_MODEL)
    except Exception as groq_error:
        raise groq_error from gateway_error


async def astructured_completion(system: str, user: str, schema: type[T], model: str | None = None) -> T:
    gateway_error: Exception | None = None
    if _gateway_token():
        try:
            return await _gateway_astructured_completion(system, user, schema, model or GATEWAY_MODEL)
        except Exception as e:
            if not _groq_enabled():
                raise
            print(f"[llm] AI Gateway failed ({e!r}); falling back to Groq", file=sys.stderr)
            gateway_error = e
    elif not _groq_enabled():
        raise GatewayAuthError("Neither AI_GATEWAY_API_KEY nor GROQ_API_KEY is set")

    try:
        return await _groq_astructured_completion(system, user, schema, model or GROQ_MODEL)
    except Exception as groq_error:
        raise groq_error from gateway_error
