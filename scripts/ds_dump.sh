#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 <db_url> <output_path>" >&2
  echo "   or: $0 <host> <user> <db> <output_path> [port]" >&2
  exit 1
fi

parse_db_url() {
  local url="$1"
  local no_scheme userinfo hostpart dbpart hostport

  no_scheme="${url#*://}"
  userinfo="${no_scheme%@*}"
  hostpart="${no_scheme#*@}"
  dbpart="${hostpart#*/}"
  hostport="${hostpart%%/*}"

  host="${hostport%%:*}"
  port="${hostport#*:}"
  if [ "$host" = "$port" ]; then
    port=""
  fi

  if [ "$userinfo" != "$no_scheme" ]; then
    user="${userinfo%%:*}"
    password="${userinfo#*:}"
    if [ "$user" = "$password" ]; then
      password=""
    fi
  fi

  db="$dbpart"
}

host=""
user=""
password=""
db=""
port=""

if [[ "$1" == postgres://* || "$1" == postgresql://* ]]; then
  if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <db_url> <output_path>" >&2
    exit 1
  fi
  parse_db_url "$1"
  output_path="$2"
else
  if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 <host> <user> <db> <output_path> [port]" >&2
    exit 1
  fi
  host="$1"
  user="$2"
  db="$3"
  output_path="$4"
  port="${5:-}"
fi

port_flag=()
if [ -n "$port" ]; then
  port_flag=(-p "$port")
fi

if [ -n "${password:-}" ]; then
  export PGPASSWORD="$password"
fi

pg_dump -h "$host" "${port_flag[@]}" -U "$user" -d "$db" -F c -b -v -f "$output_path"
