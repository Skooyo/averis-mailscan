import sys
import types

import pytest

from backend.comparison import (
    NO_MISMATCH_MESSAGE,
    compare_documents,
    compare_documents_with_fallback,
    containers_equal,
    flatten_extraction,
    normalize_company_name,
    normalize_port,
    normalize_text,
    parse_container_expression,
    parse_weight_kg,
    ports_equal,
    weights_equal,
)
from backend.extract import Extraction, ExtractedField


# ---------------------------------------------------------------------------
# normalize_text
# ---------------------------------------------------------------------------

def test_normalize_text_case_and_whitespace():
    assert normalize_text("  Singapore   Port ") == "singapore port"


def test_normalize_text_punctuation():
    assert normalize_text("Acme, Pte. Ltd.") == "acme pte ltd"


def test_normalize_text_none_returns_empty_string():
    assert normalize_text(None) == ""


# ---------------------------------------------------------------------------
# normalize_company_name (suffixes)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "a,b",
    [
        ("ACME PTE LTD", "Acme Pte. Ltd."),
        ("Acme Ltd", "ACME LIMITED"),
        ("Acme Inc.", "acme inc"),
        ("Acme Sdn Bhd", "ACME SENDIRIAN BERHAD"),
        ("Acme Corp", "Acme Corporation"),
        ("Acme GmbH", "acme gmbh"),
    ],
)
def test_normalize_company_name_suffix_equivalence(a, b):
    assert normalize_company_name(a) == normalize_company_name(b)


def test_normalize_company_name_different_companies_do_not_match():
    assert normalize_company_name("Acme Pte Ltd") != normalize_company_name(
        "Globex Pte Ltd"
    )


# ---------------------------------------------------------------------------
# normalize_port
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "a,b",
    [
        ("Port of Singapore", "Singapore"),
        ("SG", "Singapore"),
        ("Port Klang", "Pelabuhan Klang"),
        ("HK", "Hong Kong"),
        ("Hongkong", "Hong Kong"),
    ],
)
def test_normalize_port_equivalence(a, b):
    assert normalize_port(a) == normalize_port(b)


def test_normalize_port_different_ports_do_not_match():
    assert normalize_port("Singapore") != normalize_port("Shanghai")


# ---------------------------------------------------------------------------
# ports_equal (UN/LOCODE-aware port comparison)
# ---------------------------------------------------------------------------

def test_ports_equal_matches_on_code_despite_spelling_difference():
    # Real case from the dataset: same city, spelled two different ways,
    # but both sides carry the same bracketed code.
    assert ports_equal(
        "Ho Chi Minh City, Vietnam (VNSGN)",
        "HOCHIMINH CITY, VIETNAM (VNSGN)",
    ) is True


def test_ports_equal_flags_code_mismatch_even_with_similar_text():
    assert ports_equal(
        "Ho Chi Minh City, Vietnam (VNSGN)",
        "Ho Chi Minh City, Vietnam (GNCKY)",
    ) is False


def test_ports_equal_falls_back_to_text_when_code_missing_on_either_side():
    assert ports_equal("Singapore (SGSIN)", "Singapore") is True
    assert ports_equal("Port of Singapore", "SG") is True


def test_ports_equal_falls_back_to_text_for_different_ports_without_codes():
    assert ports_equal("Singapore", "Shanghai") is False


# ---------------------------------------------------------------------------
# container expressions
# ---------------------------------------------------------------------------

def test_parse_container_expression_basic():
    items = parse_container_expression("3 x 40HC")
    assert items == [type(items[0])(count=3, size="40", type="HC")]


@pytest.mark.parametrize(
    "a,b",
    [
        ("3 x 40HC", "3X40'HC"),
        ("3 x 40HC", "03 X 40 HC"),
        ("1 x 20GP", "1 x 20' GP"),
        ("2 x 40GP + 1 x 40HC", "1 X 40HC + 2X40GP"),
    ],
)
def test_containers_equal_equivalent_forms(a, b):
    assert containers_equal(a, b) is True


def test_containers_equal_different_counts():
    assert containers_equal("3 x 40HC", "2 x 40HC") is False


def test_containers_equal_different_types():
    assert containers_equal("3 x 40HC", "3 x 40GP") is False


def test_containers_equal_plain_number_fallback():
    assert containers_equal("3", "3 containers") is True
    assert containers_equal("3", "4 containers") is False


