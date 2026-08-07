# Builds both release artifacts from one source of truth. Run it from anywhere, since paths
# resolve against the repo root rather than the working directory.
#
# The .xpi ships manifest.json verbatim, with browser_specific_settings and the SVG icon.
# The .zip ships the same files with the manifest transformed in memory and never written to
# disk: browser_specific_settings dropped, since Chrome rejects unknown keys,
# minimum_chrome_version added for storage.session, and the icon block swapped to the PNG set,
# since Chrome will not take an SVG.
#
# The version comes from manifest.json, so a bump never leaves this stale. Every other field is
# identical between the two artifacts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
# PowerShell's own location (Push-Location) and .NET's current directory are two separate things - relative paths passed into System.IO/System.IO.Compression APIs below resolve against the LATTER, which stays wherever the process originally started unless set explicitly.
[Environment]::CurrentDirectory = $root
try {
    $manifestObj = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
    $version = $manifestObj.version

    # THERE IS NO LIST. Twice a module added long after a hand-kept list was written went missing from it: one release shipped broken, and the next omission was caught only by the import check below. One dead import kills the whole module graph, and the temporary-install testing everyone does loads from the directory, where nothing is ever missing.
    # The check that caught the second one walked the import graph to verify the list. It builds the list now. Roots are what the browser itself loads, manifest.json's declared files plus the popup document, and everything reachable from there by an ES import or a local src or href is packaged. A module nothing imports is not part of the extension and is not shipped; a module something imports is shipped the moment the import is written.
    $graphRoots = @('dashboard.html')
    $manifestJson = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
    if ($manifestJson.action -and $manifestJson.action.default_popup) {
        $graphRoots += $manifestJson.action.default_popup
    }
    foreach ($size in $manifestJson.icons.PSObject.Properties) { $graphRoots += $size.Value }

    # manifest.json roots the graph and is not reachable from it, so it is named here with the icon set below. This is the whole non-graph remainder.
    $nonGraphFiles = @('manifest.json')

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $queue = [System.Collections.Generic.Queue[string]]::new()
    foreach ($r in $graphRoots) { if ($seen.Add($r)) { $queue.Enqueue($r) } }
    while ($queue.Count -gt 0) {
        $file = $queue.Dequeue()
        if (-not (Test-Path -LiteralPath $file)) {
            throw "Import graph points at a file that does not exist, refusing to build: $file"
        }
        $ext = [IO.Path]::GetExtension($file).ToLower()
        if ($ext -notin @('.js', '.html')) { continue }
        $text = Get-Content $file -Raw
        $targets = @()
        # Static ES imports and re-exports, which is every cross-module edge this codebase has. There is no dynamic import anywhere in it, and if one is ever added this pattern will not see it and the build will ship a broken graph.
        foreach ($m in ([regex]::Matches($text, "(?:import|export)[^'`"]+['`"]\./([\w./-]+)['`"]"))) {
            $targets += $m.Groups[1].Value
        }
        if ($ext -eq '.html') {
            foreach ($m in ([regex]::Matches($text, "(?:src|href)=['`"](?!https?:|#|data:)([\w./-]+)['`"]"))) {
                $targets += ($m.Groups[1].Value -replace '^\./', '')
            }
        }
        foreach ($t in $targets) { if ($seen.Add($t)) { $queue.Enqueue($t) } }
    }

    $runtimeFiles = @($nonGraphFiles + ($seen | Sort-Object))
    Write-Host ("Import graph: {0} files from {1} root(s)." -f $runtimeFiles.Count, $graphRoots.Count)

    # Declared BEFORE the decode loop below, which reads it. Assigning it after meant $iconFiles was $null there, PowerShell folded that into an empty array, and the loop ran over nothing at all: the one guard standing between a corrupt icon and a build no Chrome user could install had been silently checking zero files.
    $iconFiles = @('icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png')

    # Full decode of every packaged image, in the script rather than in review tooling: the 1.0.0 icon had a bad IDAT that only a complete decode catches, and header checks passed it into a build no Chrome user could install.
    Add-Type -AssemblyName System.Drawing
    foreach ($img in ($iconFiles + ($runtimeFiles | Where-Object { $_ -match '\.(png|jpg)$' }))) {
        try {
            $bmp = [System.Drawing.Bitmap]::new((Resolve-Path $img).Path)
            $null = $bmp.GetPixel($bmp.Width - 1, $bmp.Height - 1)
            $bmp.Dispose()
        } catch {
            throw "Image failed a full decode, refusing to build: $img ($_)"
        }
    }

    New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # Entries is an ordered map of zip-entry-name -> either a source file path (string) or raw bytes (used only for the in-memory Chrome manifest, which never touches disk).
    function New-ZipFromEntries {
        param([string]$Path, [System.Collections.Specialized.OrderedDictionary]$Entries)
        if (Test-Path $Path) { Remove-Item $Path -Force }
        $zip = [System.IO.Compression.ZipFile]::Open($Path, 'Create')
        try {
            foreach ($name in $Entries.Keys) {
                $value = $Entries[$name]
                $bytes = if ($value -is [byte[]]) { $value } else { [IO.File]::ReadAllBytes($value) }
                $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
                $stream = $entry.Open()
                try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            }
        } finally { $zip.Dispose() }
    }

    # ---- Firefox: manifest verbatim ----
    $firefoxEntries = [ordered]@{}
    foreach ($f in $runtimeFiles) { $firefoxEntries[$f] = $f }
    $firefoxPath = "dist/leaguewise-$version-firefox.xpi"
    New-ZipFromEntries -Path $firefoxPath -Entries $firefoxEntries

    # ---- Chrome/Edge: manifest transformed in-memory ----
    $chromeManifest = $manifestObj | Select-Object * -ExcludeProperty browser_specific_settings
    $chromeManifest.icons = [ordered]@{
        '16'  = 'icons/icon-16.png'
        '32'  = 'icons/icon-32.png'
        '48'  = 'icons/icon-48.png'
        '128' = 'icons/icon-128.png'
    }
    $chromeManifest | Add-Member -NotePropertyName 'minimum_chrome_version' -NotePropertyValue '110'
    $chromeManifestBytes = [Text.Encoding]::UTF8.GetBytes(($chromeManifest | ConvertTo-Json -Depth 10))

    # Plain if/else STATEMENTS, not an if-as-expression assignment - PowerShell's pipeline output unrolls a byte[] into individual bytes (collected as a generic Object[]) when an if-block's value is captured via assignment from an inline `if(){} else{}` expression; imperative assignment inside each branch avoids that entirely.
    $chromeEntries = [ordered]@{}
    foreach ($f in $runtimeFiles) {
        if ($f -eq 'manifest.json') { $chromeEntries[$f] = $chromeManifestBytes }
        else { $chromeEntries[$f] = $f }
    }
    foreach ($f in $iconFiles) { $chromeEntries[$f] = $f }
    $chromePath = "dist/leaguewise-$version-chrome.zip"
    New-ZipFromEntries -Path $chromePath -Entries $chromeEntries

    Write-Output "Built $firefoxPath ($($runtimeFiles.Count) files)"
    Write-Output "Built $chromePath ($($runtimeFiles.Count + $iconFiles.Count) files)"
} finally {
    Pop-Location
}
