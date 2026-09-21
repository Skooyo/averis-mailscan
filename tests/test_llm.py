from __future__ import annotations

import json

from pydantic import BaseModel

from backend.llm import _coerce_to_schema_shape, _parse


class _PageTranscription(BaseModel):
    text: str


class _ResultsBatch(BaseModel):
    results: list[str]


def test_coerce_leaves_already_correct_object_unchanged():
    text = json.dumps({"text": "hello"})
    assert _coerce_to_schema_shape(text, _PageTranscription) == text


def test_coerce_joins_bare_list_of_single_string_field_objects():
    # Live-reproduced against email_513_SI.pdf: the vision model replied with
    # [{"type": "PageTranscript", "text": "..."}] instead of {"text": "..."}.
    text = json.dumps([{"type": "PageTranscript", "text": "PAGE IS SCANNED - NO OCR TEXT LAYER"}])

    coerced = _coerce_to_schema_shape(text, _PageTranscription)

    assert json.loads(coerced) == {"text": "PAGE IS SCANNED - NO OCR TEXT LAYER"}


def test_coerce_joins_multiple_list_items_in_order():
    text = json.dumps([{"text": "first"}, {"text": "second"}])

    coerced = _coerce_to_schema_shape(text, _PageTranscription)

    assert json.loads(coerced) == {"text": "first\n\nsecond"}


def test_coerce_ignores_list_items_missing_the_string_field():
    # Not every item carries "text" -- can't safely join, leave it to fail loudly
    # rather than silently dropping content.
    text = json.dumps([{"text": "first"}, {"other": "second"}])

    assert _coerce_to_schema_shape(text, _PageTranscription) == text


def test_coerce_does_not_touch_multi_property_schemas():
    # Guard: the string-field rescue only applies to a schema with exactly one
    # property, so it never misfires on richer schemas (e.g. Extraction) that
    # happen to have a single string-typed field among several others.
    class _TwoFields(BaseModel):
        text: str
        other: str

    text = json.dumps([{"text": "a", "other": "b"}])

    assert _coerce_to_schema_shape(text, _TwoFields) == text


def test_coerce_still_handles_bare_array_schema_unaffected_by_the_new_branch():
    text = json.dumps(["a", "b", "c"])

    coerced = _coerce_to_schema_shape(text, _ResultsBatch)

    assert json.loads(coerced) == {"results": ["a", "b", "c"]}


def test_parse_recovers_page_transcription_from_malformed_list_response():
    content = json.dumps([{"type": "PageTranscript", "text": "recovered text"}])

    result = _parse(content, _PageTranscription)

    assert result.text == "recovered text"
