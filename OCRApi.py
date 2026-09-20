from google.api_core.client_options import ClientOptions
from google.cloud import documentai_v1
import os
from dotenv import load_dotenv

from pathlib import Path

current_dir = Path(__file__).resolve().parent  # -> /Users/name/repo/src/utils

testing_file = "email_059_SI.pdf"
parent_dir = current_dir.parent               # -> /Users/name/repo/src
file_path = current_dir / "attachments" / testing_file

load_dotenv()
project_id = os.environ.get('PROJECT_ID')
processor_id = os.environ.get('PROCESSOR_ID')
location = os.environ.get('LOCATION')


# Set `api_endpoint` if you use a location other than "us".
opts = ClientOptions(api_endpoint=f"{location}-documentai.googleapis.com")

# Initialize Document AI client.
client = documentai_v1.DocumentProcessorServiceClient(client_options=opts)

# Get the Fully-qualified Processor path.
full_processor_name = client.processor_path(project_id, location, processor_id)

# Get a Processor reference.
request = documentai_v1.GetProcessorRequest(name=full_processor_name)
processor = client.get_processor(request=request)

# `processor.name` is the full resource name of the processor.
# For example: `projects/{project_id}/locations/{location}/processors/{processor_id}`
print(f"Processor Name: {processor.name}")

# Read the file into memory.
with open(file_path, "rb") as image:
    image_content = image.read()

# Load binary data.
# For supported MIME types, refer to https://cloud.google.com/document-ai/docs/file-types
raw_document = documentai_v1.RawDocument(
    content=image_content,
    mime_type="application/pdf",
)

# Send a request and get the processed document.
request = documentai_v1.ProcessRequest(name=processor.name, raw_document=raw_document)
result = client.process_document(request=request)
document_output = result.document

# Read the text recognition output from the processor.
# For a full list of `Document` object attributes, reference this page:
# https://cloud.google.com/document-ai/docs/reference/rest/v1/Document
print("The document contains the following text:")
for entity in document_output.entities:
        print(f"Label: {entity.type_} | Extracted Text: '{entity.mention_text}' | Confidence: {entity.confidence:.2f}")