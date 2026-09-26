import sys
import json
import requests
import re
from config import settings

def test_interpret():
    prompt = """You are PrivAgent's task interpreter.
Analyze the user's natural language request and output a structured JSON semantic goal.

Output ONLY a valid JSON object matching this schema. Do NOT include markdown blocks:
{
  "intent": "What is the primary action? e.g. SEARCH, NAVIGATE, FILL_FORM, UPLOAD, PLAY",
  "target": {
    "type": "What kind of thing? e.g. website, video, song, product, article",
    "entity": "Name of the target? e.g. 'CarryMinati', 'GitHub'",
    "attributes": {}
  },
  "constraints": ["e.g. latest", "cheapest"],
  "entities": ["any other mentioned entities"],
  "expected_state": "Description of what the browser should look like when this task is fully complete.",
  "subgoals": ["Step 1", "Step 2"],
  "confidence": 0.95
}
"""
    headers = {
        "Authorization": f"Bearer {settings.API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": settings.REASONING_MODEL,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": "open youtube and play latest song from Karan Aujla"}
        ],
        "temperature": 0.0
    }
    print(f"Using Base URL: {settings.AI_BASE_URL}")
    print(f"Using Model: {settings.REASONING_MODEL}")
    try:
        resp = requests.post(f"{settings.AI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=10)
        print("Status:", resp.status_code)
        if resp.status_code == 200:
            content = resp.json().get("choices", [])[0].get("message", {}).get("content", "").strip()
            print("RAW CONTENT:\n", content)
            
            # extract JSON
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if match:
                content = match.group(0)
                print("EXTRACTED JSON:\n", content)
                parsed = json.loads(content)
                print("PARSED INTENT:", parsed.get("intent"))
            else:
                print("No JSON found")
        else:
            print("Error:", resp.text)
    except Exception as e:
        print("Exception:", e)

if __name__ == "__main__":
    test_interpret()
