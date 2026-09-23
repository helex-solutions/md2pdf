// md2pdf — an HTML -> PDF service.
//
//   GET  /         -> the API description (public/index.html)
//   GET  /health  -> { status, engine, version, busy, concurrency }
//   GET  /themes  -> [{ name, label, description, options }]
//   POST /pdf     -> application/pdf
//
// The full contract, and why mdbook talks to this over HTTP rather than
// rendering in-process, is in the generator's docs/pdf-design.md.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Renderer } from './render.mjs'
import { listThemes, prepareRender } from './themes.mjs'

const PORT = Number(process.env.MD2PDF_PORT || 18509)
const HOST = process.env.MD2PDF_HOST || '0.0.0.0'
const TOKEN = process.env.MD2PDF_TOKEN || null
const CONCURRENCY = Number(process.env.MD2PDF_CONCURRENCY || 2)
// A page of documentation is tens of KB; a book with inlined images is
// megabytes. The ceiling is what keeps one caller from making the service hold
// a whole filesystem in memory.
const MAX_BODY = Number(process.env.MD2PDF_MAX_BODY || 64 * 1024 * 1024)
// Where callers reach this service, as written into the API description's
// examples. A deployment behind a proxy sets its public URL, so a reader can
// copy an example and run it; the default is right for `docker run -p`.
const PUBLIC_URL = (process.env.MD2PDF_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')

// The API description, read once. A service whose root answers 404 tells whoever
// found it nothing; this one describes itself, which is most of what a reader
// arriving at a bare host and port actually wants.
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html')
let indexHtml = null
function apiDescription() {
  if (indexHtml === null) {
    try {
      indexHtml = renderIndex(fs.readFileSync(INDEX, 'utf8'), PUBLIC_URL)
    } catch {
      indexHtml = false // not installed — the endpoints still work
    }
  }
  return indexHtml
}

const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The page with every {{PUBLIC_URL}} replaced by the (escaped) base URL. */
export function renderIndex(html, publicUrl) {
  return html.replaceAll('{{PUBLIC_URL}}', escapeHtml(publicUrl))
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

// Constant-time compare, so a token cannot be recovered a byte at a time.
function tokenOk(req) {
  if (!TOKEN) return true
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) return false
  const a = Buffer.from(m[1])
  const b = Buffer.from(TOKEN)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`body over ${MAX_BODY} bytes`), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// The ASCII fallback for Content-Disposition. Anything that could break out of
// the header (quotes, CR/LF, path separators) is dropped rather than escaped,
// and non-ASCII is flattened — `filename*` below carries the real name.
export function safeFilename(name) {
  const base = String(name || 'document')
    .replace(/[\r\n"\\/]+/g, '')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/[\s-]{2,}/g, '-')
    .replace(/^[-.\s]+/, '')
    .slice(0, 120)
    .trim()
  const clean = base || 'document'
  return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`
}

/**
 * Content-Disposition carrying BOTH forms (RFC 6266 / RFC 5987).
 *
 * `filename=` is the flattened ASCII name every client understands;
 * `filename*=UTF-8''…` is the real one. Without the second, a Lithuanian or
 * Czech title arrives as a row of dashes — which is what the wiki's own export
 * does today, and the reason this is not left to the caller.
 */
export function contentDisposition(name) {
  const ascii = safeFilename(name)
  const utf8 = String(name || 'document').replace(/[\r\n"\\/]+/g, '').trim() || 'document'
  const full = utf8.toLowerCase().endsWith('.pdf') ? utf8 : `${utf8}.pdf`
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`
}

export function createHandler(renderer) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://internal')

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = apiDescription()
      if (!html) return json(res, 404, { error: 'not found' })
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'public, max-age=300'
      })
      return res.end(html)
    }

    if (url.pathname === '/health') {
      try {
        const version = await renderer.version()
        return json(res, 200, {
          status: 'ok',
          engine: 'chromium',
          version,
          busy: renderer.busy,
          concurrency: renderer.concurrency
        })
      } catch (e) {
        return json(res, 503, { status: 'error', error: String(e?.message || e) })
      }
    }

    // Listed so a caller can validate its configured theme at BUILD time rather
    // than at the moment a reader clicks a button.
    if (url.pathname === '/themes') {
      if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, { themes: listThemes() })
    }

    if (url.pathname !== '/pdf') return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, e.status || 400, { error: String(e?.message || e) })
    }

    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return json(res, 400, { error: 'body is not JSON' })
    }
    if (typeof payload.html !== 'string' || !payload.html.trim()) {
      return json(res, 400, { error: 'html is required' })
    }

    const raw = payload.options || {}
    let prepared
    try {
      // A named-but-unknown theme is a 400, never a silent unstyled render:
      // a document that quietly lost its branding is the failure this exists
      // to prevent, and it is invisible in the output.
      prepared = prepareRender(payload)
    } catch (e) {
      return json(res, e.status || 400, { error: String(e?.message || e) })
    }

    try {
      const started = Date.now()
      const { theme, options } = prepared
      const pdf = await renderer.render(payload.html, options, theme)
      const filename = safeFilename(payload.filename)
      console.log(
        `rendered ${filename} [${raw.theme || 'site'} ${options.format}${options.landscape ? ' landscape' : ''}] ` +
          `${pdf.length} bytes in ${Date.now() - started}ms`
      )
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': contentDisposition(payload.filename),
        'Cache-Control': 'no-store'
      })
      return res.end(Buffer.from(pdf))
    } catch (e) {
      console.error('render failed:', e?.message || e)
      return json(res, e?.status || 500, { error: String(e?.message || e) })
    }
  }
}

export function createServer({ concurrency = CONCURRENCY } = {}) {
  const renderer = new Renderer({ concurrency })
  const server = http.createServer(createHandler(renderer))
  server.on('close', () => renderer.close())
  return { server, renderer }
}

// Started directly (not imported by a test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { server, renderer } = createServer()
  server.listen(PORT, HOST, () => {
    console.log(`md2pdf listening on http://${HOST}:${PORT} (concurrency ${CONCURRENCY}${TOKEN ? ', token required' : ''})`)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      server.close()
      await renderer.close()
      process.exit(0)
    })
  }
}
