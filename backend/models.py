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