# ---------------------------------------------------------------------------
# weight units
# ---------------------------------------------------------------------------

def test_parse_weight_kg_defaults_to_kg():
    assert parse_weight_kg("12500") == 12500.0


@pytest.mark.parametrize(
    "value,expected_kg",
    [
        ("12500 kg", 12500.0),
        ("12,500 KGS", 12500.0),
        ("12.5 MT", 12500.0),
        ("12.5 tonnes", 12500.0),
        ("12.5 metric tons", 12500.0),
        ("27558 lb", 12500.03),
    ],
)
def test_parse_weight_kg_units(value, expected_kg):
    assert parse_weight_kg(value) == pytest.approx(expected_kg, abs=0.1)


def test_weights_equal_across_units():
    assert weights_equal("12.5 MT", "12500 kg") is True
    assert weights_equal("12.5 MT", "12500 KGS") is True


def test_weights_equal_respects_tolerance():
    assert weights_equal("12500 kg", "12500.4 kg") is True
    assert weights_equal("12500 kg", "13000 kg") is False


def test_weights_equal_unparsable_falls_back_to_text():
    assert weights_equal("n/a", "N/A") is True
    assert weights_equal("n/a", "unknown") is False


# ---------------------------------------------------------------------------
# compare_documents (end to end)
# ---------------------------------------------------------------------------

def _matching_docs():
    si = {
        "shipper": "Acme Pte. Ltd.",
        "consignee": "Globex Corporation",
        "notify_party": "Initech LLC",
        "port_of_loading": "Port of Singapore",
        "port_of_discharge": "Port Klang",
        "container_count": "3 x 40HC",
        "gross_weight_kg": "12.5 MT",
    }
    bl = {
        "shipper": "ACME PTE LTD",
        "consignee": "Globex Corp",
        "notify_party": "Initech, L.L.C.",
        "port_of_loading": "Singapore",
        "port_of_discharge": "Pelabuhan Klang",
        "container_count": "3X40'HC",
        "gross_weight_kg": "12,500 kg",
    }
    return si, bl


def test_compare_documents_all_match_returns_no_mismatch_message():
    si, bl = _matching_docs()
    result = compare_documents(si, bl)
    assert result.status == "match"
    assert result.message == NO_MISMATCH_MESSAGE
    assert result.incorrect_or_missing == []
    assert result.details == {}


def test_compare_documents_flags_real_mismatch():
    si, bl = _matching_docs()
    bl["port_of_discharge"] = "Shanghai"
    bl["gross_weight_kg"] = "9 MT"

    result = compare_documents(si, bl)

    assert result.status == "mismatch"
    assert set(result.incorrect_or_missing) == {"port_of_discharge", "gross_weight_kg"}
    assert result.details["port_of_discharge"].si == "Port Klang"
    assert result.details["port_of_discharge"].bl == "Shanghai"


def test_compare_documents_port_spelling_difference_does_not_false_flag_when_codes_match():
    si, bl = _matching_docs()
    si["port_of_discharge"] = "Ho Chi Minh City, Vietnam (VNSGN)"
    bl["port_of_discharge"] = "HOCHIMINH CITY, VIETNAM (VNSGN)"

    result = compare_documents(si, bl)

    assert result.status == "match"


def test_compare_documents_missing_field_is_a_mismatch():
    si, bl = _matching_docs()
    bl["notify_party"] = ""
    result = compare_documents(si, bl)
    assert "notify_party" in result.incorrect_or_missing


def test_compare_documents_both_missing_is_not_a_mismatch():
    si, bl = _matching_docs()
    si["notify_party"] = ""
    bl["notify_party"] = ""
    result = compare_documents(si, bl)
    assert "notify_party" not in result.incorrect_or_missing


# ---------------------------------------------------------------------------
# flatten_extraction (the extract.py -> compare.py adapter)
# ---------------------------------------------------------------------------

def _extraction(**overrides) -> Extraction:
    base = dict(
        doc_type_detected="SI",
        shipper=ExtractedField(value="ACME PTE LTD", confidence=0.9, evidence="e"),
        consignee=ExtractedField(value="Globex Corp", confidence=0.9, evidence="e"),
        notify_party=ExtractedField(value=None, confidence=0.0, evidence=None),
        port_of_loading=ExtractedField(value="Singapore", confidence=0.9, evidence="e"),
        port_of_discharge=ExtractedField(value="Port Klang", confidence=0.9, evidence="e"),
        container_count=ExtractedField(value="3", confidence=0.9, evidence="e"),
        gross_weight_kg=ExtractedField(value="12500", confidence=0.9, evidence="e"),
    )
    base.update(overrides)
    return Extraction(**base)


