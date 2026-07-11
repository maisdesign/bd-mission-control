#!/bin/sh

usage() {
  cat <<'EOF'
Usage:
  sh scripts/refresh.sh [--beads-dir <path>] [--out <path>]

Behavior:
  - Finds .beads/issues.jsonl by explicit --beads-dir or by walking up from cwd.
  - Writes a UTF-8 no-BOM orchestration-data.js snapshot to --out.
EOF
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r/\\r/g'
}

resolve_dir() {
  cd "$1" 2>/dev/null && pwd -P
}

resolve_file() {
  path=$1
  case $path in
    /*)
      dir=$(dirname "$path")
      base=$(basename "$path")
      dir=$(resolve_dir "$dir") || return 1
      printf '%s/%s\n' "$dir" "$base"
      ;;
    *)
      dir=$(dirname "$path")
      base=$(basename "$path")
      dir=$(resolve_dir "$dir") || return 1
      printf '%s/%s\n' "$dir" "$base"
      ;;
  esac
}

find_issues_in_dir() {
  dir=$1
  if [ -f "$dir/issues.jsonl" ]; then
    printf '%s\n' "$dir/issues.jsonl"
    return 0
  fi
  if [ -f "$dir/.beads/issues.jsonl" ]; then
    printf '%s\n' "$dir/.beads/issues.jsonl"
    return 0
  fi
  return 1
}

find_issues_upward() {
  dir=$(pwd -P) || return 1
  while :; do
    if [ -f "$dir/.beads/issues.jsonl" ]; then
      printf '%s\n' "$dir/.beads/issues.jsonl"
      return 0
    fi
    parent=$(dirname "$dir")
    if [ "$parent" = "$dir" ]; then
      return 1
    fi
    dir=$parent
  done
}

in_git_dir() {
  path=$1
  case $path in
    */.git|*/.git/*)
      return 0
      ;;
  esac
  return 1
}

BEADS_DIR=
OUT=./orchestration-data.js

while [ $# -gt 0 ]; do
  case "$1" in
    --beads-dir|-BeadsDir)
      if [ $# -lt 2 ]; then
        usage >&2
        printf '%s\n' 'error: --beads-dir requires a value' >&2
        exit 1
      fi
      BEADS_DIR=$2
      shift 2
      ;;
    --out|-Out)
      if [ $# -lt 2 ]; then
        usage >&2
        printf '%s\n' 'error: --out requires a value' >&2
        exit 1
      fi
      OUT=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      printf '%s\n' "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$BEADS_DIR" ]; then
  beads_abs=$(resolve_dir "$BEADS_DIR") || {
    usage >&2
    printf '%s\n' 'error: could not resolve --beads-dir' >&2
    exit 1
  }
  issues_path=$(find_issues_in_dir "$beads_abs") || {
    usage >&2
    printf '%s\n' 'error: could not find .beads/issues.jsonl' >&2
    exit 1
  }
else
  issues_path=$(find_issues_upward) || {
    usage >&2
    printf '%s\n' 'error: could not find .beads/issues.jsonl' >&2
    exit 1
  }
fi

out_path=$(resolve_file "$OUT") || {
  usage >&2
  printf '%s\n' 'error: could not resolve --out' >&2
  exit 1
}

if in_git_dir "$out_path"; then
  usage >&2
  printf '%s\n' 'error: refusing to write inside a .git directory' >&2
  exit 1
fi

issues_json=
skipped=0
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | sed 's/\r$//')
  case "$line" in
    '')
      skipped=$((skipped + 1))
      ;;
    \{*\})
      if [ -n "$issues_json" ]; then
        issues_json=$issues_json,$line
      else
        issues_json=$line
      fi
      ;;
    *)
      skipped=$((skipped + 1))
      ;;
  esac
done < "$issues_path"

if [ "$skipped" -gt 0 ]; then
  printf '%s\n' "Skipped $skipped corrupt/blank lines from $issues_path" >&2
fi

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_json=$(json_escape "$issues_path")
generated_json=$(json_escape "$generated_at")

orchestrator_json=
if command -v bd >/dev/null 2>&1; then
  if memories_output=$(bd memories 2>/dev/null); then
    keys=$(printf '%s\n' "$memories_output" | awk '/^  [^[:space:]]/ { sub(/^  /, ""); print }')
    if [ -n "$keys" ]; then
      set -f
      first_pair=1
      orchestrator_json=
      for key in $keys; do
        case "$key" in
          orchestrator-lock*|handoff*|attempts-*)
            value=$(bd recall "$key" 2>/dev/null) || continue
            encoded_key=$(json_escape "$key")
            encoded_value=$(json_escape "$value")
            pair="\"$encoded_key\":\"$encoded_value\""
            if [ $first_pair -eq 1 ]; then
              orchestrator_json=$pair
              first_pair=0
            else
              orchestrator_json=$orchestrator_json,$pair
            fi
            ;;
        esac
      done
      set +f
      if [ -n "$orchestrator_json" ]; then
        orchestrator_json="{$orchestrator_json}"
      fi
    fi
  fi
fi

snapshot='window.BMC_SNAPSHOT = {"generated_at":"'"$generated_json"'","source":"'"$source_json"'","issues":['"$issues_json"']'
if [ -n "$orchestrator_json" ]; then
  snapshot=$snapshot',"orchestrator":'"$orchestrator_json"
fi
snapshot=$snapshot'};'

meta_path=$(dirname "$out_path")/orchestration.meta.json
if [ -f "$meta_path" ]; then
  meta_text=$(cat "$meta_path")
  snapshot=$(printf '%s\nwindow.BMC_META = %s;' "$snapshot" "$meta_text")
fi

out_dir=$(dirname "$out_path")
if [ ! -d "$out_dir" ]; then
  mkdir -p "$out_dir" || exit 1
fi

printf '%s' "$snapshot" > "$out_path"
