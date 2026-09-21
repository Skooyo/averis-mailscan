import os.path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from pathlib import Path
import json

# Define the scopes your application needs
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

creds = None

def get_gmail_service():
    creds = None

    current_dir = Path(__file__).resolve().parent  # -> /Users/name/repo/src/utils
    token_file = "token.json"    
    file_path = current_dir /  token_file
    # 2. Persist authentication: Check if token.json already exists
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
        
        # Save the credentials for the next run so you won't re-authenticate
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return build('gmail', 'v1', credentials=creds)

def fetch_all_emails_to_json(max_emails=5):
    service = get_gmail_service()
    
    # 1. Get the list of message IDs
    results = service.users().messages().list(userId='me', maxResults=max_emails).execute()
    messages = results.get('messages', [])

    if not messages:
        print("No messages found.")
        return

    full_emails = []

    print(f"Fetching {len(messages)} full emails...")
    for msg in messages:
        # 1. Fetch the FULL email payload instead of just the snippet
        msg_detail = service.users().messages().get(
            userId='me', 
            id=msg['id'], 
            format='full'  # Options: 'full', 'metadata', 'raw', 'minimal'
        ).execute()
        
        full_emails.append(msg_detail)

    # 3. Output everything neatly into a JSON file
    output_file = 'emails.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(full_emails, f, indent=4, ensure_ascii=False)

    print(f"Success! Saved emails to {output_file}")

if __name__ == '__main__':
    fetch_all_emails_to_json()