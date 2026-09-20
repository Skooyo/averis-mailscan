"""Shared pydantic models for the pipeline.

Each stage adds its own models here so downstream stages import from one place.
"""

from typing import Literal

from pydantic import BaseModel, Field

DocType = Literal["SI", "BL", "unknown"]


class Attachment(BaseModel):
    path: str  # as given in the inbox JSON, e.g. "attachments/email_001_SI.txt"
    doc_type: DocType  # parsed from the _SI / _BL filename suffix
    ext: str  # "txt" | "pdf" | "xlsx" | "docx" | anything else
    text: str | None = None  # extracted text; None if unreadable
    read_error: str | None = None  # why text is None; None on success

    @property
    def readable(self) -> bool:
        return self.text is not None


class Email(BaseModel):
    email_id: str
    sender: str = Field(alias="from")  # "from" is a Python keyword
    subject: str
    body: str
    attachments: list[Attachment] = []

    model_config = {"populate_by_name": True}


# --- Classification -------------------------------------------------------

Category = Literal[
    "comparison_request",  # asks us to check/compare an SI against a draft BL
    "new_si_request",      # asks us to prepare/raise a new Shipping Instruction
    "invoice_query",       # billing, charges, invoice, GR/PGI questions
    "general",             # operational updates, reminders, notices, other work requests
    "spam",                # unsolicited / phishing / marketing
]


class Classification(BaseModel):
    category: Category
    confidence: float = Field(ge=0, le=1, description="0-1; below 0.6 means two categories were plausible")
    reasoning: str = Field(description="One sentence citing the phrase in the email that decided the category")


class ClassificationItem(Classification):
    email_id: str


class ClassificationBatch(BaseModel):
    results: list[ClassificationItem]
