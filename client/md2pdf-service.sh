#!/bin/bash
# md2pdf-service.sh — Convert Markdown to PDF with the md2pdf SERVICE
# (https://docs.helex.org/md2pdf/) instead of a local PDF engine.
#
# Usage: md2pdf-service.sh [options] INPUT.md [INPUT2.md …] [OUTPUT.pdf|OUTPUT_DIR/]
#   -t, --theme NAME     plain (default) | helex | helex-onepager | tervisekassa |
#                        taltech | site
#                        site = no service theme, pandoc's own styling
#                        (the live list: curl -s $MD2PDF_URL/themes)
#   -o, --output PATH    output PDF, or a directory to write it into
#   -d, --outdir DIR     output folder (default: the current folder); the file
#                        is named after the input, INPUT.md -> DIR/INPUT.pdf
#   --landscape          landscape pages
#   --paper FMT          A4 (default) | Letter | A3 | …
#   --css FILE           extra CSS, sent as options.css on top of the theme
#   --title TEXT         title for the theme's title block (default: the
#                        frontmatter title, else the first "# " heading, else
#                        the file name)
#   --site TEXT          site/organisation line for the title block
#   --date TEXT          date for the title block (default: today)
#   --logo FILE          logo image (png/jpg/svg/webp) for the theme's title
#                        block, sent inline as options.logo; no file = the
#                        theme's typographic mark
#   --url URL            service base URL (default: $MD2PDF_URL, else
#                        https://docs.helex.org/md2pdf)
#   --html-only          write the HTML that would be sent, and stop
#   -h, --help           show this help
#
# How it works: pandoc turns the Markdown into ONE self-contained HTML document
# (--embed-resources inlines local and remote images as data: URIs), and that is
# POSTed as JSON to $URL/pdf. The service fetches nothing — any asset not
# inlined here is simply missing from the PDF — so the inlining is the point.
#
# Mermaid: ```mermaid blocks are passed through as
# <div class="mermaid-diagram" data-src="…"> (md2pdf-service-mermaid.lua) and
# drawn by the service's own Mermaid. No mmdc or local Chrome needed.
#
# The public service is rate-limited (10 renders/min per address, burst 5) and
# takes bodies up to 20 MB; a 429 means wait a minute.
#
# Needs: pandoc, curl, jq.
#
# Examples:
#   md2pdf-service.sh spec.md                        # -> ./spec.pdf
#   md2pdf-service.sh -d ~/Desktop/pdf docs/*.md     # one PDF per input
#   md2pdf-service.sh --theme helex --site "HELEX Solutions" spec.md out/spec.pdf
#   md2pdf-service.sh --landscape --theme plain wide-tables.md
#   MD2PDF_URL=http://localhost:18509 md2pdf-service.sh doc.md   # local service
set -euo pipefail

# Resolve symlinks, so a link from /usr/local/bin (or ~/bin) still finds the
# helper files that sit next to the real script. Portable: no readlink -f.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
URL="${MD2PDF_URL:-https://docs.helex.org/md2pdf}"
THEME=plain
OUTPUT=""
OUTDIR="."
LANDSCAPE=false
PAPER=A4
CSS_FILE=""
TITLE=""
SITE=""
DATE="$(date +%Y-%m-%d)"
HTML_ONLY=0
INPUT=""
LOGO_FILE=""
POSITIONAL=()
PASSTHRU=()

usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "$0"; }
die() { echo "md2pdf-service: $*" >&2; exit 1; }

ARGS=(${@+"$@"})
i=0
while [ $i -lt ${#ARGS[@]} ]; do
  # Options (not -o/-d, which the per-file calls get explicitly) are recorded so
  # a multi-input run can hand them to each per-file call unchanged.
  case "${ARGS[$i]}" in
    -o|--output|-d|--outdir) i=$((i + 2)); continue ;;
    --output=*|--outdir=*) ;;
    -t|--theme|--paper|--css|--title|--site|--date|--url|--logo) PASSTHRU+=("${ARGS[$i]}" "${ARGS[$((i + 1))]}"); i=$((i + 2)); continue ;;
    -*) PASSTHRU+=("${ARGS[$i]}") ;;
  esac
  i=$((i + 1))
