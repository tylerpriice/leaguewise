# Builds both release artifacts from one source of truth - run from anywhere, paths are
# resolved relative to the repo root (this script's parent directory).
#
# dist/leaguewise-<version>-firefox.xpi: today's manifest.json verbatim (browser_specific_settings,
#   SVG icons) plus the 16 other runtime files (see $runtimeFiles below).
# dist/leaguewise-<version>-chrome.zip: the SAME files, except manifest.json is transformed
#   in-memory (never written to disk) - browser_specific_settings dropped (Chrome warns on/rejects
#   unknown keys), minimum_chrome_version added (storage.session needs Chrome 102+; 110 gives
#   margin), and the icons block swapped from the single SVG to the icons/*.png set (Chrome does
#   not accept SVG manifest icons) - icons/ is added to the zip alongside the runtime files.
#
# Version comes from manifest.json itself so this never goes stale on a version bump. Every other
# field (name, permissions, host_permissions, action, ...) is identical between the two artifacts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
# PowerShell's own location (Push-Location) and .NET's current directory are two separate
# things - relative paths passed into System.IO/System.IO.Compression APIs below resolve
# against the LATTER, which stays wherever the process originally started unless set explicitly.
[Environment]::CurrentDirectory = $root
try {
    $manifestObj = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
    $version = $manifestObj.version

    # The complete runtime - the ONLY things that ship. Anything not on this list (dev-preview.html,
    # tests/, JSON_debug/, docs/, .claude/, ...) never enters either archive.
    $runtimeFiles = @(
        'manifest.json', 'dashboard.html', 'dashboard.css', 'icon.svg', 'theme-init.js', 'compat.js',
        'api.js', 'controls.js', 'data.js', 'export.js', 'graphs.js', 'main.js', 'players.js',
        'rank-engine.js', 'recap.js', 'state.js', 'utils.js'
    )
    $iconFiles = @('icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png')

    New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # Entries is an ordered map of zip-entry-name -> either a source file path (string) or raw
    # bytes (used only for the in-memory Chrome manifest, which never touches disk).
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

    # Plain if/else STATEMENTS, not an if-as-expression assignment - PowerShell's pipeline output
    # unrolls a byte[] into individual bytes (collected as a generic Object[]) when an if-block's
    # value is captured via assignment from an inline `if(){} else{}` expression; imperative
    # assignment inside each branch avoids that entirely.
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
