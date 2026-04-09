#!/usr/bin/env sh
set -eu

usage() {
    cat <<'EOF'
Usage:
  ./run_gemma4_ollama.sh [--model MODEL] [--prompt PROMPT]
  ./run_gemma4_ollama.sh --pull-only [--model MODEL]
  ./run_gemma4_ollama.sh --serve-only
  ./run_gemma4_ollama.sh --fire [--prompt PROMPT]
  ./run_gemma4_ollama.sh --print-codex-gemma4-config
  ./run_gemma4_ollama.sh --list

Defaults:
  MODEL         = gemma4:e4b
  HOST          = 127.0.0.1:11435
  PROMPT        = 请用中文简单介绍 Gemma 4。
  PROVIDER_ID   = ollama-local
  BACKEND_ALIAS = codex-gemma4

Environment overrides:
  OLLAMA_VERSION
  OLLAMA_HOST
  OLLAMA_MODELS
  LOCAL_OLLAMA_DIR
  CODEX_PROVIDER_ID
  CONDUCTOR_BACKEND_ALIAS
  CODEX_CONFIG
  CONDUCTOR_CONFIG
EOF
}

log() {
    printf '%s\n' "$*" >&2
}

require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "missing required tool: $1"
        exit 1
    fi
}

run_no_proxy() {
    env \
        -u HTTP_PROXY \
        -u HTTPS_PROXY \
        -u ALL_PROXY \
        -u NO_PROXY \
        -u http_proxy \
        -u https_proxy \
        -u all_proxy \
        -u no_proxy \
        "$@"
}

service_ready() {
    run_no_proxy curl -fsS "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1
}

ollama_port() {
    printf '%s\n' "${OLLAMA_HOST##*:}"
}

running_models() {
    ps_output="$(
        run_no_proxy env \
            OLLAMA_HOST="${OLLAMA_HOST}" \
            OLLAMA_MODELS="${OLLAMA_MODELS}" \
            "${OLLAMA_BIN}" ps 2>/dev/null || true
    )"

    printf '%s\n' "${ps_output}" | awk '
        NR > 1 && NF > 0 {
            if (out != "") {
                out = out ", "
            }
            out = out $1
        }
        END {
            if (out == "") {
                print "none"
            } else {
                print out
            }
        }
    '
}

show_service_status() {
    loaded_models="$(running_models)"

    log "Ollama host: ${OLLAMA_HOST}"
    log "Ollama port: $(ollama_port)"
    log "Ollama status: running (${SERVICE_SOURCE})"
    log "Ollama target model: ${MODEL}"
    log "Ollama loaded models: ${loaded_models}"
}

ensure_local_ollama() {
    if [ -x "${OLLAMA_BIN}" ]; then
        return
    fi

    require_tool curl
    require_tool zstd
    require_tool tar

    mkdir -p "${LOCAL_OLLAMA_DIR}"
    log "installing Ollama ${OLLAMA_VERSION} into ${LOCAL_OLLAMA_DIR}"
    (
        unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
        unset http_proxy https_proxy all_proxy no_proxy
        curl -fsSL "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst" \
            | zstd -d \
            | tar -xf - -C "${LOCAL_OLLAMA_DIR}"
    )
}

start_service_if_needed() {
    if service_ready; then
        SERVICE_SOURCE="existing service"
        return
    fi

    mkdir -p "${LOG_DIR}" "${OLLAMA_MODELS}"
    log "starting local Ollama on ${OLLAMA_HOST}"
    (
        unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
        unset http_proxy https_proxy all_proxy no_proxy
        export OLLAMA_HOST OLLAMA_MODELS
        nohup "${OLLAMA_BIN}" serve >"${LOG_FILE}" 2>&1 &
    )

    i=0
    while [ "${i}" -lt 60 ]; do
        if service_ready; then
            SERVICE_SOURCE="started by script"
            return
        fi
        i=$((i + 1))
        sleep 1
    done

    log "Ollama did not become ready within 60 seconds"
    log "tail of ${LOG_FILE}:"
    tail -n 40 "${LOG_FILE}" >&2 || true
    exit 1
}

pull_model() {
    log "pulling ${MODEL}"
    run_no_proxy env \
        OLLAMA_HOST="${OLLAMA_HOST}" \
        OLLAMA_MODELS="${OLLAMA_MODELS}" \
        "${OLLAMA_BIN}" pull "${MODEL}"
}

