// Re-port the WeasyPrint presets from ~/bin/md2pdf-*.css into themes/.
//
//   node tools/port-themes.mjs themes
//
// Kept in the repo rather than run once and thrown away: it is the record of HOW
// the themes were derived, and the way to pick up a change to the source sheets
// without re-deciding all of this. It regenerates theme.css / theme.json /
// title.html and never touches the hand-written header.html / footer.html.
//
// The @page block is REMOVED from the stylesheet and its size/margin become
// theme.json options, so exactly one thing decides the page box. Its margin
// boxes cannot survive at all (Chromium has none) — their content is re-authored
// by hand as header.html / footer.html, which this script does not generate.
//
// Two translations are applied, both found by rendering and looking at the
// result rather than by reading the CSS; see maskComments() and
// dropLocalOnlyFontFaces() for what each one cost before it was fixed.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BIN = path.join(os.homedir(), 'bin')
const OUT = process.argv[2]

/**
 * A copy of the stylesheet with every comment blanked to spaces, same length.
 *
 * Scanning for at-rules has to happen on THIS, not on the raw text. md2pdf-helex.css
 * contains the prose "Weasyprint draws @page borders but not double-stacked bars"
 * inside a comment; matching `@page` there and then consuming to the next braced
 * block silently deleted the `html, body` typography rule that followed, which is
 * how the whole document came out in Times. Offsets are preserved so a range found
 * here can be cut straight out of the original.
 */
function maskComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length))
}

// Strip top-level @page blocks with balanced braces; return the CSS without
// them plus each block's raw body.
function splitPage(css) {
  const scan = maskComments(css)
  const blocks = []
  let out = ''
  let last = 0
  const re = /@page([^{]*)\{/g
  let m
  while ((m = re.exec(scan))) {
    let i = re.lastIndex
    let depth = 1
    while (i < scan.length && depth > 0) {
      if (scan[i] === '{') depth++
      else if (scan[i] === '}') depth--
      i++
    }
    blocks.push({ sel: m[1].trim(), body: css.slice(re.lastIndex, i - 1) })
    out += css.slice(last, m.index)
    last = i
    re.lastIndex = i
  }
  out += css.slice(last)
  return { css: out, blocks }
}

/**
 * Drop `@font-face` rules whose only sources are `local()`.
 *
 * WeasyPrint resolves those against the host's installed fonts. Chromium does
 * not — and because the rule still DEFINES the family, a failed face does not
 * fall through to the next family in the stack the way an unknown name does:
 * it drops to the generic default. Observed concretely — `@font-face
 * { font-family: "Helex Sans"; src: local("Helvetica Neue"), … }` rendered the
 * whole HELEX document in Times, while the same stack without the rule renders
 * Helvetica. Removing it leaves `font-family: "Helex Sans", "Helvetica Neue",
 * Helvetica, Arial, sans-serif` to say exactly what it meant all along.
 *
 * A face with a real `url()` source is left alone — that one Chromium can load.
 */
function dropLocalOnlyFontFaces(css) {
  const scan = maskComments(css)
  const dropped = []
  const cuts = []
  const re = /@font-face\s*\{[^}]*\}/g
  let m
  while ((m = re.exec(scan))) {
    const block = css.slice(m.index, m.index + m[0].length)
    if (/url\s*\(/i.test(block)) continue
    dropped.push(/font-family\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() || '?')
    cuts.push([m.index, m.index + m[0].length])
  }
  let out = ''
  let last = 0
  for (const [a, b] of cuts) {
    out += css.slice(last, a)
    last = b
  }
  return { css: out + css.slice(last), dropped }
}

const decl = (body, prop) => {
  // Only top-level declarations — never one from inside a margin box.
  let depth = 0
  let flat = ''
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0) flat += ch
  }
  return new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(flat)?.[1]?.trim() || null
}

// "38mm 18mm 22mm 18mm" -> {top,right,bottom,left}
function margins(shorthand) {
  if (!shorthand) return null
  const p = shorthand.split(/\s+/)
  if (!p.length || p.length > 4) return null
  const [t, r = t, b = t, l = r] = p
  return { top: t, right: r, bottom: b, left: l }
}

