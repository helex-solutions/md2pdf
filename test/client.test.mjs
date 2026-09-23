import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
const script = path.join(dir, 'md2pdf-service.sh')

test('client script parses and prints its help', () => {
  execFileSync('bash', ['-n', script])
  const help = execFileSync('bash', [script, '--help'], { encoding: 'utf8' })
  for (const opt of ['--theme', '--outdir', '--logo', '--html-only']) assert.ok(help.includes(opt), `help lacks ${opt}`)
})

test('client helper files ship next to the script', () => {
  for (const f of ['md2pdf-service-mermaid.lua', 'md2pdf-service-base.css']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing from client/`)
  }
})

const hasPandoc = (() => {
  try {
    execFileSync('pandoc', ['--version'], { stdio: 'ignore' })
    execFileSync('jq', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('client finds its helpers through a symlink', { skip: !hasPandoc && 'needs pandoc + jq' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-client-'))
  try {
    const link = path.join(tmp, 'md2pdf-service.sh')
    fs.symlinkSync(script, link)
    const md = path.join(tmp, 'doc.md')
    fs.writeFileSync(md, '# Title\n\n```mermaid\nflowchart LR\n  A --> B\n```\n')
    // --html-only never calls the service, but it does run pandoc with the
    // Lua filter found via SCRIPT_DIR — so a broken symlink resolution fails here.
    execFileSync('bash', [link, '--html-only', '-d', tmp, md], { cwd: tmp })
    const html = fs.readFileSync(path.join(tmp, 'doc.html'), 'utf8')
    assert.match(html, /class="mermaid-diagram" data-src="flowchart%20LR/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
