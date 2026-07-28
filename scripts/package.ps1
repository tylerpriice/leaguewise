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

    # The complete runtime, the ONLY things that ship. Anything off this list never enters
    # either archive. THE LIST IS VERIFIED, NOT TRUSTED: the check below walks every ES import
    # in the packaged modules and every src and href in dashboard.html, and fails the build if a
    # target is missing from it. 1.1.0 shipped broken because a module added long after this list
    # was written was absent from it. One dead import kills the whole module graph, and the
    # temporary-install testing everyone does loads from the directory, where nothing is missing.
    $runtimeFiles = @(
        'manifest.json', 'dashboard.html', 'dashboard.css', 'icon.svg', 'theme-init.js', 'compat.js',
        'api.js', 'controls.js', 'data.js', 'export.js', 'graphs.js', 'main.js', 'players.js',
        'rank-engine.js', 'recap.js', 'roster-timeline.js', 'state.js', 'utils.js',
        'myteam.js', 'images.js', 'probables.js'
    )

    # Every relative ES import in the shipped modules, and every local src/href in dashboard.html, must resolve to a file on the runtime list. Run BEFORE building so a stale list never produces an archive at all.
    $shipSet = @{}
    foreach ($f in $runtimeFiles) { $shipSet[$f] = $true }
    $missing = @()
    foreach ($f in ($runtimeFiles | Where-Object { $_ -like '*.js' })) {
        foreach ($m in ([regex]::Matches((Get-Content $f -Raw), "import[^'`"]+['`"]\./([\w./-]+)['`"]"))) {
            $target = $m.Groups[1].Value
            if (-not $shipSet.ContainsKey($target)) { $missing += "$f imports $target" }
        }
    }
    foreach ($m in ([regex]::Matches((Get-Content 'dashboard.html' -Raw), "(?:src|href)=['`"](?!https?:|#|data:)([\w./-]+)['`"]"))) {
        $target = $m.Groups[1].Value -replace '^\./', ''
        if (-not $shipSet.ContainsKey($target)) { $missing += "dashboard.html references $target" }
    }
    if ($missing.Count -gt 0) {
        throw "Runtime list is incomplete, refusing to build:`n$($missing -join "`n")"
    }

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
