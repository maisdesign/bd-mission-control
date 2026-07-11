#!/bin/sh

usage() {
  cat <<'EOF'
Usage:
  sh scripts/install.sh -Target <project-root> [-Dir <subdir>] [-Update] [-Force]

Behavior:
  - Vendors dist/orchestration.html into the target project.
  - Copies scripts/refresh.ps1 and scripts/refresh.sh into target/scripts/.
  - Creates orchestration.config.js only when it does not already exist.
  - -Update replaces the panel and refresh scripts.
  - -Force is dangerous: it warns loudly before overwriting a locally modified panel.
EOF
}

path_to_posix() {
  local drive rest
  case "$1" in
    [A-Za-z]:\\*)
      drive=$(printf '%s' "$1" | cut -c1 | tr 'A-Z' 'a-z')
      rest=$(printf '%s' "$1" | cut -c3- | tr '\\' '/')
      printf '/%s%s\n' "$drive" "$rest"
      ;;
    [A-Za-z]:/*)
      drive=$(printf '%s' "$1" | cut -c1 | tr 'A-Z' 'a-z')
      rest=$(printf '%s' "$1" | cut -c3-)
      printf '/%s%s\n' "$drive" "$rest"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

resolve_existing_path() {
  local path
  path="$(path_to_posix "$1")"
  cd "$path" 2>/dev/null && pwd -P
}

trim_trailing_slashes() {
  local path
  path="$1"
  while [ "${path%/}" != "$path" ] && [ "$path" != "/" ]; do
    path=${path%/}
  done
  printf '%s\n' "$path"
}

normalize_prefix() {
  local path resolved
  path="$(path_to_posix "$1")"
  if resolved="$(cd "$path" 2>/dev/null && pwd -P)"; then
    trim_trailing_slashes "$resolved"
    return 0
  fi
  trim_trailing_slashes "$path"
}

path_inside_root() {
  local path root
  path="$(normalize_prefix "$1")"
  root="$(normalize_prefix "$2")"
  case "$path" in
    "$root")
      return 0
      ;;
    "$root"/*)
      return 0
      ;;
  esac
  return 1
}

assert_inside_root() {
  if ! path_inside_root "$1" "$2"; then
    printf '%s\n' "error: refusing to write outside target root: $1" >&2
    exit 1
  fi
}

assert_no_git_segment() {
  case "$1" in
    */.git|*/.git/*|.git|.git/*)
      printf '%s\n' "error: refusing to write inside a .git directory: $1" >&2
      exit 1
      ;;
  esac
}

assert_no_symlink_chain() {
  local path parent next
  path="$1"
  if [ -L "$path" ]; then
    printf '%s\n' "error: refusing to write through symlink: $path" >&2
    exit 1
  fi

  parent="$(dirname -- "$path")"
  while [ -n "$parent" ] && [ "$parent" != "/" ] && [ "$parent" != "." ]; do
    if [ -L "$parent" ]; then
      printf '%s\n' "error: refusing to write through symlink parent: $parent" >&2
      exit 1
    fi
    next="$(dirname -- "$parent")"
    if [ "$next" = "$parent" ]; then
      break
    fi
    parent=$next
  done
}

ensure_dir_path() {
  local root relative current old_ifs part parent next
  root="$1"
  relative="$2"
  current="$root"
  if [ -z "$relative" ] || [ "$relative" = "." ]; then
    assert_no_git_segment "$current"
    assert_no_symlink_chain "$current"
    assert_inside_root "$current" "$root"
    printf '%s\n' "$current"
    return 0
  fi

  old_ifs=$IFS
  IFS=/
  set -f
  while :; do
    case "$relative" in
      */*)
        part=${relative%%/*}
        relative="${relative#*/}"
        ;;
      *)
        part="$relative"
        relative=
        ;;
    esac
    if [ -z "$part" ] || [ "$part" = "." ]; then
      if [ -z "$relative" ]; then
        break
      fi
      continue
    fi
    if [ "$part" = ".." ]; then
      printf '%s\n' "error: refusing path traversal in -Dir: $relative" >&2
      exit 1
    fi
    if [ "$part" = ".git" ]; then
      printf '%s\n' "error: refusing to write inside a .git directory: $relative" >&2
      exit 1
    fi

    current="$current/$part"
    assert_no_git_segment "$current"
    assert_inside_root "$current" "$root"
    if [ -e "$current" ] || [ -L "$current" ]; then
      assert_no_symlink_chain "$current"
      if [ ! -d "$current" ]; then
        printf '%s\n' "error: path exists and is not a directory: $current" >&2
        exit 1
      fi
    else
      mkdir "$current" || exit 1
    fi
    if [ -z "$relative" ]; then
      break
    fi
  done
  set +f
  IFS=$old_ifs

  assert_no_git_segment "$current"
  assert_no_symlink_chain "$current"
  assert_inside_root "$current" "$root"
  printf '%s\n' "$current"
}

