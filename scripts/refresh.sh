#!/bin/sh

usage() {
  cat <<'EOF'
Usage:
  sh scripts/refresh.sh [--beads-dir <path>] [--out <path>] [--no-bd-enrich]

Behavior:
  - Finds .beads/issues.jsonl by explicit --beads-dir or by walking up from cwd.
  - Writes a UTF-8 no-BOM orchestration-data.js snapshot to --out.
EOF
}

json_escape() {
  awk '
    BEGIN {
      RS = "\0";
      ORS = "";
      esc["\\"] = "\\\\";
      esc["\""] = "\\\"";
      esc["\b"] = "\\b";
      esc["\f"] = "\\f";
      esc["\n"] = "\\n";
      esc["\r"] = "\\r";
      esc["\t"] = "\\t";
      esc["\342\200\250"] = "\\u2028";
      esc["\342\200\251"] = "\\u2029";
      for (i = 0; i < 32; i++) {
        ch = sprintf("%c", i);
        if (!(ch in esc)) {
          esc[ch] = sprintf("\\u%04x", i);
        }
      }
    }
    {
      printf "\"";
      text = $0;
      for (i = 1; i <= length(text); i++) {
        ch = substr(text, i, 1);
        if (ch in esc) {
          printf "%s", esc[ch];
        } else {
          printf "%s", ch;
        }
      }
      printf "\"";
    }
  '
}

read_raw_file() {
  awk '
    BEGIN { RS = "\0"; ORS = "" }
    {
      sub(/^\xef\xbb\xbf/, "");
      printf "%s", $0;
    }
  ' "$1"
}

sanitize_memory_value() {
  awk '
    BEGIN {
      RS = "\0";
      ORS = "";
      IGNORECASE = 1;
    }
    {
      text = $0;
      text = gensub(/((api[_-]?key|bearer|token|password)[[:space:]]*[:=][[:space:]]*)[^[:space:]]+/, "\\1***REDACTED***", "g", text);
      text = gensub(/((api[_-]?key|bearer|token|password)[[:space:]]+)[^[:space:]]+/, "\\1***REDACTED***", "g", text);
      if (length(text) > 2000) {
        text = substr(text, 1, 2000);
      }
      printf "%s", text;
    }
  '
}

resolve_dir() {
  cd "$1" 2>/dev/null && pwd -P
}

resolve_file() {
  path=$1
  case $path in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*)
      abs=$path
      ;;
    *)
      abs=$(pwd -P)/$path
      ;;
  esac
  dir=$(dirname "$abs")
  base=$(basename "$abs")
  if resolved=$(resolve_physical_dir "$dir" 2>/dev/null); then
    printf '%s/%s\n' "$resolved" "$base"
    return 0
  fi
  printf '%s/%s\n' "$dir" "$base"
}

resolve_physical_dir() {
  dir=$1
  case $dir in
    [A-Za-z]:/*|[A-Za-z]:\\*)
      printf '%s\n' "$dir"
      return 0
      ;;
  esac
  if resolved=$(readlink -f -- "$dir" 2>/dev/null); then
    printf '%s\n' "$resolved"
    return 0
  fi
  if resolved=$(realpath -- "$dir" 2>/dev/null); then
    printf '%s\n' "$resolved"
    return 0
  fi
  resolve_dir "$dir"
}

ensure_no_symlink_chain() {
  path=$1
  if [ -L "$path" ]; then
    printf '%s\n' "error: refusing to write through symlink: $path" >&2
    exit 1
  fi

  parent=$(dirname "$path")
  while [ -n "$parent" ] && [ "$parent" != "/" ] && [ "$parent" != "." ]; do
    if [ -L "$parent" ]; then
      printf '%s\n' "error: refusing to write through symlink parent: $parent" >&2
      exit 1
    fi
    next=$(dirname "$parent")
    if [ "$next" = "$parent" ]; then
      break
    fi
    parent=$next
  done
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

BEADS_DIR=
OUT=./orchestration-data.js
NO_BD_ENRICH=0

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
    --no-bd-enrich|-NoBdEnrich)
      NO_BD_ENRICH=1
      shift
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
temp_path=$out_path.tmp

ensure_no_symlink_chain "$out_path"
ensure_no_symlink_chain "$temp_path"

case $out_path in
  */.git|*/.git/*|.git|.git/*)
    usage >&2
    printf '%s\n' 'error: refusing to write inside a .git directory' >&2
    exit 1
    ;;
esac

case $temp_path in
  */.git|*/.git/*|.git|.git/*)
    usage >&2
    printf '%s\n' 'error: refusing to write inside a .git directory' >&2
    exit 1
    ;;
esac

out_dir=$(dirname "$out_path")
if [ ! -d "$out_dir" ]; then
  mkdir -p "$out_dir" || exit 1
fi

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_json=$(printf '%s' "$issues_path" | json_escape)
generated_json=$(printf '%s' "$generated_at" | json_escape)
issues_jsonl_json=$(read_raw_file "$issues_path" | json_escape)

orchestrator_json=
if [ "$NO_BD_ENRICH" -eq 0 ] && command -v bd >/dev/null 2>&1; then
  printf '%s\n' 'warning: bd memory enrichment is included in this publishable snapshot; use --no-bd-enrich to disable it' >&2
  if memories_output=$(bd memories 2>/dev/null); then
    keys=$(printf '%s\n' "$memories_output" | awk '/^  [^[:space:]]/ { sub(/^  /, ""); print }')
    if [ -n "$keys" ]; then
      first_pair=1
      orchestrator_json=
      while IFS= read -r key; do
        case "$key" in
          orchestrator-lock*|handoff*|attempts-*)
            value=$(bd recall "$key" 2>/dev/null) || continue
            safe_value=$(printf '%s' "$value" | sanitize_memory_value)
            encoded_key=$(printf '%s' "$key" | json_escape)
            encoded_value=$(printf '%s' "$safe_value" | json_escape)
            pair=$encoded_key:$encoded_value
            if [ $first_pair -eq 1 ]; then
              orchestrator_json=$pair
              first_pair=0
            else
              orchestrator_json=$orchestrator_json,$pair
            fi
            ;;
        esac
      done <<EOF
$keys
EOF
      if [ -n "$orchestrator_json" ]; then
        orchestrator_json="{$orchestrator_json}"
      fi
    fi
  fi
fi

snapshot='window.BMC_SNAPSHOT = {"generated_at":'"$generated_json"',"source":'"$source_json"',"issues_jsonl":'"$issues_jsonl_json"
if [ -n "$orchestrator_json" ]; then
  snapshot=$snapshot',"orchestrator":'"$orchestrator_json"
fi
snapshot=$snapshot'};'

meta_path=$(dirname "$out_path")/orchestration.meta.json
output_text=$snapshot
if [ -f "$meta_path" ]; then
  meta_text=$(read_raw_file "$meta_path" | json_escape)
  output_text=$output_text"
window.BMC_META_JSON = $meta_text;"
fi

printf '%s' "$output_text" > "$temp_path" || {
  rm -f -- "$temp_path"
  exit 1
}
mv -f -- "$temp_path" "$out_path"