list_models() {
    run_no_proxy env \
        OLLAMA_HOST="${OLLAMA_HOST}" \
        OLLAMA_MODELS="${OLLAMA_MODELS}" \
        "${OLLAMA_BIN}" list
}

run_prompt() {
    run_no_proxy env \
        OLLAMA_HOST="${OLLAMA_HOST}" \
        OLLAMA_MODELS="${OLLAMA_MODELS}" \
        "${OLLAMA_BIN}" run "${MODEL}" "${PROMPT}"
}

print_codex_gemma4_config() {
    cat <<EOF
# Add this provider block to ${CODEX_CONFIG}
[model_providers.${CODEX_PROVIDER_ID}]
name = "ollama"
base_url = "http://${OLLAMA_HOST}/v1"
wire_api = "responses"
requires_openai_auth = false

# Add this backend alias to ${CONDUCTOR_CONFIG}
allow_cli_list:
  ${CONDUCTOR_BACKEND_ALIAS}: codex -c 'model_provider="${CODEX_PROVIDER_ID}"' -c 'model="${MODEL}"'
EOF
}

has_codex_provider_config() {
    [ -f "${CODEX_CONFIG}" ] && grep -Fq "[model_providers.${CODEX_PROVIDER_ID}]" "${CODEX_CONFIG}"
}

has_conductor_backend_alias() {
    [ -f "${CONDUCTOR_CONFIG}" ] && grep -Fq "${CONDUCTOR_BACKEND_ALIAS}:" "${CONDUCTOR_CONFIG}"
}

ensure_codex_gemma4_config() {
    missing=0

    if ! has_codex_provider_config; then
        log "missing Codex provider config [model_providers.${CODEX_PROVIDER_ID}] in ${CODEX_CONFIG}"
        missing=1
    fi

    if ! has_conductor_backend_alias; then
        log "missing Conductor backend alias ${CONDUCTOR_BACKEND_ALIAS} in ${CONDUCTOR_CONFIG}"
        missing=1
    fi

    if [ "${missing}" -ne 0 ]; then
        log "expected config snippet:"
        print_codex_gemma4_config >&2
        exit 1
    fi
}

run_conductor_fire() {
    require_tool codex
    require_tool conductor
    ensure_codex_gemma4_config

    log "starting conductor fire with backend ${CONDUCTOR_BACKEND_ALIAS}"
    run_no_proxy conductor fire --backend "${CONDUCTOR_BACKEND_ALIAS}" -- "${PROMPT}"
}

ACTION="run"
MODEL="gemma4:e4b"
PROMPT="请用中文简单介绍 Gemma 4。"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --model)
            MODEL="$2"
            shift 2
            ;;
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        --pull-only)
            ACTION="pull"
            shift
            ;;
        --serve-only)
            ACTION="serve"
            shift
            ;;
        --fire)
            ACTION="fire"
            shift
            ;;
        --print-codex-gemma4-config|--print-config)
            ACTION="print-config"
            shift
            ;;
        --list)
            ACTION="list"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log "unknown argument: $1"
            usage
            exit 1
            ;;
    esac
done

OLLAMA_VERSION="${OLLAMA_VERSION:-0.20.0}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11435}"
OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.cache/ollama-gemma4/models}"
LOCAL_OLLAMA_DIR="${LOCAL_OLLAMA_DIR:-$HOME/.local/share/ollama-v${OLLAMA_VERSION}}"
OLLAMA_BIN="${LOCAL_OLLAMA_DIR}/bin/ollama"
LOG_DIR="${HOME}/.cache/ollama-gemma4/logs"
LOG_FILE="${LOG_DIR}/serve.log"
SERVICE_SOURCE="unknown"
CODEX_PROVIDER_ID="${CODEX_PROVIDER_ID:-ollama-local}"
CONDUCTOR_BACKEND_ALIAS="${CONDUCTOR_BACKEND_ALIAS:-codex-gemma4}"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
CONDUCTOR_CONFIG="${CONDUCTOR_CONFIG:-$HOME/.conductor/config.yaml}"

if [ "${ACTION}" = "print-config" ]; then
    print_codex_gemma4_config
    exit 0
fi

ensure_local_ollama
start_service_if_needed
show_service_status

case "${ACTION}" in
    serve)
        log "Ollama is ready on ${OLLAMA_HOST}"
        ;;
    list)
        list_models
        ;;
    pull)
        pull_model
        ;;
    fire)
        pull_model
        run_conductor_fire
        ;;
    run)
        pull_model
        run_prompt
        ;;
esac
