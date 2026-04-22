#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CONDUCTOR_SERVE_AI_BASE_URL:-http://127.0.0.1:8787}"
MODEL="${CONDUCTOR_SERVE_AI_MODEL:-codex}"
API_KEY="${CONDUCTOR_SERVE_AI_API_KEY:-}"

RED_SQUARE_DATA_URL="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z/CfHgAGgwJ/l7N0WQAAAABJRU5ErkJggg=="

build_headers() {
  local headers=(
    -H "Content-Type: application/json"
  )
  if [[ -n "$API_KEY" ]]; then
    headers+=(-H "Authorization: Bearer $API_KEY")
  fi
  printf '%s\n' "${headers[@]}"
}

post_chat_completion() {
  local payload="$1"
  local headers=()
  mapfile -t headers < <(build_headers)

  curl --silent --show-error --fail-with-body \
    "${headers[@]}" \
    -d "$payload" \
    "$BASE_URL/v1/chat/completions"
}

assert_contains() {
  local body="$1"
  local expected="$2"
  local label="$3"
  if [[ "$body" != *"$expected"* ]]; then
    echo "[$label] unexpected response" >&2
    echo "expected substring: $expected" >&2
    echo "actual response:" >&2
    echo "$body" >&2
    exit 1
  fi
}

echo "==> Testing serve-ai text chat"
TEXT_RESPONSE="$(post_chat_completion "$(cat <<JSON
{
  "model": "$MODEL",
  "messages": [
    {
      "role": "user",
      "content": "Return a JSON object with answer and nothing else. What is 1+1?"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "text_reply",
      "schema": {
        "type": "object",
        "properties": {
          "answer": { "type": "integer", "enum": [1,2,3,4,5] }
        },
        "required": ["answer"],
        "additionalProperties": false
      }
    }
  }
}
JSON
)")"
echo "$TEXT_RESPONSE"
assert_contains "$TEXT_RESPONSE" '"content":"{\"answer\":2}"' "text"

echo
echo "==> Testing serve-ai image chat"
IMAGE_RESPONSE="$(post_chat_completion "$(cat <<JSON
{
  "model": "$MODEL",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Inspect the attached image and return a JSON object with dominant_color as the common English color name."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "$RED_SQUARE_DATA_URL"
          }
        }
      ]
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "image_reply",
      "schema": {
        "type": "object",
        "properties": {
          "dominant_color": { "type": "string", "enum": ["red"] }
        },
        "required": ["dominant_color"],
        "additionalProperties": false
      }
    }
  }
}
JSON
)")"
echo "$IMAGE_RESPONSE"
assert_contains "$IMAGE_RESPONSE" '"content":"{\"dominant_color\":\"red\"}"' "image"

echo
echo "All serve-ai curl tests passed for model=$MODEL at $BASE_URL"
