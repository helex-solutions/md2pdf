// The renderer: a self-contained HTML document in, PDF bytes out.
//
// One long-lived browser (launching Chromium per request costs ~300ms and a lot
// of memory churn), one fresh incognito context per render so two documents can
// never share cookies, storage or a JavaScript realm.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Chromium is installed by the image, not downloaded by puppeteer — hence
// puppeteer-CORE. The candidates cover the alpine package this repo's Dockerfile
// installs, the Debian/Ubuntu names, and macOS for running the service locally.
const CHROMIUM_CANDIDATES = [
  process.env.MD2PDF_CHROMIUM,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean)

export function findChromium() {
  return CHROMIUM_CANDIDATES.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

// Mermaid's UMD bundle, injected into the page by file path (puppeteer inlines
// the file's contents, so this is not a network fetch — see the request policy
// below). Resolved once: a missing bundle is a broken install, and a diagram
// that silently stayed a placeholder would look like a content bug instead.
function mermaidBundle() {
  const p = path.join(HERE, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
  return fs.existsSync(p) ? p : null
}

const DEFAULTS = {
  format: 'A4',
  landscape: false,
  scale: 1,
  printBackground: true,
  margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
  timeout: 30000
}

const clamp = (v, lo, hi, fallback) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback

// A CSS length, or nothing. A margin is interpolated into Chromium's own print
// settings, so it is validated rather than passed through.
const LENGTH = /^\d+(\.\d+)?(mm|cm|in|px|pt)$/
const length = (v, fallback) => (typeof v === 'string' && LENGTH.test(v.trim()) ? v.trim() : fallback)

/**
 * Merge a theme's defaults under the caller's options.
 *
 * A theme knows the page box its stylesheet was drawn for — the HELEX sheet
 * needs a 38mm top margin for its band, the one-pager wants 14mm all round —
 * so its options are DEFAULTS, below whatever the caller asked for explicitly.
 * Only keys the caller actually sent override; `undefined` does not count.
 */
export function mergeOptions(themeOptions = {}, raw = {}) {
  const out = { ...themeOptions }
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out[k] = k === 'margin' ? { ...(themeOptions.margin || {}), ...(v || {}) } : v
  }
  return out
}

export function normalizeOptions(raw = {}) {
  const m = raw.margin || {}
  return {
    format: typeof raw.format === 'string' && /^[A-Za-z0-9]{1,12}$/.test(raw.format) ? raw.format : DEFAULTS.format,
    landscape: raw.landscape === true,
    scale: clamp(raw.scale, 0.1, 2, DEFAULTS.scale),
    printBackground: raw.printBackground !== false,
    margin: {
      top: length(m.top, DEFAULTS.margin.top),
      right: length(m.right, DEFAULTS.margin.right),
      bottom: length(m.bottom, DEFAULTS.margin.bottom),
      left: length(m.left, DEFAULTS.margin.left)
    },
    headerTemplate: typeof raw.headerTemplate === 'string' ? raw.headerTemplate : '',
    footerTemplate: typeof raw.footerTemplate === 'string' ? raw.footerTemplate : '',
    timeout: clamp(raw.timeout, 1000, 120000, DEFAULTS.timeout)
  }
}

export class Renderer {
  constructor({ concurrency = 2, executablePath = null } = {}) {
    this.concurrency = Math.max(1, concurrency)
    this.executablePath = executablePath || findChromium()
    this.browser = null
    this.busy = 0
    this.queue = []
    this.launching = null
  }

  async launch() {
    if (this.browser?.connected) return this.browser
    if (!this.executablePath) {
      throw Object.assign(new Error('no Chromium found — set MD2PDF_CHROMIUM'), { status: 503 })
    }
    // Serialize concurrent launches, so a burst of first requests opens one
    // browser rather than one each.
    if (!this.launching) {
      this.launching = puppeteer
        .launch({
          executablePath: this.executablePath,
          headless: true,
          // --no-sandbox: the container is the sandbox (unprivileged user, no
          // shared filesystem, no network — see the request policy below), and
          // Chromium's own sandbox needs privileges the image deliberately
          // does not grant. --disable-dev-shm-usage because the default /dev/shm
          // in a container is 64MB, which a large document overruns.
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
        })
        .then((b) => {
          this.browser = b
          this.launching = null
          b.on('disconnected', () => {
            if (this.browser === b) this.browser = null
          })
          return b
        })
        .catch((e) => {
          this.launching = null
          throw e
        })
    }
    return this.launching
  }

  async version() {
    const b = await this.launch()
    return (await b.version()).replace(/^HeadlessChrome\//, '')
  }

  async close() {
    const b = this.browser
    this.browser = null
    if (b) await b.close().catch(() => {})
  }

  // A render slot. Rendering is CPU- and memory-heavy, so the number in flight
  // is bounded and callers past the bound wait rather than pile onto the browser.
  async acquire(waitMs = 15000) {
    if (this.busy < this.concurrency) {
      this.busy++
      return
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject }
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((q) => q !== entry)
        reject(Object.assign(new Error('renderer busy'), { status: 429 }))
      }, waitMs)
      entry.resolve = () => {
        clearTimeout(timer)
        resolve()
      }
      this.queue.push(entry)
    })
    this.busy++
  }

  release() {
    this.busy--
    const next = this.queue.shift()
    if (next) next.resolve()
  }

  /**
   * `theme` carries the resolved stylesheet and title block (md2pdf/themes.mjs).
   * They are injected into the LOADED page rather than spliced into the HTML
   * string: the caller's document is parsed by the browser, so appending to its
   * real <head>/<body> cannot depend on how that markup happens to be written.
   */
  async render(html, rawOptions = {}, theme = null) {
    const options = normalizeOptions(rawOptions)
    await this.acquire()
    let context = null
    try {
      const browser = await this.launch()
      context = await browser.createBrowserContext()
      const page = await context.newPage()
      page.setDefaultTimeout(options.timeout)

      // THE RENDERER FETCHES NOTHING. The document arrives self-contained (the
      // caller inlines its assets), so every request a page makes is content
      // asking for something it was not given — an <img src="http://…"> written
      // into a wiki page becoming a request made from inside this network. Both
      // the SSRF and the "quietly slow render" are closed by refusing all of it.
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const url = req.url()
        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) req.continue()
        else req.abort('blockedbyclient').catch(() => {})
      })

      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: options.timeout })
      if (theme?.css || theme?.titleBlock) await this.applyTheme(page, theme)
      await this.claimPageBox(page)
      await this.drawDiagrams(page, options.timeout)
      await page.emulateMediaType('print')
      // Web fonts are inlined or absent, but a layout pass may still be pending.
      await page.evaluate(() => document.fonts?.ready)

      return await page.pdf({
        format: options.format,
        landscape: options.landscape,
        scale: options.scale,
        printBackground: options.printBackground,
        margin: options.margin,
        displayHeaderFooter: Boolean(options.headerTemplate || options.footerTemplate),
        headerTemplate: options.headerTemplate || '<span></span>',
        footerTemplate: options.footerTemplate || '<span></span>',
        // false: the caller's format/margin win, so one config key decides the
        // paper size instead of it depending on which stylesheet loaded.
        preferCSSPageSize: false,
        timeout: options.timeout
      })
    } finally {
      if (context) await context.close().catch(() => {})
      this.release()
    }
  }

  /**
   * Take the page box back from the document.
   *
   * `@page { size: A4 }` anywhere in the document OVERRIDES the paper size this
   * service was asked for, so `landscape: true` (or `format: Letter`) is
   * silently ignored and the PDF comes out portrait A4 with no error anywhere.
   * A last `@page { size: auto }` releases it, and since `preferCSSPageSize` is
   * false the request's own format then decides.
   *
   * Callers cannot be relied on to avoid this: a print stylesheet pinning A4 is
   * the normal, sensible thing to write, and mdbook's own did.
   */
  async claimPageBox(page) {
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.setAttribute('data-md2pdf-page-box', '')
      style.textContent = '@page { size: auto; }'
      document.head.appendChild(style)
    })
  }

  // A theme's stylesheet goes LAST in <head> so it wins over whatever the
  // document brought, and its title block goes first in <body>.
  async applyTheme(page, { css, titleBlock }) {
    await page.evaluate(
      (themeCss, block) => {
        if (themeCss) {
          const style = document.createElement('style')
          style.setAttribute('data-md2pdf-theme', '')
          style.textContent = themeCss
          document.head.appendChild(style)
        }
        if (block) {
          const holder = document.createElement('div')
          holder.innerHTML = block
          // The source title blocks ship their own <style>; move it to <head>
          // so it applies to the document rather than sitting inert in <body>.
          holder.querySelectorAll('style').forEach((s) => document.head.appendChild(s))
          document.body.insertBefore(holder, document.body.firstChild)
        }
      },
      css || '',
      titleBlock || ''
    )
  }

  // mdbook emits Mermaid as `.mermaid-diagram[data-src]` placeholders that the
  // theme draws in the reader's browser (src/theme/mermaid.mjs). Nothing else
  // in this service knows what mdbook markup looks like; this and the iframe
  // swap below are the whole of the coupling, and docs/pdf-design.md §3.3 names
  // them both.
  async drawDiagrams(page, timeout) {
    const has = await page.evaluate(() => document.querySelectorAll('.mermaid-diagram[data-src]').length > 0)
    if (!has) return
    const bundle = mermaidBundle()
    if (!bundle) {
      await page.evaluate(() => {
        document.querySelectorAll('.mermaid-diagram[data-src]').forEach((el) => {
          el.textContent = 'Diagram not rendered: mermaid is missing from the md2pdf install'
        })
      })
      return
    }
    await page.addScriptTag({ path: bundle })
    await page.evaluate(async () => {
      // The same two safety settings the theme states, for the same reasons:
      // diagram source is page content. 'strict' runs mermaid's own DOMPurify
      // and disables click bindings; htmlLabels:false keeps labels as SVG text
      // rather than live DOM inside a foreignObject.
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'default' })
      const nodes = [...document.querySelectorAll('.mermaid-diagram[data-src]')]
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i]
        try {
          const { svg } = await window.mermaid.render(`md2pdf-${i}`, decodeURIComponent(el.getAttribute('data-src')))
          el.innerHTML = svg
        } catch (e) {
          el.innerHTML = `<pre class="mermaid-error">Mermaid error: ${e?.message || e}</pre>`
        }
        el.removeAttribute('data-src')
      }
    }, { timeout })
  }
}