file_bytes_equal() {
  local left right
  left="$1"
  right="$2"
  cmp -s -- "$left" "$right"
}

write_atomic_copy() {
  local source destination dest_dir temp
  source="$1"
  destination="$2"
  dest_dir="$(dirname -- "$destination")"
  if [ ! -d "$dest_dir" ]; then
    mkdir -p -- "$dest_dir" || exit 1
  fi

  assert_no_git_segment "$destination"
  assert_no_symlink_chain "$destination"
  assert_inside_root "$destination" "$TARGET_ROOT"

  temp="$destination.$$.${TEMP_TAG}.tmp"
  assert_no_git_segment "$temp"
  assert_no_symlink_chain "$temp"
  assert_inside_root "$temp" "$TARGET_ROOT"
  if [ -e "$temp" ]; then
    printf '%s\n' "error: temp path already exists: $temp" >&2
    exit 1
  fi

  (
    set -C
    cat -- "$source" > "$temp"
  ) || {
    exit 1
  }

  mv -f -- "$temp" "$destination"
}

write_vendored_copy() {
  local source destination label same_bytes
  source="$1"
  destination="$2"
  label="$3"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    assert_no_git_segment "$destination"
    assert_no_symlink_chain "$destination"
    assert_inside_root "$destination" "$TARGET_ROOT"
    same_bytes=0
    if file_bytes_equal "$source" "$destination"; then
      same_bytes=1
    fi
    if [ "$same_bytes" -eq 0 ] && [ "$UPDATE" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
      usage >&2
      printf '%s\n' "error: existing $label differs from source: $destination" >&2
      printf '%s\n' 'hint: rerun with -Update to replace the panel and refresh scripts' >&2
      exit 1
    fi
    if [ "$FORCE" -eq 1 ] && [ "$same_bytes" -eq 0 ]; then
      printf '%s\n' "WARNING: -Force is overwriting a locally modified $label: $destination" >&2
    fi
  fi

  write_atomic_copy "$source" "$destination"
}

write_config_stub() {
  local config_path target_base dest_dir temp stub
  config_path="$1"
  target_base="$2"
  if [ -e "$config_path" ] || [ -L "$config_path" ]; then
    assert_no_git_segment "$config_path"
    assert_no_symlink_chain "$config_path"
    return 0
  fi

  dest_dir="$(dirname -- "$config_path")"
  if [ ! -d "$dest_dir" ]; then
    mkdir -p -- "$dest_dir" || exit 1
  fi

  assert_no_git_segment "$config_path"
  assert_no_symlink_chain "$config_path"
  assert_inside_root "$config_path" "$TARGET_ROOT"

  temp="$config_path.$$.${TEMP_TAG}.tmp"
  assert_no_git_segment "$temp"
  assert_no_symlink_chain "$temp"
  assert_inside_root "$temp" "$TARGET_ROOT"
  if [ -e "$temp" ]; then
    printf '%s\n' "error: temp path already exists: $temp" >&2
    exit 1
  fi

  stub="$(cat <<EOF
window.BMC_CONFIG = {
  title: "$target_base mission control",
  dataPath: "../.beads/issues.jsonl",
  // accent: "#00f0ff",
  // strings: {
  //   title: "Controllo missione",
  //   footer_text: "Esempio italiano",
  // },
  // refreshInterval: 15000,
  // metaPath: "./orchestration.meta.json"
};
EOF
)"

  (
    set -C
    printf '%s' "$stub" > "$temp"
  ) || {
    exit 1
  }

  if [ -e "$config_path" ] || [ -L "$config_path" ]; then
    printf '%s\n' "error: refusing to overwrite existing config: $config_path" >&2
    exit 1
  fi

  mv -f -- "$temp" "$config_path"
}

