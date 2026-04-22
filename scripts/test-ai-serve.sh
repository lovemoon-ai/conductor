#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CONDUCTOR_SERVE_AI_BASE_URL:-http://127.0.0.1:8787}"
MODEL="${CONDUCTOR_SERVE_AI_MODEL:-}"
API_KEY="${CONDUCTOR_SERVE_AI_API_KEY:-}"
CURL_CONNECT_TIMEOUT="${CONDUCTOR_SERVE_AI_CONNECT_TIMEOUT:-10}"
CURL_MAX_TIME="${CONDUCTOR_SERVE_AI_CURL_MAX_TIME:-120}"

TEST_IMAGE_URL="https://upload.wikimedia.org/wikipedia/en/7/7d/Lenna_%28test_image%29.png"

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
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$CURL_MAX_TIME" \
    "${headers[@]}" \
    -d "$payload" \
    "$BASE_URL/v1/chat/completions"
}

build_model_field() {
  if [[ -n "$MODEL" ]]; then
    printf '  "model": "%s",\n' "$MODEL"
  fi
}

extract_assistant_message() {
  local body="$1"
  printf '%s' "$body" | node --input-type=module -e '
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      process.stdout.write(String(parsed?.choices?.[0]?.message?.content ?? ""));
    });
  '
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

TEXT_PROMPT='Return a JSON object with answer and nothing else. What is 1+1?'

echo "==> Testing serve-ai text chat"
TEXT_RESPONSE="$(post_chat_completion "$(cat <<JSON
{
$(build_model_field)
  "messages": [
    {
      "role": "user",
      "content": "$TEXT_PROMPT"
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
TEXT_MESSAGE="$(extract_assistant_message "$TEXT_RESPONSE")"
echo "[prompt]"
echo "$TEXT_PROMPT"
echo "[assistant]"
echo "$TEXT_MESSAGE"
assert_contains "$TEXT_RESPONSE" '"content":"{\"answer\":2}"' "text"

echo
echo "==> Testing serve-ai image chat"
IMAGE_PROMPT='Does the woman in image wear a hat? Answer yes or no.'
IMAGE_RESPONSE="$(post_chat_completion "$(cat <<JSON
{
$(build_model_field)
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "$IMAGE_PROMPT"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "$TEST_IMAGE_URL"
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
          "answer": { "type": "string", "enum": ["yes"] }
        },
        "required": ["answer"],
        "additionalProperties": false
      }
    }
  }
}
JSON
)")"
IMAGE_MESSAGE="$(extract_assistant_message "$IMAGE_RESPONSE")"
echo "[prompt]"
echo "$IMAGE_PROMPT"
echo "[image]"
echo "$TEST_IMAGE_URL"
echo "[assistant]"
echo "$IMAGE_MESSAGE"
assert_contains "$IMAGE_RESPONSE" '"content":"{\"answer\":\"yes\"}"' "image"

echo
if [[ -n "$MODEL" ]]; then
  echo "All serve-ai curl tests passed for model=$MODEL at $BASE_URL"
else
  echo "All serve-ai curl tests passed using server default backend at $BASE_URL"
fi
