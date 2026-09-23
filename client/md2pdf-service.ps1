<#
.SYNOPSIS
  Convert Markdown to PDF with the md2pdf service (PowerShell client).

.DESCRIPTION
  The PowerShell twin of md2pdf-service.sh. pandoc turns each Markdown file
  into ONE self-contained HTML document (images inlined as data: URIs, since
  the service fetches nothing), and that is POSTed to <Url>/pdf. ```mermaid
  blocks are drawn by the service. Works in Windows PowerShell 5.1 and
  PowerShell 7 (Windows, macOS, Linux). Needs pandoc on PATH, plus the two
  helper files next to this script: md2pdf-service-mermaid.lua and
  md2pdf-service-base.css.

  PDFs go to the current folder by default, named after their input.

.PARAMETER Inputs
  One or more Markdown files.

.PARAMETER Theme
  plain (default) | helex | helex-onepager | tervisekassa | taltech | site.
  The live list: <Url>/themes

.PARAMETER OutDir
  Output folder (default: the current folder). Created if missing.

.PARAMETER Output
  An exact output file; only with a single input.

.PARAMETER Landscape
  Landscape pages.

.PARAMETER Paper
  A4 (default) | Letter | A3 | ...

.PARAMETER Css
  Extra CSS file, applied on top of the theme.

.PARAMETER Title
  Title for the theme's title block (default: frontmatter title:, else the
  first "# " heading, else the file name).

.PARAMETER Site
  Site/organisation line for the title block.

.PARAMETER Date
  Date for the title block (default: today).

.PARAMETER Logo
  Logo image (png/jpg/svg/webp/gif) for the title block; overrides the
  theme's own.

.PARAMETER Url
  Service base URL (default: $env:MD2PDF_URL, else https://docs.helex.org/md2pdf).

.PARAMETER HtmlOnly
  Write the HTML that would be sent, and stop.

.EXAMPLE
  .\md2pdf-service.ps1 -Theme tervisekassa dokument.md

.EXAMPLE
  .\md2pdf-service.ps1 -Theme helex -OutDir out a.md b.md c.md
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Inputs,
  [string] $Theme = 'plain',
  [string] $OutDir = '.',
  [string] $Output = '',
  [switch] $Landscape,
  [string] $Paper = 'A4',
  [string] $Css = '',
  [string] $Title = '',
  [string] $Site = '',
  [string] $Date = (Get-Date -Format 'yyyy-MM-dd'),
  [string] $Logo = '',
  [string] $Url = '',
  [switch] $HtmlOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Fail([string] $msg) {
  [Console]::Error.WriteLine("md2pdf-service: $msg")
  exit 1
}

# Files are read and written as UTF-8 explicitly: Windows PowerShell 5.1
# otherwise uses the ANSI code page, which mangles õ, ä, ö, ü and š.
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# A symlink or shortcut to this script must still find its helper files.
$item = Get-Item -LiteralPath $MyInvocation.MyCommand.Path
if ($item.PSObject.Properties['LinkType'] -and $item.LinkType -and $item.Target) {
  $target = @($item.Target)[0]
  if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $ScriptDir $target }
  $ScriptDir = Split-Path -Parent (Resolve-Path -LiteralPath $target).Path
}
$Filter = Join-Path $ScriptDir 'md2pdf-service-mermaid.lua'
$BaseCss = Join-Path $ScriptDir 'md2pdf-service-base.css'

if (-not $Url) { $Url = if ($env:MD2PDF_URL) { $env:MD2PDF_URL } else { 'https://docs.helex.org/md2pdf' } }
$Url = $Url.TrimEnd('/')

if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) { Fail 'pandoc is not installed (https://pandoc.org/installing.html)' }
if (-not (Test-Path -LiteralPath $Filter)) { Fail "md2pdf-service-mermaid.lua must sit next to this script ($ScriptDir)" }
if ($Css -and -not (Test-Path -LiteralPath $Css)) { Fail "no such CSS file: $Css" }
if ($Logo -and -not (Test-Path -LiteralPath $Logo)) { Fail "no such logo file: $Logo" }
if ($Output -and $Inputs.Count -gt 1 -and $Output -match '\.pdf$') { Fail "several inputs need -OutDir, not -Output $Output" }

# pandoc 2.19+ (2022): --embed-resources, and a gfm reader that takes the
# yaml_metadata_block and fenced_divs extensions. Older ones fail half-way, so
# refuse them up front. winget install pandoc / the MSI / brew ship 3.x.
$pandocVersion = ((& pandoc --version | Select-Object -First 1) -replace '^pandoc(\.exe)?\s+', '')
try { $v = [version](($pandocVersion -split '[^0-9.]')[0]) } catch { $v = [version]'0.0' }
if ($v -lt [version]'2.19') { Fail "pandoc $pandocVersion is too old; 2.19 or newer is needed (https://pandoc.org/installing.html)" }

# The logo travels as a data: URI — the only form the service accepts.
$logoUri = ''
if ($Logo) {
  $mime = switch -Regex ([IO.Path]::GetExtension($Logo).ToLowerInvariant()) {
    '^\.png$'         { 'image/png' }
    '^\.jpe?g$'       { 'image/jpeg' }
    '^\.svg$'         { 'image/svg+xml' }
    '^\.webp$'        { 'image/webp' }
    '^\.gif$'         { 'image/gif' }
    default           { Fail "logo must be png, jpg, svg, webp or gif: $Logo" }
  }
  $logoUri = "data:$mime;base64," + [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Logo).Path))
}

# Base CSS first (keeps wide tables/code from shrinking every page), then -Css.
$extraCss = ''
if (Test-Path -LiteralPath $BaseCss) { $extraCss = [IO.File]::ReadAllText($BaseCss, $Utf8) }
if ($Css) { $extraCss += "`n" + [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Css).Path, $Utf8) }