get_panel_version() {
  local panel version
  panel="$1"
  version="$(grep -m1 'MISSION CONTROL HUD v' "$panel" | sed 's/.*MISSION CONTROL HUD v\([0-9][0-9.]*\).*/\1/')"
  if [ -z "$version" ]; then
    printf '%s\n' "error: could not read version stamp from panel: $panel" >&2
    exit 1
  fi
  printf '%s\n' "$version"
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
SOURCE_PANEL=$REPO_ROOT/dist/orchestration.html
SOURCE_REFRESH_PS1=$SCRIPT_DIR/refresh.ps1
SOURCE_REFRESH_SH=$SCRIPT_DIR/refresh.sh
TARGET=
DIR=docs
UPDATE=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -Target|--target)
      if [ $# -lt 2 ]; then
        usage >&2
        printf '%s\n' 'error: -Target requires a value' >&2
        exit 1
      fi
      TARGET=$2
      shift 2
      ;;
    -Dir|--dir)
      if [ $# -lt 2 ]; then
        usage >&2
        printf '%s\n' 'error: -Dir requires a value' >&2
        exit 1
      fi
      DIR=$2
      shift 2
      ;;
    -Update|--update)
      UPDATE=1
      shift
      ;;
    -Force|--force)
      FORCE=1
      shift
      ;;
    -h|--help)
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

if [ -z "$TARGET" ]; then
  usage >&2
  printf '%s\n' 'error: -Target is required' >&2
  exit 1
fi

if [ ! -e "$TARGET" ]; then
  usage >&2
  printf '%s\n' "error: target does not exist: $TARGET" >&2
  exit 1
fi

TARGET_ROOT=$(resolve_existing_path "$TARGET") || {
  usage >&2
  printf '%s\n' "error: could not resolve target: $TARGET" >&2
  exit 1
}

assert_no_git_segment "$TARGET_ROOT"
assert_no_symlink_chain "$TARGET_ROOT"

if [ ! -f "$SOURCE_PANEL" ]; then
  usage >&2
  printf '%s\n' "error: missing source panel: $SOURCE_PANEL" >&2
  exit 1
fi
if [ ! -f "$SOURCE_REFRESH_PS1" ]; then
  usage >&2
  printf '%s\n' "error: missing source refresh script: $SOURCE_REFRESH_PS1" >&2
  exit 1
fi
if [ ! -f "$SOURCE_REFRESH_SH" ]; then
  usage >&2
  printf '%s\n' "error: missing source refresh script: $SOURCE_REFRESH_SH" >&2
  exit 1
fi

assert_inside_root "$TARGET_ROOT" "$TARGET_ROOT"

case "$DIR" in
  /*)
    printf '%s\n' "error: refusing rooted -Dir value: $DIR" >&2
    exit 1
    ;;
esac

case "$DIR" in
  */../*|../*|*'/..'|*'../'*)
    printf '%s\n' "error: refusing path traversal in -Dir: $DIR" >&2
    exit 1
    ;;
esac

TEMP_TAG=$(awk 'BEGIN { srand(); printf "%06d", int(rand() * 1000000) }')
PANEL_DIR=$(ensure_dir_path "$TARGET_ROOT" "$DIR")
SCRIPTS_DIR=$(ensure_dir_path "$TARGET_ROOT" "scripts")
PANEL_PATH=$PANEL_DIR/orchestration.html
CONFIG_PATH=$PANEL_DIR/orchestration.config.js
META_PATH=$PANEL_DIR/orchestration.meta.json
INSTALLED_REFRESH_PS1=$SCRIPTS_DIR/refresh.ps1
INSTALLED_REFRESH_SH=$SCRIPTS_DIR/refresh.sh

write_vendored_copy "$SOURCE_PANEL" "$PANEL_PATH" "panel file"
write_vendored_copy "$SOURCE_REFRESH_PS1" "$INSTALLED_REFRESH_PS1" "refresh.ps1"
write_vendored_copy "$SOURCE_REFRESH_SH" "$INSTALLED_REFRESH_SH" "refresh.sh"
write_config_stub "$CONFIG_PATH" "$(basename -- "$TARGET_ROOT")"

if [ -e "$META_PATH" ]; then
  assert_no_git_segment "$META_PATH"
  assert_no_symlink_chain "$META_PATH"
fi

VERSION=$(get_panel_version "$PANEL_PATH")
printf '%s\n' "JARVIS: mission control wired at $PANEL_PATH"
printf '%s\n' "JARVIS: refresh with $INSTALLED_REFRESH_PS1 or $INSTALLED_REFRESH_SH"
printf '%s\n' 'JARVIS: serve the project over HTTP and open the panel in a browser'
printf '%s\n' "JARVIS: config lives at $CONFIG_PATH"
printf '%s\n' "JARVIS: panel version v$VERSION"
