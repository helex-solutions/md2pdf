import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listThemes, getTheme, resolveTheme, fillTemplate, resetThemes } from '../themes.mjs'
import { mergeOptions, normalizeOptions } from '../render.mjs'
import { safeFilename, contentDisposition } from '../server.mjs'

const THEMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'themes')
const named = () => listThemes().filter((t) => t.name !== 'site')

test('every built-in theme is listed, with site first', () => {
  resetThemes()
  const list = listThemes()
  assert.equal(list[0].name, 'site')
  const onDisk = fs.readdirSync(THEMES_DIR).filter((d) => fs.statSync(path.join(THEMES_DIR, d)).isDirectory())
  assert.deepEqual(
    list.slice(1).map((t) => t.name).sort(),
    onDisk.sort()
  )
})

test('an unknown theme is an error, not a silent unstyled render', () => {
  // The whole point: a document that quietly lost its branding looks fine and
  // is wrong, so this must fail loudly at the request rather than at the eye.
  assert.throws(() => resolveTheme('helx'), (e) => e.status === 400 && /unknown theme/.test(e.message))
  assert.equal(getTheme('site'), null)
  assert.equal(getTheme(''), null)
})

test("site theme passes the caller's css through untouched", () => {
  const r = resolveTheme('site', { css: 'p{color:red}' })
  assert.equal(r.css, 'p{color:red}')
  assert.equal(r.headerTemplate, '')
  assert.equal(r.titleBlock, '')
})

test("a theme's css comes first so the caller's extra css can override it", () => {
  const r = resolveTheme('plain', { css: '/*MINE*/' })
  assert.ok(r.css.indexOf('/*MINE*/') > r.css.indexOf('--md2pdf-scale'))
})

// The port's failure mode is silence: Chromium renders happily without the
// furniture, so only an assertion catches a theme that lost it.
test('every named theme keeps its page number through the margin-box translation', () => {
  for (const { name } of named()) {
    const t = getTheme(name)
    const furniture = `${t.header || ''}${t.footer || ''}`
    assert.match(furniture, /class="pageNumber"/, `${name} has no pageNumber span`)
    assert.match(furniture, /class="totalPages"/, `${name} has no totalPages span`)
  }
})

test('no theme stylesheet still relies on a WeasyPrint-only construct', () => {
  for (const { name } of named()) {
    const css = getTheme(name).css
    // Strip comments — they legitimately DESCRIBE what was removed.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(code, /@page/, `${name}: @page survived into the stylesheet`)
    assert.doesNotMatch(code, /counter\(\s*pages?\s*\)/, `${name}: counter(page) survived`)
    assert.doesNotMatch(code, /@(top|bottom)-(left|center|right)/, `${name}: a margin box survived`)
  }
})

