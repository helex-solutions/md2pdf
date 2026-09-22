// Rendering tests — they launch a real browser, so they SKIP when there is no
// Chromium and when poppler's pdftotext is missing. CI without either stays
// green; CI with both gets the assertions that matter.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Renderer, findChromium } from '../render.mjs'
import { prepareRender, listThemes } from '../themes.mjs'

const have = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const SKIP = !findChromium()
  ? 'no Chromium (set MD2PDF_CHROMIUM)'
  : !have('pdftotext')
    ? 'pdftotext not installed (brew install poppler)'
    : false

let renderer
let dir
before(() => {
  if (SKIP) return
  renderer = new Renderer({ concurrency: 1 })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-render-'))
})
after(async () => {
  if (renderer) await renderer.close()
})

// Whitespace is layout, not content: a long line wraps and pdftotext inserts a
// newline there. Collapsing it is what makes an "exact round-trip" assertion
// mean "every glyph survived" instead of "the line happened to fit".
const flat = (s) => s.replace(/\s+/g, ' ').trim()

async function textOf(html, options = {}) {
  // Through the SAME resolution the request handler uses — see prepareRender().
  const { theme, options: resolved } = prepareRender({ options })
  const pdf = await renderer.render(html, resolved, theme)
  const file = path.join(dir, `${options.theme || 'site'}-${Date.now()}.pdf`)
  fs.writeFileSync(file, pdf)
  return { text: flat(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })), file, pdf }
}

// OWLIKI.06 §2.6 step 4 prescribes exactly this and the reference implementation
// never wrote it: a substituted font produces wrong or missing glyphs, which a
// visual check misses and a "%PDF-" magic-byte assertion cannot see at all.
//
// The samples go in PARAGRAPHS, not headings: some themes text-transform their
// h1, and a case-sensitive assertion against one of those fails for a reason
// that has nothing to do with fonts.
const SAMPLES = {
  cs: 'Propouštěcí zpráva — příliš žluťoučký kůň úpěl ďábelské ódy',
  lt: 'Sveikatos priežiūros įstaigų sąrašas — ąčęėįšųūž',
  et: 'Tervishoiuteenuste loetelu — äöüõšž',
  ru: 'Медицинская документация — ёъыжщ'
}

test('every theme round-trips Czech, Lithuanian, Estonian and Cyrillic exactly', { skip: SKIP, timeout: 120_000 }, async () => {
  const body = Object.entries(SAMPLES).map(([k, v]) => `<p lang="${k}">${v}</p>`).join('')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
  for (const { name } of listThemes()) {
    const { text } = await textOf(html, { theme: name })
    for (const [lang, sample] of Object.entries(SAMPLES)) {
      assert.ok(text.includes(flat(sample)), `${name}: ${lang} did not survive — glyph substitution`)
    }
  }
})

test('a named theme puts a real page number in the document', { skip: SKIP, timeout: 120_000 }, async () => {
  // The margin-box -> header-template translation fails silently: the PDF still
  // renders, it has simply lost the furniture. Only extraction catches it.
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    Array.from({ length: 60 }, (_, i) => `<p>Line ${i}</p>`).join('') +
    '</body></html>'
  for (const { name } of listThemes().filter((t) => t.name !== 'site')) {
    const { text, file } = await textOf(html, { theme: name })
    const pages = /Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))?.[1]
    assert.ok(Number(pages) > 1, `${name}: the fixture did not span pages, so the check is vacuous`)
    assert.match(text, /\d+\s*\/\s*\d+|Page \d+ of \d+/, `${name}: no page number — the footer template was lost`)
  }
})

test('orientation and paper come from the request, not from the document CSS', { skip: SKIP, timeout: 60_000 }, async () => {
  // `@page { size: A4 }` in the document overrides Chromium's own paper
  // settings, so a landscape request came out portrait with no error anywhere.
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>@media print { @page { size: A4; } }</style></head><body><p>x</p></body></html>'
  const { file } = await textOf(html, { theme: 'plain', landscape: true })
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))
  assert.ok(Number(size[1]) > Number(size[2]), 'the document CSS won over the requested orientation')
})

test('the renderer fetches nothing: an external image cannot become a request', { skip: SKIP, timeout: 60_000 }, async () => {
  // Page content is authored by whoever writes the wiki, so an <img> pointing
  // inside the deployment's network must not be fetched by the renderer.
  let hit = false
  const http = await import('node:http')
  const spy = http.createServer((req, res) => {
    hit = true
    res.writeHead(200).end('x')
  })
  await new Promise((r) => spy.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${spy.address().port}/pixel.png`
  const html = `<!DOCTYPE html><html><body><img src="${url}"><p>body</p></body></html>`
  const { text } = await textOf(html, { theme: 'plain' })
  spy.close()
  assert.equal(hit, false, 'the renderer fetched a URL from page content')
  assert.match(text, /body/) // and rendered anyway
})
