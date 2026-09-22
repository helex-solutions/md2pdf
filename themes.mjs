// Named document themes, ported from the `--format` presets of md2pdf.sh.
//
// A theme is a directory under themes/:
//
//   theme.css     the stylesheet
//   title.html    in-document title block, injected once at the top (optional)
//   header.html   Chromium running header  (optional)
//   footer.html   Chromium running footer  (optional)
//   theme.json    { label, description, options: { format, margin, scale, … } }
//
// title.html and header.html are different things and the distinction matters:
// the title block is ordinary body HTML that appears once on page 1, while the
// running header is drawn by Chromium into the page margin on EVERY page. The
// source presets carried the first as md2pdf-<name>-header.html and the second
// as @page margin boxes; keeping the names apart here stops them being merged.
//
// WHY THE TEMPLATES EXIST — this is the whole difficulty of the port. The source
// stylesheets are written for WeasyPrint and get their brand band, page numbers
// and confidentiality line from `@page` MARGIN BOXES:
//
//     @page { @bottom-right { content: "Page " counter(page) " of " counter(pages) } }
//
// Chromium implements none of that. Ported verbatim, a theme would lose its
// header and footer and do it SILENTLY — the PDF still renders, it is simply
// missing the furniture nobody checks for. So each theme's margin-box content
// lives in header.html / footer.html instead, which Chromium fills through
// `displayHeaderFooter`, and `counter(page)` becomes `<span class="pageNumber">`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeOptions } from './render.mjs'

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'themes')

/**
 * Extra theme directories, from `MD2PDF_THEMES_DIR` (colon-separated).
 *
 * A theme can carry another organisation's visual identity — its wordmark, its
 * palette, its postal address — and that does not belong in a public image just
 * because this service happens to render it. Such a theme is mounted into the
 * container instead:
 *
 *     -v /srv/brand-themes:/themes:ro  -e MD2PDF_THEMES_DIR=/themes
 *
 * Later directories win, so a mounted theme may also override a built-in one
 * without forking the image.
 */
function themeDirs() {
  const extra = (process.env.MD2PDF_THEMES_DIR || '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
  return [BUILTIN, ...extra]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

const read = (dir, file) => {
  const p = path.join(dir, file)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}

let cache = null

/** Every theme on disk — built-in first, then each MD2PDF_THEMES_DIR. */
export function loadThemes() {
  if (cache) return cache
  cache = new Map()
  for (const root of themeDirs()) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
    for (const name of fs.readdirSync(root).sort()) {
      const dir = path.join(root, name)
      if (!NAME.test(name)) continue
      let stat
      try {
        stat = fs.statSync(dir)
      } catch {
        continue // a broken symlink in a mounted directory is not fatal
      }
      if (!stat.isDirectory()) continue
      const css = read(dir, 'theme.css')
      if (css == null) continue
      let meta = {}
      try {
        meta = JSON.parse(read(dir, 'theme.json') || '{}')
      } catch {
        /* a malformed theme.json costs the metadata, not the theme */
      }
      cache.set(name, {
        name,
        label: meta.label || name,
        description: meta.description || '',
        options: meta.options || {},
        source: root === BUILTIN ? 'builtin' : root,
        css,
        title: read(dir, 'title.html'),
        header: read(dir, 'header.html'),
        footer: read(dir, 'footer.html')
      })
    }
  }
  return cache
}

/** Drop the cache — for tests, and for anything that changes MD2PDF_THEMES_DIR. */
export function resetThemes() {
  cache = null
}

/** `GET /themes` — also what lets a caller validate its config before a reader clicks. */
export function listThemes() {
  return [
    { name: 'site', label: 'Site', description: "The caller's own stylesheet; no theme applied.", options: {} },
    ...[...loadThemes().values()].map(({ name, label, description, options }) => ({
      name,
      label,
      description,
      options
    }))
  ]
}

export function getTheme(name) {
  if (!name || name === 'site') return null
  return loadThemes().get(String(name)) || undefined // undefined = named but unknown
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Fill a header/footer template.
 *
 * `{{logo}}` is an `<img>` built from a caller-supplied `data:` URI, or nothing.
 * The logos are deliberately NOT in the image: md2pdf.sh records that the
 * Tervisekassa mark is a trademark needing that body's approval, and the HELEX
 * one lives in a private Drive folder. A theme with no logo falls back to its
 * own typographic mark, which is what the templates' `{{logo}}`-less branches do.
 */
export function fillTemplate(tpl, { title = '', site = '', date = '', logo = null } = {}) {
  if (!tpl) return ''
  const img = logo && /^data:image\//i.test(logo) ? `<img class="logo" src="${esc(logo)}">` : ''
  return tpl
    .replace(/\{\{logo\}\}/g, img)
    .replace(/\{\{title\}\}/g, esc(title))
    .replace(/\{\{site\}\}/g, esc(site))
    .replace(/\{\{date\}\}/g, esc(date))
}

/**
 * Resolve a render request's theme into the CSS and templates to use.
 *
 * Order is theme → caller's extra CSS, so a deployment can adjust a theme
 * without forking it. A named-but-unknown theme is an ERROR rather than a
 * silent fall back to unstyled: a document that quietly lost its branding is
 * exactly the failure this module exists to prevent.
 */
export function resolveTheme(name, { css = '', title, site, date, logo } = {}) {
  const theme = getTheme(name)
  if (theme === undefined) {
    const known = ['site', ...loadThemes().keys()].join(', ')
    throw Object.assign(new Error(`unknown theme "${name}" — known: ${known}`), { status: 400 })
  }
  if (!theme) return { css, options: {}, titleBlock: '', headerTemplate: '', footerTemplate: '' }
  const ctx = { title, site, date, logo }
  return {
    css: `${theme.css}\n${css || ''}`,
    options: theme.options,
    titleBlock: fillTemplate(theme.title, ctx),
    headerTemplate: fillTemplate(theme.header, ctx),
    footerTemplate: fillTemplate(theme.footer, ctx)
  }
}

/**
 * Turn a request payload into what `Renderer.render` needs.
 *
 * ONE place decides the precedence — theme defaults under the caller's options,
 * and the theme's header/footer used only when the caller sent none. It is
 * exported (rather than living inside the request handler) because anything
 * that re-derives it drifts: the first copy of this logic in a test got the
 * order backwards and lost every theme's footer, which looks exactly like the
 * margin-box translation having failed.
 */
export function prepareRender(payload = {}) {
  const raw = payload.options || {}
  const theme = resolveTheme(raw.theme, {
    css: raw.css,
    title: payload.title,
    site: payload.site,
    date: payload.date,
    logo: raw.logo
  })
  const options = mergeOptions(theme.options, {
    ...raw,
    headerTemplate: raw.headerTemplate ?? theme.headerTemplate,
    footerTemplate: raw.footerTemplate ?? theme.footerTemplate
  })
  return { theme, options }
}