def test_flatten_extraction_unwraps_values():
    flat = flatten_extraction(_extraction())
    assert flat == {
        "shipper": "ACME PTE LTD",
        "consignee": "Globex Corp",
        "notify_party": None,
        "port_of_loading": "Singapore",
        "port_of_discharge": "Port Klang",
        "container_count": "3",
        "gross_weight_kg": "12500",
    }


def test_flatten_extraction_accepts_model_dump_dict_too():
    flat_from_model = flatten_extraction(_extraction())
    flat_from_dict = flatten_extraction(_extraction().model_dump())
    assert flat_from_model == flat_from_dict


def test_flatten_extraction_confidence_threshold_masks_low_confidence_values():
    extraction = _extraction(
        shipper=ExtractedField(value="maybe acme?", confidence=0.2, evidence="e")
    )
    flat = flatten_extraction(extraction, confidence_threshold=0.5)
    assert flat["shipper"] is None  # masked: below threshold
    flat_unfiltered = flatten_extraction(extraction, confidence_threshold=0.0)
    assert flat_unfiltered["shipper"] == "maybe acme?"  # default keeps it


def test_flatten_extraction_feeds_compare_documents_correctly():
    # This is the regression test for the bug: comparing two Extractions
    # for the SAME company written differently must resolve to a match,
    # not a mismatch caused by comparing stringified ExtractedField dicts.
    si = _extraction(shipper=ExtractedField(value="ACME PTE LTD", confidence=0.9, evidence="e"))
    bl = _extraction(shipper=ExtractedField(value="Acme Pte. Ltd.", confidence=0.9, evidence="e"))

    result = compare_documents(flatten_extraction(si), flatten_extraction(bl))

    assert result.status == "match"
    assert result.message == NO_MISMATCH_MESSAGE


# ---------------------------------------------------------------------------
# LLM fallback wiring (backend.comparison is stubbed, never hits network)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fallback_not_invoked_when_deterministic_match(monkeypatch):
    si, bl = _matching_docs()

    async def _should_not_be_called(*_args, **_kwargs):
        raise AssertionError("LLM fallback should not run when already a match")

    stub = types.ModuleType("backend.comparison")
    stub.compare_jsons = _should_not_be_called
    monkeypatch.setitem(sys.modules, "backend.comparison", stub)

    result = await compare_documents_with_fallback(si, bl, use_llm_fallback=True)
    assert result["status"] == "match"
    assert result["message"] == NO_MISMATCH_MESSAGE


@pytest.mark.asyncio
async def test_fallback_can_resolve_a_flagged_field(monkeypatch):
    si, bl = _matching_docs()
    # A wording difference the deterministic normalizer doesn't cover.
    si["notify_party"] = "same as consignee"
    bl["notify_party"] = "As per consignee"

    async def _fake_compare_jsons(json_a, json_b):
        return {"status": "match", "incorrect_or_missing": [], "details": {}}

    stub = types.ModuleType("backend.comparison")
    stub.compare_jsons = _fake_compare_jsons
    monkeypatch.setitem(sys.modules, "backend.comparison", stub)

    result = await compare_documents_with_fallback(si, bl, use_llm_fallback=True)
    assert result["status"] == "match"
    assert result["message"] == NO_MISMATCH_MESSAGE


@pytest.mark.asyncio
async def test_fallback_keeps_mismatch_when_llm_agrees(monkeypatch):
    si, bl = _matching_docs()
    bl["port_of_discharge"] = "Shanghai"

    async def _fake_compare_jsons(json_a, json_b):
        return {
            "status": "mismatch",
            "incorrect_or_missing": ["port_of_discharge"],
            "details": {
                "port_of_discharge": {"left": "Port Klang", "right": "Shanghai"}
            },
        }

    stub = types.ModuleType("backend.comparison")
    stub.compare_jsons = _fake_compare_jsons
    monkeypatch.setitem(sys.modules, "backend.comparison", stub)

    result = await compare_documents_with_fallback(si, bl, use_llm_fallback=True)
    assert result["status"] == "mismatch"
    assert result["incorrect_or_missing"] == ["port_of_discharge"]