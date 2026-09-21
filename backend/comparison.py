from typing import Any, Dict, List
from pydantic import BaseModel, Field
import json

from backend.llm import astructured_completion

class ComparisonDetail(BaseModel):
    left: Any = None
    right: Any = None

class CompareResult(BaseModel):
    status: str
    incorrect_or_missing: List[str] = Field(default_factory=list)
    details: Dict[str, ComparisonDetail] = Field(default_factory=dict)

def build_compare_prompt(json_a: Dict[str, Any], json_b: Dict[str, Any]) -> str:
    return f"""
Compare the two JSON objects below.

Rules:
- Treat the same data as equal even when field names or values are written differently.
- Example equivalences:
  - "port_of_loading" = "loading port" = "port of loading"
  - "port_of_discharge" = "discharge port" = "port of discharge"
- Ignore differences in case, whitespace, punctuation, and common formatting.
- If values are semantically equivalent, consider them matched.
- If they are not equivalent, identify which of the 7 labels are incorrect or missing.

Use these 7 labels exactly:
- shipment_id
- port_of_loading
- port_of_discharge
- carrier
- product
- quantity
- delivery_date

Return valid JSON matching this schema:
{{
  "status": "match" | "mismatch",
  "incorrect_or_missing": ["label1", "label2"],
  "details": {{
    "label1": {{"left": "...", "right": "..."}},
    "label2": {{"left": "...", "right": "..."}}
  }}
}}

If all 7 labels match, return:
{{"status":"match","incorrect_or_missing":[],"details":{{}}}}

JSON A:
{json.dumps(json_a, ensure_ascii=False, indent=2)}

JSON B:
{json.dumps(json_b, ensure_ascii=False, indent=2)}
"""

async def compare_jsons(json_a: Dict[str, Any], json_b: Dict[str, Any]) -> Dict[str, Any]:
    prompt = build_compare_prompt(json_a, json_b)
    result: CompareResult = await astructured_completion(
        system="You compare JSON payloads and return only valid structured JSON.",
        user=prompt,
        schema=CompareResult,
    )
    return result.model_dump()