#!/usr/bin/env bash
# scripts/design-qa.sh — nightly Foundation design-QA sweep (PRD.md Phase B,
# success criterion #2: "a cron bee answers 'which open documents changed
# visually this week, and do any violate the design system?' unattended,
# every night").
#
# For every boards/*.fdn.html: validate (collect issues), bake (collect
# conformance error/warning counts), render every matrix state to a dated
# directory under ~/.hive/foundation-qa/<YYYY-MM-DD>/, and pixel-diff each
# rendered PNG against the previous run's same-named PNG (via
# scripts/pixel-diff.ts, a thin wrapper over foundation-engine's
# visualDiff). Writes docs/dogfood/qa/<YYYY-MM-DD>.md.
#
# Self-contained: every path below is absolute, so this runs the same from
# an interactive shell, cron, launchd, or a Pollinate command action — no
# dependency on cwd, a dev-session PATH, or a workspace being open.
#
# Contract: exits 0 on success regardless of findings — a board that fails
# to validate, bake, or render is a FAIL *row* in the report, not a script
# failure. Only a genuinely unrecoverable setup problem (repo missing,
# foundation binary missing) is worth a nonzero exit, and even then this
# script still tries to leave a report behind first.
#
# Idempotent per day: re-running on the same date overwrites that date's
# render dir and report in place; the "previous run" comparison always
# excludes today's own directory, so a same-day re-run compares against
# the last *prior* day's run, not itself.

set -uo pipefail

# ——— fixed, absolute environment (no dependency on the invoking session) ———
REPO_ROOT="/Users/trmd/Projects/honeybee/foundation/repos/foundation"
FOUNDATION_BIN="/Users/trmd/.local/bin/foundation"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
PIXEL_DIFF="$REPO_ROOT/scripts/pixel-diff.ts"
BOARDS_DIR="$REPO_ROOT/boards"
QA_ROOT="/Users/trmd/.hive/foundation-qa"
REPORT_DIR="$REPO_ROOT/docs/dogfood/qa"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"

VALIDATE_TIMEOUT=60
BAKE_TIMEOUT=60
RENDER_TIMEOUT=300

DATE="$(date +%Y-%m-%d)"
RUN_DIR="$QA_ROOT/$DATE"
REPORT_FILE="$REPORT_DIR/$DATE.md"

# `timeout` (GNU coreutils) is expected on this machine (brew coreutils);
# degrade to running the command unbounded rather than failing the whole
# script if it's ever missing from PATH.
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

if [ ! -d "$REPO_ROOT" ]; then
  echo "design-qa.sh: repo root missing: $REPO_ROOT" >&2
  exit 0
fi
if [ ! -x "$FOUNDATION_BIN" ]; then
  echo "design-qa.sh: foundation binary missing or not executable: $FOUNDATION_BIN" >&2
  exit 0
fi

mkdir -p "$RUN_DIR" "$REPORT_DIR"

# Most recent prior dated run dir under QA_ROOT, excluding today's own dir —
# so a same-day re-run diffs against yesterday, not itself.
PREV_DIR=""
if [ -d "$QA_ROOT" ]; then
  PREV_DIR=$(find "$QA_ROOT" -maxdepth 1 -type d -name '20*' 2>/dev/null \
    | grep -v "^$RUN_DIR\$" \
    | sort \
    | tail -1)
fi

DETAIL_TMP="$(mktemp)"
SUMMARY_TMP="$(mktemp)"
trap 'rm -f "$DETAIL_TMP" "$SUMMARY_TMP"' EXIT

TOTAL_BOARDS=0
PASS_BOARDS=0
FAIL_BOARDS=0
CHANGED_BOARDS=0
SUM_VALIDATE_ERRORS=0
SUM_CONFORMANCE_ERRORS=0
SUM_CONFORMANCE_WARNINGS=0
SUM_CHANGED_STATES=0
SUM_NEW_STATES=0
SUM_STATES=0

