# md2pdf

An HTML → PDF service. It takes a **self-contained** HTML document and prints it
with headless Chromium.

It is what [mdbook](https://github.com/helex-solutions/mdbook)'s `mdbook serve`
calls to answer `GET {base}pdf` — but it knows nothing about mdbook beyond two
markup conventions (below), so it is usable on its own. The design, and why the
renderer is a separate process at all, is in mdbook's
[`docs/pdf-design.md`](https://github.com/helex-solutions/mdbook/blob/main/docs/pdf-design.md).

The wiki's own export (helex-tx `OWLIKI.06`) is expected to move onto this
service too, which is why the contract takes a complete styled HTML document
rather than anything mdbook-shaped.

## Run it

```bash
docker run -d --name md2pdf --restart unless-stopped \
  -p 127.0.0.1:18509:18509 ghcr.io/helex-solutions/md2pdf
```

Alongside a docs container it needs no published port at all — see mdbook's
[`docker-compose.example.yml`](https://github.com/helex-solutions/mdbook/blob/main/docker-compose.example.yml).

**Port 18509** comes from the tx/emr port map (`emr-repo`
`docs/development/port-map.md`): 184xx backend services, 185xx infrastructure,
186xx frontend dev servers. This is shared infrastructure.

Locally, with a Chrome or Chromium already on the machine:

```bash
npm install
node server.mjs
```

`MD2PDF_CHROMIUM` names the binary; without it the usual Linux and macOS paths
are tried, and `/health` answers 503 if none is found.

## API

### `GET /themes`

```json
{ "themes": [ { "name": "helex", "label": "HELEX document", "options": { "format": "A4", "margin": {"top": "38mm"} } } ] }
```

Listed so a caller can validate its configured theme when it builds, rather than
when a reader clicks.

### `GET /health`

```json
{ "status": "ok", "engine": "chromium", "version": "141.0.7390.54", "busy": 0, "concurrency": 2 }
```

503 when no browser can be launched.

### `POST /pdf` → `application/pdf`

```bash
curl -sS -X POST http://localhost:18509/pdf \
  -H 'Content-Type: application/json' \
  -d '{"html":"<h1>Hello</h1>","filename":"hello.pdf"}' \
  -o hello.pdf
```

| Field | Default | Meaning |
|---|---|---|
| `html` | — | required; a complete HTML document |
| `filename` | `document.pdf` | `Content-Disposition` name; sanitized |
| `options.format` | `A4` | paper size |
| `options.landscape` | `false` | |
| `options.margin` | `18mm` / `16mm` / `20mm` / `16mm` | top, right, bottom, left — CSS lengths |
| `options.scale` | `1` | 0.1–2 |
| `options.theme` | `site` | a name from `GET /themes`; an unknown one is a 400 |
| `options.css` | — | extra CSS, appended after the theme's |
| `options.logo` | — | a `data:` image URI substituted into the theme's title block |
| `options.printBackground` | `true` | callout tints and table header fills are meaning, not decoration |
| `options.headerTemplate`, `options.footerTemplate` | — | Chromium header/footer HTML (`pageNumber`, `totalPages`, `title` classes) |
| `options.timeout` | `30000` | ms, clamped to 120000 |

Errors come back as JSON: 400 malformed, 401 bad token, 413 body too large,
429 every render slot busy, 500 render failed, 503 no browser.

## Configuration

| Variable | Default | |
|---|---|---|
| `MD2PDF_PORT` | `18509` | |
| `MD2PDF_HOST` | `0.0.0.0` | |
| `MD2PDF_TOKEN` | unset | when set, every request needs `Authorization: Bearer <token>` |
| `MD2PDF_CONCURRENCY` | `2` | renders in flight; the rest queue, then 429 |
| `MD2PDF_MAX_BODY` | `67108864` | request body ceiling (64 MB) |
| `MD2PDF_CHROMIUM` | auto | path to the browser binary |
| `MD2PDF_THEMES_DIR` | unset | extra theme directories, colon-separated (see Themes) |
| `MD2PDF_PUBLIC_URL` | `http://localhost:<port>` | base URL written into the API description's examples (`GET /`); set it behind a proxy |

## Themes

`options.theme` names one, ported from the `--format` presets of `md2pdf.sh`:

| Name | |
|---|---|
| `site` (default) | no theme — the caller's document is already styled |
| `plain` | unstyled baseline: readable type, sane tables, paged-media rules |
| `helex` | HELEX multi-page document — green band, per-page footer, confidentiality line |
| `helex-onepager` | HELEX fact-sheet — tighter margins, denser typography |

More can be **mounted** — see below.

A theme is a directory under `themes/`:

```
themes/<name>/  theme.css  title.html  header.html  footer.html  theme.json
```

`title.html` is an in-document title block that appears once, on page 1.
`header.html` / `footer.html` are drawn by Chromium into the page margin on
**every** page — a different thing, kept under a different name on purpose.
`theme.json` carries the page box the stylesheet was drawn for; those values are
defaults, under whatever the caller asks for.

### Mounting your own

`MD2PDF_THEMES_DIR` names extra directories (colon-separated) scanned after the
built-ins, so a deployment adds themes without forking the image — and a mounted
theme sharing a name with a built-in one **wins**, which is how you adjust a
shipped theme in place.

```yaml
services:
  md2pdf:
    image: ghcr.io/helex-solutions/md2pdf:latest
    volumes:
      - ./brand-themes:/themes:ro
    environment:
      MD2PDF_THEMES_DIR: /themes
```

This is where a theme carrying **someone else's visual identity** belongs. A
wordmark, a palette taken from a brand manual and a postal address are that
organisation's, and putting them in a public image would let anyone render a
document that looks as though it came from them. `helex-solutions/md2pdf-themes`
(private) holds the ones this project maintains, with a `check-themes.mjs` that
asserts the invariants below.

A directory that does not exist is ignored rather than fatal, so a volume that
failed to mount does not take the renderer down with it.

### Why the port is a translation

The source stylesheets are written for **WeasyPrint** and get their brand band,
page numbers and confidentiality line from `@page` **margin boxes**:

```css
@page { @bottom-right { content: "Page " counter(page) " of " counter(pages); } }
```

Chromium implements none of that. Ported verbatim a theme keeps rendering — it
just silently loses its furniture. So margin-box content is re-authored as
`header.html` / `footer.html`, and `counter(page)` becomes
`<span class="pageNumber">`. Two further WeasyPrint-isms had to go, both found by
rendering and looking rather than by reading:

- **`@page` written inside a comment.** `md2pdf-helex.css` says "Weasyprint draws
  `@page` borders…" in prose; a scanner that matched it and consumed to the next
  braced block deleted the `html, body` typography rule, and the whole document
  came out in Times.
- **`@font-face` with only `local()` sources.** WeasyPrint resolves those against
  installed fonts; Chromium cannot — and because the rule still *defines* the
  family, a failed match drops to the generic default instead of falling through
  the stack. Removing the rule leaves the family list to say what it meant.

`tools/port-themes.mjs` re-runs the port and is the record of both.

Logos are **not** in the image — the Tervisekassa mark is a trademark needing
that body's approval, and the HELEX one is not public. Pass `options.logo` as a
`data:` URI; without one a theme keeps its typographic mark.

## What it does to the document

Two mdbook-shaped conventions, and nothing else:

- `.mermaid-diagram[data-src]` — drawn with the bundled Mermaid, using
  `securityLevel: 'strict'` and `htmlLabels: false`, because diagram source is
  page content.
- `.mdbook-pdf-frame` — an inline PDF preview iframe cannot be printed, so the
  caller replaces it with a link before sending.

## The renderer fetches nothing

Every network request the loaded page makes is **aborted**; only `data:` URIs
resolve. Documents arrive self-contained, so there is nothing legitimate to
fetch — and an `<img src="http://…">` written into a wiki page therefore cannot
become a request made from inside the deployment's network.

That is the security boundary this service rests on, along with one browser
context per render, an unprivileged user, and a hard render timeout. What an
open endpoint therefore exposes is cost, not reach: keep it on a private
network, set `MD2PDF_TOKEN`, or put it behind a proxy that rate-limits renders
and caps the body size (docs.helex.org/md2pdf/ does the last).
