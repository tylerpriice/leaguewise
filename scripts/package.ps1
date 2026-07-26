# Builds both release artifacts from one source of truth, with paths resolved relative to the repo root.
# The Firefox xpi ships manifest.json verbatim; the Chrome zip transforms it in memory, dropping the Gecko block, adding minimum_chrome_version, and swapping the SVG icon for the PNG set Chrome requires.
# The version comes from manifest.json, so this never goes stale on a bump, and every other field is identical between the two artifacts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
# PowerShell's location and .NET's current directory are separate: the compression APIs below resolve relative paths against the latter, which stays where the process started unless set explicitly.
[Environment]::CurrentDirectory = $root
try {
    $manifestObj = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
    $version = $manifestObj.version

    # The complete runtime, and the only thing that ships. The list is verified rather than trusted: the check below walks every import and fails the build on a miss, because one dead import kills the whole module graph and a directory-based install never shows it.
    $runtimeFiles = @(
        'manifest.json', 'dashboard.html', 'dashboard.css', 'icon.svg', 'theme-init.js', 'compat.js',
        'api.js', 'controls.js', 'data.js', 'export.js', 'graphs.js', 'main.js', 'players.js',
        'rank-engine.js', 'recap.js', 'roster-timeline.js', 'state.js', 'utils.js'
    )

    # Every relative import in the shipped modules, and every local src or href in dashboard.html, must resolve to a file on the runtime list. This runs BEFORE building, so a stale list never produces an archive at all.
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
    $iconFiles = @('icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png')

    New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # An ordered map of zip entry name to either a source path or raw bytes, the latter only for the in-memory Chrome manifest.
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

    # Plain if/else statements rather than an if-as-expression assignment, because PowerShell unrolls a byte array into individual bytes when an if-block's value is captured that way.
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
