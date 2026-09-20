import os.path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from pathlib import Path

# Define the scopes your application needs
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

creds = None

current_dir = Path(__file__).resolve().parent  # -> /Users/name/repo/src/utils
token_file = "token.json"
parent_dir = current_dir.parent               # -> /Users/name/repo/src

file_path = current_dir / "attachments" / token_file
if os.path.exists(file_path):
    creds = Credentials.from_authorized_user_file(token_file, SCOPES)

# If there are no (valid) credentials available, let the user log in.
if not creds or not creds.valid:
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        flow = InstalledAppFlow.from_client_secrets_file(
            'credentials.json', SCOPES)
        creds = flow.run_local_server(port=0)
    # Save the credentials for the next run
    with open('token.json', 'w') as token:
        token.write(creds.to_json())

# Build the Gmail service
service = build('gmail', 'v1', credentials=creds)

# Call the Gmail API to list labels
results = service.users().labels().list(userId='me').execute()
labels = results.get('labels', [])

if not labels:
    print('No labels found.')

else:
    print('Labels:')
    for label in labels:
        print(label['name'])