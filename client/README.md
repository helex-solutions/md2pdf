# md2pdf-service — Markdown → PDF from the command line

Two clients that do the same thing: **`md2pdf-service.sh`** (bash: macOS, Linux,
WSL) and **`md2pdf-service.ps1`** (PowerShell: Windows PowerShell 5.1 and
PowerShell 7 on any OS).

A small client for the md2pdf service. It turns a Markdown file into one
self-contained HTML document with pandoc and has the service print it. By default
it uses the public instance at **https://docs.helex.org/md2pdf/**.

```bash
md2pdf-service.sh --theme tervisekassa dokument.md        # -> ./dokument.pdf
md2pdf-service.sh --theme helex -d out/ a.md b.md c.md    # one PDF per file
```

## Install

Needs **pandoc 2.19 or newer** (2022). The bash client also needs **curl** and
**jq** (`brew install pandoc jq` on macOS, `apt install pandoc jq curl` on Debian/Ubuntu,
though Ubuntu 22.04's pandoc 2.9 is too old: take the `.deb` from
[pandoc.org](https://pandoc.org/installing.html)). The PowerShell client needs
only pandoc.

The script needs its two helper files next to it: the Mermaid filter and the
base stylesheet. Keep the three together. Either clone the repository and link
the script onto your `PATH`:

```bash
git clone https://github.com/helex-solutions/md2pdf.git ~/md2pdf
ln -s ~/md2pdf/client/md2pdf-service.sh /usr/local/bin/md2pdf-service.sh
```

or download just the three files into a directory of your own:

```bash
mkdir -p ~/bin && cd ~/bin
for f in md2pdf-service.sh md2pdf-service-mermaid.lua md2pdf-service-base.css; do
  curl -fsSLO "https://raw.githubusercontent.com/helex-solutions/md2pdf/main/client/$f"
done
chmod +x md2pdf-service.sh
```

A symlink works: the script resolves it to find its helper files.

### Windows (PowerShell)

```powershell
winget install --id JohnMacFarlane.Pandoc
$dir = "$HOME\md2pdf"; New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($f in 'md2pdf-service.ps1','md2pdf-service-mermaid.lua','md2pdf-service-base.css') {
  Invoke-WebRequest "https://raw.githubusercontent.com/helex-solutions/md2pdf/main/client/$f" -OutFile "$dir\$f"
}
Unblock-File "$dir\md2pdf-service.ps1"
```

Then:

```powershell
& "$HOME\md2pdf\md2pdf-service.ps1" -Theme tervisekassa .\dokument.md
& "$HOME\md2pdf\md2pdf-service.ps1" -Theme helex -OutDir out a.md b.md
Get-Help "$HOME\md2pdf\md2pdf-service.ps1" -Detailed
```

If scripts are blocked by the execution policy, run it as
`powershell -ExecutionPolicy Bypass -File "$HOME\md2pdf\md2pdf-service.ps1" …`
or allow your own scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
The PowerShell options are the same as below, in PowerShell style: `-Theme`,
`-OutDir`, `-Output`, `-Landscape`, `-Paper`, `-Css`, `-Title`, `-Site`, `-Date`,
`-Logo`, `-Url`, `-HtmlOnly`.

## Use

```
md2pdf-service.sh [options] INPUT.md [INPUT2.md …] [OUTPUT.pdf|OUTPUT_DIR/]
```

| Option | |
|---|---|
| `-t, --theme NAME` | `plain` (default), `helex`, `helex-onepager`, `tervisekassa`, `taltech`, or `site` (pandoc's own styling). The live list is at `/themes` |
| `-d, --outdir DIR` | output folder; default is the **current folder**, and each PDF is named after its input |
| `-o, --output PATH` | an exact output file (single input only) |
| `--landscape`, `--paper A4\|Letter\|…` | page box |
| `--title`, `--site`, `--date` | fill the theme's title block; the title defaults to frontmatter `title:`, then the first `# ` heading |
| `--logo FILE` | a logo (png/jpg/svg/webp) for the title block, overriding the theme's own |
| `--css FILE` | extra CSS on top of the theme |
| `--url URL` | another md2pdf instance (default `$MD2PDF_URL`, else `https://docs.helex.org/md2pdf`) |
| `--html-only` | write the HTML that would be sent, and stop |

## What to know

- **Images are inlined by the script.** The service fetches nothing, so pandoc
  embeds local and remote images as `data:` URIs before sending. An image it
  cannot reach is simply missing from the PDF.
- **Mermaid** blocks (` ```mermaid `) are drawn by the service. There's nothing to
  install locally.
- **Wide tables and long code/URLs** stay inside the text column
  (`md2pdf-service-base.css`). Without that, Chromium shrinks the whole page to
  fit the widest element.
- **Markdown flavour** is GitHub's (`gfm`). A plain line break joins lines, as it
  does on GitHub; end a line with `\` to keep it separate. `[1]: url`
  reference definitions render as nothing, so show a references list as normal
  text.
- **The public instance** takes 10 renders a minute per address (burst 5, then
  HTTP 429) and bodies up to 20 MB. It keeps no documents: a PDF is rendered in
  memory and returned. Its log records the file name, theme and size. It is
  still a public service, so don't send personal data or confidential content.