done

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--theme) THEME="$2"; shift 2 ;;
    --theme=*) THEME="${1#*=}"; shift ;;
    -o|--output) OUTPUT="$2"; shift 2 ;;
    --output=*) OUTPUT="${1#*=}"; shift ;;
    -d|--outdir) OUTDIR="$2"; shift 2 ;;
    --outdir=*) OUTDIR="${1#*=}"; shift ;;
    --landscape) LANDSCAPE=true; shift ;;
    --paper) PAPER="$2"; shift 2 ;;
    --paper=*) PAPER="${1#*=}"; shift ;;
    --css) CSS_FILE="$2"; shift 2 ;;
    --css=*) CSS_FILE="${1#*=}"; shift ;;
    --title) TITLE="$2"; shift 2 ;;
    --title=*) TITLE="${1#*=}"; shift ;;
    --site) SITE="$2"; shift 2 ;;
    --site=*) SITE="${1#*=}"; shift ;;
    --date) DATE="$2"; shift 2 ;;
    --date=*) DATE="${1#*=}"; shift ;;
    --logo) LOGO_FILE="$2"; shift 2 ;;
    --logo=*) LOGO_FILE="${1#*=}"; shift ;;
    --url) URL="$2"; shift 2 ;;
    --url=*) URL="${1#*=}"; shift ;;
    --html-only) HTML_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