# HttpClient rather than Invoke-WebRequest: identical behaviour in 5.1 and 7,
# and a non-2xx answer is a response to read, not an exception to unpick.
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(150)

function Get-DocTitle([string] $path) {
  $lines = [IO.File]::ReadAllLines($path, $Utf8)
  if ($lines.Count -gt 0 -and $lines[0] -eq '---') {
    for ($i = 1; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -eq '---') { break }
      if ($lines[$i] -match '^title:\s*(.+)$') { return $Matches[1].Trim().Trim('"', "'") }
    }
  }
  foreach ($l in $lines) { if ($l -match '^#\s+(.+?)\s*#*\s*$') { return $Matches[1] } }
  return [IO.Path]::GetFileNameWithoutExtension($path)
}

$failed = $false
foreach ($in in $Inputs) {
  if (-not (Test-Path -LiteralPath $in -PathType Leaf)) { [Console]::Error.WriteLine("md2pdf-service: no such file: $in"); $failed = $true; continue }
  $inPath = (Resolve-Path -LiteralPath $in).Path
  $base = [IO.Path]::GetFileNameWithoutExtension($inPath)

  if ($Output -and $Inputs.Count -eq 1) {
    $out = if ((Test-Path -LiteralPath $Output -PathType Container) -or $Output -match '[\\/]$') { Join-Path $Output "$base.pdf" } else { $Output }
  } else {
    $dir = if ($Output) { $Output } else { $OutDir }
    $out = Join-Path $dir "$base.pdf"
  }
  $outDirPath = Split-Path -Parent $out
  if ($outDirPath -and -not (Test-Path -LiteralPath $outDirPath)) { New-Item -ItemType Directory -Path $outDirPath -Force | Out-Null }
  $out = Join-Path (Resolve-Path -LiteralPath $(if ($outDirPath) { $outDirPath } else { '.' })).Path (Split-Path -Leaf $out)

  $docTitle = if ($Title) { $Title } else { Get-DocTitle $inPath }
  $work = Join-Path ([IO.Path]::GetTempPath()) ("md2pdf-service-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $htmlFile = Join-Path $work 'doc.html'
    # pandoc's own stylesheet only for -Theme site. It must be -M (YAML false):
    # with -V the value is the string "false", which a template treats as true.
    $docCss = if ($Theme -eq 'site') { 'true' } else { 'false' }
    Push-Location (Split-Path -Parent $inPath)
    try {
      & pandoc (Split-Path -Leaf $inPath) --from 'gfm+yaml_metadata_block+fenced_divs' --to html5 --standalone --embed-resources `
        --lua-filter $Filter --metadata "pagetitle=$docTitle" -M "document-css=$docCss" -o $htmlFile
      if ($LASTEXITCODE -ne 0) { throw "pandoc failed on $in" }
    } finally { Pop-Location }

    # The filter writes data-md2pdf-src because pandoc's embedding treats a
    # data-src attribute as a URL to fetch; renamed to what the service reads.
    $html = [IO.File]::ReadAllText($htmlFile, $Utf8).Replace(' data-md2pdf-src="', ' data-src="')

    if ($HtmlOnly) {
      $htmlOut = [IO.Path]::ChangeExtension($out, '.html')
      [IO.File]::WriteAllText($htmlOut, $html, $Utf8)
      Write-Host "wrote $htmlOut"
      continue
    }

    $options = [ordered]@{ theme = $Theme; format = $Paper; landscape = [bool]$Landscape }
    if ($extraCss) { $options.css = $extraCss }
    if ($logoUri) { $options.logo = $logoUri }
    $body = [ordered]@{
      html = $html; filename = (Split-Path -Leaf $out); title = $docTitle
      site = $Site; date = $Date; options = $options
    } | ConvertTo-Json -Depth 5 -Compress
    $bytes = $Utf8.GetBytes($body)
    if ($bytes.Length -gt 20MB) { throw ("request is {0} MB; the public service takes 20 MB (large images?)" -f [math]::Round($bytes.Length / 1MB)) }

    $content = New-Object System.Net.Http.ByteArrayContent(,$bytes)
    $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')
    $content.Headers.ContentType.CharSet = 'utf-8'
    try {
      $resp = $http.PostAsync("$Url/pdf", $content).GetAwaiter().GetResult()
    } catch {
      throw "could not reach $Url ($($_.Exception.GetBaseException().Message))"
    }
    $respBytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $status = [int]$resp.StatusCode
    if ($status -ne 200) {
      $msg = $Utf8.GetString($respBytes)
      try { $msg = ($msg | ConvertFrom-Json).error } catch { }
      if ($status -eq 429) { throw 'HTTP 429 - rate limit or every render slot busy; retry in a minute' }
      throw "HTTP $status - $msg"
    }
    [IO.File]::WriteAllBytes($out, $respBytes)
    Write-Host ("wrote {0} ({1} bytes, theme {2})" -f $out, $respBytes.Length, $Theme)
  } catch {
    [Console]::Error.WriteLine("md2pdf-service: $($_.Exception.Message)")
    $failed = $true
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
$http.Dispose()
if ($failed) { exit 1 }