// Only the themes this repo ships. A theme carrying a THIRD PARTY's visual
// identity — its wordmark, palette and address — is not baked into a public
// image; it lives outside and is mounted via MD2PDF_THEMES_DIR, with its own
// copy of this script.
const THEMES = {
  helex: { src: 'md2pdf-helex.css', title: 'md2pdf-helex-header.html', label: 'HELEX document' },
  'helex-onepager': { src: 'md2pdf-helex-onepager.css', title: 'md2pdf-helex-header.html', label: 'HELEX one-pager' }
}

for (const [name, spec] of Object.entries(THEMES)) {
  const srcFile = path.join(BIN, spec.src)
  if (!fs.existsSync(srcFile)) {
    console.error(`skip ${name}: ${srcFile} missing`)
    continue
  }
  const dir = path.join(OUT, name)
  fs.mkdirSync(dir, { recursive: true })

  const split = splitPage(fs.readFileSync(srcFile, 'utf8'))
  const blocks = split.blocks
  const { css, dropped } = dropLocalOnlyFontFaces(split.css)
  const main = blocks.find((b) => !b.sel) || { body: '' }
  const landscape = blocks.some((b) => /landscape/i.test(b.sel))

  const header =
    `/* ${spec.label} — ported from ~/bin/${spec.src} (WeasyPrint) for Chromium.\n` +
    ` *\n` +
    ` * What changed in the port, each because Chromium lacks the feature:\n` +
    ` *   - the @page block is gone; its size/margin live in theme.json, so one\n` +
    ` *     place decides the page box instead of it depending on load order;\n` +
    ` *   - its top/bottom margin boxes are gone; their content is\n` +
    ` *     re-authored in header.html / footer.html, which Chromium fills via\n` +
    ` *     displayHeaderFooter. counter(page) becomes <span class="pageNumber">.\n` +
    (dropped.length
      ? ` *   - @font-face for ${dropped.join(', ')} is gone: its sources were all\n` +
        ` *     local(), which Chromium cannot resolve, and a DEFINED-but-failed\n` +
        ` *     family drops to the generic default instead of falling through the\n` +
        ` *     stack. Without it the stack resolves as intended.\n`
      : '') +
    ` *\n` +
    ` * Everything else is the original sheet. Edit it here, not in ~/bin.\n` +
    ` */\n` +
    `:root { --md2pdf-scale: 1; }\n`

  fs.writeFileSync(path.join(dir, 'theme.css'), header + css.replace(/^\s*\n/, ''))

  const titleSrc = path.join(BIN, spec.title)
  if (fs.existsSync(titleSrc)) {
    // __HELEX_LOGO__ was substituted by md2pdf.sh with a local path. Here the
    // logo arrives per request as a data: URI, so the whole <img> is {{logo}}
    // and a theme with none supplied keeps its typographic mark.
    let t = fs.readFileSync(titleSrc, 'utf8')
    t = t.replace(/<img[^>]*__HELEX_LOGO__[^>]*\/?>/g, '{{logo}}')
    t = t.replace(/__HELEX_LOGO__/g, '')
    fs.writeFileSync(path.join(dir, 'title.html'), t)
  }

  const meta = {
    label: spec.label,
    description: `Ported from md2pdf.sh --format=${name}.`,
    options: {
      format: /a4/i.test(decl(main.body, 'size') || 'A4') ? 'A4' : 'Letter',
      margin: margins(decl(main.body, 'margin')) || undefined,
      landscape: landscape ? false : undefined
    }
  }
  if (!meta.options.margin) delete meta.options.margin
  if (meta.options.landscape === undefined) delete meta.options.landscape
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(meta, null, 2) + '\n')

  console.log(`${name}: css ${css.length}B, margin ${JSON.stringify(meta.options.margin)}`)
  for (const b of blocks) {
    const boxes = [...b.body.matchAll(/@(top|bottom)-(left|center|right)\s*\{([^}]*)\}/g)]
    for (const m of boxes) {
      const content = /content\s*:\s*([^;]+)/.exec(m[3])?.[1]?.trim()
      console.log(`   @${m[1]}-${m[2]}${b.sel ? ` (${b.sel})` : ''}: ${content}`)
    }
  }
}