# Positionals: inputs, then optionally one output — a *.pdf path or a folder
# (existing, or written with a trailing /).
if [ ${#POSITIONAL[@]} -ge 2 ]; then
  n=$((${#POSITIONAL[@]} - 1))
  last="${POSITIONAL[$n]}"
  case "$last" in
    *.pdf|*.PDF|*/) OUTPUT="$last"; unset "POSITIONAL[$n]" ;;
    *) if [ -d "$last" ]; then OUTPUT="$last"; unset "POSITIONAL[$n]"; fi ;;
  esac
fi
[ ${#POSITIONAL[@]} -gt 0 ] || { usage; exit 1; }

# Several inputs: one call per file into a folder. A single .pdf output cannot
# hold several documents, so it is refused rather than overwritten each time.
if [ ${#POSITIONAL[@]} -gt 1 ]; then
  if [ -n "$OUTPUT" ]; then
    case "$OUTPUT" in *.pdf|*.PDF) die "several inputs need an output folder, not $OUTPUT" ;; esac
    OUTDIR="$OUTPUT"
  fi
  rc=0
  for f in "${POSITIONAL[@]}"; do
    # ${X[@]+…}: bash 3.2 (macOS /bin/bash) calls an empty array unbound under set -u.
    "$0" ${PASSTHRU[@]+"${PASSTHRU[@]}"} -d "$OUTDIR" "$f" || rc=1
  done
  exit $rc
fi
INPUT="${POSITIONAL[0]}"

[ -f "$INPUT" ] || die "no such file: $INPUT"
for t in pandoc curl jq; do command -v "$t" >/dev/null || die "$t is not installed"; done
# pandoc 2.19+ (2022): --embed-resources, and a gfm reader that takes the
# yaml_metadata_block and fenced_divs extensions. Older ones fail half-way.
pv=$(pandoc --version | head -1 | sed -E 's/^pandoc(\.exe)? +//; s/[^0-9.].*$//')
pmaj=${pv%%.*}; prest=${pv#*.}; pmin=${prest%%.*}
if [ "${pmaj:-0}" -lt 2 ] || { [ "${pmaj:-0}" -eq 2 ] && [ "${pmin:-0}" -lt 19 ]; }; then
  die "pandoc $pv is too old; 2.19 or newer is needed (https://pandoc.org/installing.html)"
fi
[ -f "$SCRIPT_DIR/md2pdf-service-mermaid.lua" ] || die "md2pdf-service-mermaid.lua must sit next to this script ($SCRIPT_DIR)"
[ -z "$CSS_FILE" ] || [ -f "$CSS_FILE" ] || die "no such CSS file: $CSS_FILE"
[ -z "$LOGO_FILE" ] || [ -f "$LOGO_FILE" ] || die "no such logo file: $LOGO_FILE"
URL="${URL%/}"

# An explicit output (-o or the second positional) wins; otherwise the PDF goes
# into --outdir, which defaults to the current folder — not next to the input.
if [ -z "$OUTPUT" ]; then
  OUTPUT="${OUTDIR%/}/$(basename "${INPUT%.*}").pdf"
elif [ -d "$OUTPUT" ] || [ "${OUTPUT%/}" != "$OUTPUT" ]; then
  OUTPUT="${OUTPUT%/}/$(basename "${INPUT%.*}").pdf"
fi

# Title: frontmatter `title:`, else the first level-1 heading, else the file name.
if [ -z "$TITLE" ]; then
  TITLE=$(awk 'NR==1 && $0=="---"{fm=1; next} fm && $0=="---"{exit} fm && /^title:/{sub(/^title:[ \t]*/,""); gsub(/^["'\'']|["'\'']$/,""); print; exit}' "$INPUT")
fi
[ -n "$TITLE" ] || TITLE=$(grep -m1 -E '^# ' "$INPUT" | sed -E 's/^# +//; s/[[:space:]]+#*$//' || true)
[ -n "$TITLE" ] || TITLE=$(basename "${INPUT%.*}")

WORK=$(mktemp -d "${TMPDIR:-/tmp}/md2pdf-service.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# pandoc's own stylesheet only for theme=site; every other theme brings its own
# and the two would fight over margins and type — pandoc's caps the body at
# 36em, which squeezed every themed PDF into a narrow column and made wide
# tables run off the page. It must be -M (metadata, YAML false): with -V the
# value is the STRING "false", which a pandoc template treats as true.
DOC_CSS=true
[ "$THEME" = site ] || DOC_CSS=false

# Run from the input's directory so relative image paths resolve for embedding.
(
  cd "$(dirname "$INPUT")"
  pandoc "$(basename "$INPUT")" \
    --from gfm+yaml_metadata_block+fenced_divs \
    --to html5 --standalone --embed-resources \
    --lua-filter "$SCRIPT_DIR/md2pdf-service-mermaid.lua" \
    --metadata pagetitle="$TITLE" \
    -M document-css="$DOC_CSS" \
    -o "$WORK/doc.html"
) || die "pandoc failed"

# The filter writes data-md2pdf-src because pandoc's --embed-resources treats a
# data-src attribute as a URL and tries to fetch the diagram source. Renamed
# here, after embedding, to the attribute the service draws from.
sed -i.bak 's/ data-md2pdf-src="/ data-src="/g' "$WORK/doc.html"

mkdir -p "$(dirname "$OUTPUT")"
if [ "$HTML_ONLY" = 1 ]; then
  cp "$WORK/doc.html" "${OUTPUT%.pdf}.html"
  echo "wrote ${OUTPUT%.pdf}.html"
  exit 0
fi

# The body is built with jq from files, so no document content is ever
# interpolated into shell or JSON by hand.
# The service accepts a logo only as a data:image/ URI.
: > "$WORK/logo.uri"
if [ -n "$LOGO_FILE" ]; then
  case "$(printf '%s' "${LOGO_FILE##*.}" | tr '[:upper:]' '[:lower:]')" in
    png) mime=image/png ;; jpg|jpeg) mime=image/jpeg ;; svg) mime=image/svg+xml ;;
    webp) mime=image/webp ;; gif) mime=image/gif ;;
    *) die "logo must be png, jpg, svg, webp or gif: $LOGO_FILE" ;;
  esac
  printf 'data:%s;base64,%s' "$mime" "$(base64 < "$LOGO_FILE" | tr -d '\n')" > "$WORK/logo.uri"
fi
# Base CSS first (keeps wide tables/code from shrinking every page — see the
# file), then the caller's --css, which can override it.
cat "$SCRIPT_DIR/md2pdf-service-base.css" > "$WORK/extra.css" 2>/dev/null || : > "$WORK/extra.css"
[ -z "$CSS_FILE" ] || cat "$CSS_FILE" >> "$WORK/extra.css"
jq -n \
  --rawfile html "$WORK/doc.html" \
  --rawfile css "$WORK/extra.css" \
  --rawfile logo "$WORK/logo.uri" \
  --arg filename "$(basename "$OUTPUT")" \
  --arg title "$TITLE" --arg site "$SITE" --arg date "$DATE" \
  --arg theme "$THEME" --arg paper "$PAPER" --argjson landscape "$LANDSCAPE" \
  '{html: $html, filename: $filename, title: $title, site: $site, date: $date,
    options: ({theme: $theme, format: $paper, landscape: $landscape}
              + (if $css == "" then {} else {css: $css} end)
              + (if $logo == "" then {} else {logo: $logo} end))}' \
  > "$WORK/body.json"

SIZE=$(wc -c < "$WORK/body.json" | tr -d ' ')
[ "$SIZE" -le 20971520 ] || die "request is $((SIZE / 1048576)) MB; the public service takes 20 MB (large images?)"

STATUS=$(curl -sS -X POST "$URL/pdf" \
  -H 'Content-Type: application/json' \
  --data-binary @"$WORK/body.json" \
  -o "$WORK/out" -w '%{http_code}' --max-time 150) || die "could not reach $URL"

if [ "$STATUS" != 200 ]; then
  msg=$(jq -r '.error // empty' "$WORK/out" 2>/dev/null || true)
  [ -n "$msg" ] || msg=$(head -c 300 "$WORK/out")
  case "$STATUS" in
    429) die "HTTP 429 — rate limit or every render slot busy; retry in a minute" ;;
    *)   die "HTTP $STATUS — $msg" ;;
  esac
fi

mv "$WORK/out" "$OUTPUT"
echo "wrote $OUTPUT ($(wc -c < "$OUTPUT" | tr -d ' ') bytes, theme $THEME)"