test('no theme declares a font family it cannot load', () => {
  // A local()-only @font-face DEFINES the family, so a failed match drops to the
  // generic default instead of falling through the stack — this is what rendered
  // the whole HELEX document in Times.
  for (const { name } of named()) {
    for (const m of getTheme(name).css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      assert.match(m[0], /url\s*\(/, `${name}: @font-face with only local() sources`)
    }
  }
})

test('a theme that ships a page box declares it in theme.json, not in css', () => {
  for (const { name, options } of named()) {
    assert.ok(options.format, `${name} has no format`)
    assert.ok(options.margin?.top, `${name} has no top margin`)
  }
})

test('theme options are defaults under the caller, and margins merge per side', () => {
  const theme = { format: 'A4', margin: { top: '38mm', right: '18mm', bottom: '22mm', left: '18mm' } }
  const merged = mergeOptions(theme, { landscape: true, margin: { top: '10mm' }, format: undefined })
  assert.equal(merged.format, 'A4') // undefined does not override
  assert.equal(merged.landscape, true)
  assert.deepEqual(merged.margin, { top: '10mm', right: '18mm', bottom: '22mm', left: '18mm' })
})

test('a logo is substituted only from a data: URI', () => {
  const tpl = '<div>{{logo}}|{{title}}</div>'
  assert.match(fillTemplate(tpl, { logo: 'data:image/png;base64,AAA', title: 'T' }), /<img class="logo"/)
  // Anything else would be a URL the renderer is forbidden to fetch anyway, so
  // it degrades to the theme's typographic mark rather than a broken image.
  assert.match(fillTemplate(tpl, { logo: 'https://example.org/l.png' }), /<div>\|<\/div>/)
  assert.match(fillTemplate(tpl, { title: '<script>' }), /&lt;script&gt;/)
})

test('render options are validated, not passed through', () => {
  const o = normalizeOptions({
    format: 'A4; rm -rf',
    scale: 99,
    margin: { top: '1cm', right: 'expression(evil)' },
    timeout: 10 ** 9
  })
  assert.equal(o.format, 'A4') // rejected -> default
  assert.equal(o.scale, 2) // clamped
  assert.equal(o.margin.top, '1cm')
  assert.equal(o.margin.right, '16mm') // rejected -> default
  assert.equal(o.timeout, 120000) // clamped
})

test('a filename cannot break out of the Content-Disposition header', () => {
  // A header injection attempt loses its CR/LF and its colon, so it can only
  // ever be a filename.
  const injected = safeFilename('a"b\r\nX: y')
  assert.equal(injected, 'abX-y.pdf')
  assert.doesNotMatch(injected, /[\r\n"]/)
  assert.equal(safeFilename('../../etc/passwd'), 'etcpasswd.pdf')
  assert.equal(safeFilename(''), 'document.pdf')
  assert.equal(safeFilename('report.pdf'), 'report.pdf')
  assert.equal(safeFilename('Module dependencies'), 'Module dependencies.pdf')
})

test('a non-ASCII title survives in filename*, not just as dashes', () => {
  const cd = contentDisposition('Propouštěcí zpráva')
  // The ASCII fallback is unavoidably lossy — that is what filename* is for.
  assert.match(cd, /filename="Propou-t-c-\s?zpr-va\.pdf"|filename="[\w.\- ]+\.pdf"/)
  assert.ok(cd.includes("filename*=UTF-8''"))
  const encoded = /filename\*=UTF-8''(\S+)/.exec(cd)[1]
  assert.equal(decodeURIComponent(encoded), 'Propouštěcí zpráva.pdf')
  assert.doesNotMatch(cd, /[\r\n]/)
})

test('a mounted theme directory adds themes, and may override a built-in one', () => {
  // A theme can carry another organisation's wordmark, palette and address.
  // That does not belong in a public image just because this service renders
  // it, so such a theme is mounted at run time instead of baked in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-themes-'))
  fs.mkdirSync(path.join(dir, 'acme'))
  fs.writeFileSync(path.join(dir, 'acme', 'theme.css'), 'body{color:#abcdef}')
  fs.writeFileSync(
    path.join(dir, 'acme', 'theme.json'),
    JSON.stringify({ label: 'Acme', options: { format: 'A4', margin: { top: '9mm' } } })
  )
  fs.writeFileSync(path.join(dir, 'acme', 'footer.html'), '<span class="pageNumber"></span>')
  // Same name as a built-in: the mounted one wins, so a deployment can adjust
  // a theme without forking the image.
  fs.mkdirSync(path.join(dir, 'plain'))
  fs.writeFileSync(path.join(dir, 'plain', 'theme.css'), '/*OVERRIDDEN*/')

  const prev = process.env.MD2PDF_THEMES_DIR
  process.env.MD2PDF_THEMES_DIR = dir
  resetThemes()
  try {
    const names = listThemes().map((t) => t.name)
    assert.ok(names.includes('acme'), 'the mounted theme was not picked up')
    assert.equal(getTheme('acme').label, 'Acme')
    assert.equal(getTheme('acme').options.margin.top, '9mm')
    assert.match(getTheme('plain').css, /OVERRIDDEN/)
    // Still an error for a name nobody provides, mounted or not.
    assert.throws(() => resolveTheme('nope'), (e) => e.status === 400)
  } finally {
    if (prev === undefined) delete process.env.MD2PDF_THEMES_DIR
    else process.env.MD2PDF_THEMES_DIR = prev
    resetThemes()
  }
})

test('a missing or unreadable mounted directory is ignored, not fatal', () => {
  const prev = process.env.MD2PDF_THEMES_DIR
  process.env.MD2PDF_THEMES_DIR = '/nonexistent/themes'
  resetThemes()
  try {
    // The built-ins still load: a volume that failed to mount must not take the
    // whole renderer down.
    assert.ok(listThemes().length > 1)
  } finally {
    if (prev === undefined) delete process.env.MD2PDF_THEMES_DIR
    else process.env.MD2PDF_THEMES_DIR = prev
    resetThemes()
  }
})

test('the root serves the API description, and it describes what is really there', async () => {
  const http = await import('node:http')
  const { createHandler } = await import('../server.mjs')
  const { Renderer } = await import('../render.mjs')
  const server = http.createServer(createHandler(new Renderer({ concurrency: 1 })))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    const html = await res.text()
    // A page that documents endpoints this service does not have is worse than
    // no page, so the four it claims are the four that exist.
    for (const p of ['/health', '/themes', '/pdf']) {
      assert.ok(html.includes(`>${p}<`), `the page does not mention ${p}`)
    }
    // Self-contained: it is served from a container with no egress, so a
    // stylesheet or image it cannot fetch would render as a broken page.
    // Real tags only — the security note quotes an escaped <img src="http…">
    // as prose, and that is text, not a reference.
    assert.equal(/<(script|link)\b/i.test(html), false, 'the page loads an external resource')
    assert.equal(/<[a-z]+[^>]*\ssrc="https?:/i.test(html), false, 'the page references a remote src')
    // Every env var the service actually reads is documented.
    const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
      + fs.readFileSync(new URL('../render.mjs', import.meta.url), 'utf8')
      + fs.readFileSync(new URL('../themes.mjs', import.meta.url), 'utf8')
    for (const m of new Set([...source.matchAll(/process\.env\.(MD2PDF_\w+)/g)].map((x) => x[1]))) {
      assert.ok(html.includes(m), `${m} is read but not documented on the page`)
    }
  } finally {
    server.close()
  }
})

test('the API description shows the public URL, escaped, in every example', async () => {
  const { renderIndex } = await import('../server.mjs')
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.ok(page.includes('{{PUBLIC_URL}}'), 'the page has no {{PUBLIC_URL}} placeholder')
  assert.equal(page.includes('localhost:18509/'), false, 'an example still hard-codes localhost:18509')
  const html = renderIndex(page, 'https://docs.example.org/md2pdf')
  assert.equal(html.includes('{{PUBLIC_URL}}'), false)
  for (const p of ['/pdf', '/themes', '/health']) {
    assert.ok(html.includes(`https://docs.example.org/md2pdf${p}`), `no public example for ${p}`)
  }
  assert.equal(renderIndex('{{PUBLIC_URL}}', 'http://x/"><script>'), 'http://x/&quot;&gt;&lt;script&gt;')
})