shopt -s nullglob
BOARD_FILES=("$BOARDS_DIR"/*.fdn.html)
shopt -u nullglob

for board in "${BOARD_FILES[@]}"; do
  TOTAL_BOARDS=$((TOTAL_BOARDS + 1))
  name="$(basename "$board" .fdn.html)"
  board_dir="$RUN_DIR/$name"
  mkdir -p "$board_dir"

  board_status="PASS"
  board_notes=()

  # ——— 1. validate ———
  validate_out="$(run_with_timeout "$VALIDATE_TIMEOUT" "$FOUNDATION_BIN" validate "$board" 2>&1)"
  validate_exit=$?
  validate_issues=0
  validate_errors=0
  if [ $validate_exit -ge 2 ] && [ $validate_exit -ne 1 ]; then
    board_status="FAIL"
    board_notes+=("validate: could not run (exit $validate_exit)")
  elif echo "$validate_out" | grep -q ': no issues$'; then
    validate_issues=0
    validate_errors=0
  else
    summary_line="$(echo "$validate_out" | grep -E ': [0-9]+ issue\(s\), [0-9]+ error\(s\)$' | tail -1)"
    validate_issues="$(echo "$summary_line" | sed -E 's/.*: ([0-9]+) issue\(s\).*/\1/')"
    validate_errors="$(echo "$summary_line" | sed -E 's/.*, ([0-9]+) error\(s\)$/\1/')"
    [ -z "$validate_issues" ] && validate_issues=0
    [ -z "$validate_errors" ] && validate_errors=0
  fi
  SUM_VALIDATE_ERRORS=$((SUM_VALIDATE_ERRORS + validate_errors))

  # ——— 2. bake (conformance error/warning counts) ———
  bake_err_file="$(mktemp)"
  run_with_timeout "$BAKE_TIMEOUT" "$FOUNDATION_BIN" bake "$board" -o "$board_dir/baked.html" \
    >/dev/null 2>"$bake_err_file"
  bake_exit=$?
  bake_errors=0
  bake_warnings=0
  if [ $bake_exit -ne 0 ]; then
    board_status="FAIL"
    board_notes+=("bake: failed (exit $bake_exit)")
  else
    bake_errors="$(grep -c '^error ' "$bake_err_file" || true)"
    bake_warnings="$(grep -c '^warning ' "$bake_err_file" || true)"
  fi
  rm -f "$bake_err_file"
  SUM_CONFORMANCE_ERRORS=$((SUM_CONFORMANCE_ERRORS + bake_errors))
  SUM_CONFORMANCE_WARNINGS=$((SUM_CONFORMANCE_WARNINGS + bake_warnings))

  # ——— 3. render every matrix state ———
  render_out_file="$(mktemp)"
  run_with_timeout "$RENDER_TIMEOUT" "$FOUNDATION_BIN" render "$board" -o "$board_dir" \
    >"$render_out_file" 2>&1
  render_exit=$?
  if [ $render_exit -ne 0 ]; then
    board_status="FAIL"
    board_notes+=("render: failed (exit $render_exit) — $(tail -1 "$render_out_file" | tr -d '\n')")
  fi
  rm -f "$render_out_file"

  # ——— 4. pixel-diff every rendered PNG against the previous run ———
  {
    echo ""
    echo "### $name"
    echo ""
    echo "- validate: $validate_issues issue(s), $validate_errors error(s)"
    echo "- bake conformance: $bake_errors error(s), $bake_warnings warning(s)"
    if [ ${#board_notes[@]} -gt 0 ]; then
      for note in "${board_notes[@]}"; do
        echo "- **$note**"
      done
    fi
  } >> "$DETAIL_TMP"

  board_states=0
  board_changed=0
  board_new=0
  state_rows=""

  shopt -s nullglob
  png_files=("$board_dir"/*.png)
  shopt -u nullglob

  if [ ${#png_files[@]} -gt 0 ]; then
    state_rows="| state--viewport | vs previous | diff px | verdict |\n|---|---|---|---|\n"
    for png in "${png_files[@]}"; do
      board_states=$((board_states + 1))
      SUM_STATES=$((SUM_STATES + 1))
      label="$(basename "$png" .png)"
      prev_png=""
      if [ -n "$PREV_DIR" ] && [ -f "$PREV_DIR/$name/$label.png" ]; then
        prev_png="$PREV_DIR/$name/$label.png"
      fi

      if [ -z "$prev_png" ]; then
        verdict="NEW"
        diffpixels="-"
        vs="(none)"
        board_new=$((board_new + 1))
        SUM_NEW_STATES=$((SUM_NEW_STATES + 1))
      else
        vs="$(basename "$PREV_DIR")"
        diff_json="$(run_with_timeout 30 "$TSX_BIN" "$PIXEL_DIFF" "$prev_png" "$png" 2>/dev/null)"
        diff_exit=$?
        if [ $diff_exit -ne 0 ] || [ -z "$diff_json" ]; then
          verdict="DIFF-ERROR"
          diffpixels="-"
        else
          identical="$(echo "$diff_json" | grep -o '"identical":[a-z]*' | cut -d: -f2)"
          diffpixels="$(echo "$diff_json" | grep -o '"diffPixels":[0-9]*' | cut -d: -f2)"
          [ -z "$diffpixels" ] && diffpixels="-"
          if [ "$identical" = "true" ]; then
            verdict="UNCHANGED"
          else
            verdict="CHANGED"
            board_changed=$((board_changed + 1))
            SUM_CHANGED_STATES=$((SUM_CHANGED_STATES + 1))
          fi
        fi
      fi
      state_rows="${state_rows}| $label | $vs | $diffpixels | $verdict |\n"
    done
  fi

  if [ $board_states -gt 0 ]; then
    {
      echo ""
      printf "%b" "$state_rows"
    } >> "$DETAIL_TMP"
  else
    echo "" >> "$DETAIL_TMP"
    echo "- states: none rendered" >> "$DETAIL_TMP"
  fi

  if [ "$board_status" = "PASS" ]; then
    PASS_BOARDS=$((PASS_BOARDS + 1))
  else
    FAIL_BOARDS=$((FAIL_BOARDS + 1))
  fi

  if [ $board_changed -gt 0 ]; then
    CHANGED_BOARDS=$((CHANGED_BOARDS + 1))
    board_verdict="CHANGED"
  elif [ $board_new -gt 0 ] && [ $board_states -eq $board_new ]; then
    board_verdict="NEW"
  elif [ $board_states -gt 0 ]; then
    board_verdict="UNCHANGED"
  else
    board_verdict="-"
  fi

  echo "| $name | $board_status | $validate_issues issue(s), $validate_errors err | $bake_errors/$bake_warnings | $board_states | $board_changed | $board_verdict |" >> "$SUMMARY_TMP"
done

PREV_LABEL="none — first run"
if [ -n "$PREV_DIR" ]; then
  PREV_LABEL="$(basename "$PREV_DIR")"
fi

HEADLINE="Foundation design QA $DATE: $TOTAL_BOARDS board(s), $PASS_BOARDS pass/$FAIL_BOARDS fail, $CHANGED_BOARDS board(s) changed vs $PREV_LABEL, $SUM_VALIDATE_ERRORS validate error(s), $SUM_CONFORMANCE_ERRORS conformance error(s)/$SUM_CONFORMANCE_WARNINGS warning(s)"

{
  echo "# Foundation design QA — $DATE"
  echo ""
  echo "**HEADLINE:** $HEADLINE"
  echo ""
  echo "- Run dir: $RUN_DIR"
  echo "- Compared against: $([ -n "$PREV_DIR" ] && echo "$PREV_DIR" || echo "none (first run)")"
  echo "- States rendered: $SUM_STATES ($SUM_NEW_STATES new, $SUM_CHANGED_STATES changed, $((SUM_STATES - SUM_NEW_STATES - SUM_CHANGED_STATES)) unchanged)"
  echo ""
  echo "## Summary"
  echo ""
  echo "| Board | Status | Validate | Conformance (err/warn) | States | Changed | Verdict |"
  echo "|---|---|---|---|---|---|---|"
  cat "$SUMMARY_TMP"
  echo ""
  echo "## Detail"
  cat "$DETAIL_TMP"
} > "$REPORT_FILE"

echo "design-qa.sh: wrote $REPORT_FILE" >&2
echo "$HEADLINE"

exit 0
