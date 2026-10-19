# Builds both release artifacts from one source of truth - run from anywhere, paths are
# resolved relative to the repo root (this script's parent directory).
#
# dist/leaguewise-<version>-firefox.xpi: today's manifest.json verbatim (browser_specific_settings,
#   SVG icons) plus every file reachable from it and from dashboard.html - including the files the
#   manifest NAMES rather than imports, its content scripts and web-accessible resources (B260) -
#   walked live at build time
#   rather than read off a list somebody has to remember to update (B154).
# dist/leaguewise-<version>-chrome.zip: the SAME files, except manifest.json is transformed
#   in-memory (never written to disk) - browser_specific_settings dropped (Chrome warns on/rejects
#   unknown keys), minimum_chrome_version added (storage.session needs Chrome 102+; 110 gives
#   margin), and the icons block swapped from the single SVG to the icons/*.png set (Chrome does
#   not accept SVG manifest icons) - icons/ is added to the zip alongside the runtime files.
#
# dist/leaguewise-<version>.sha256: both artifacts' SHA-256 in `sha256sum -c` form (B261). Every
#   entry's time is pinned, so building one tree twice gives the same bytes and the same hashes.
#
# Version comes from manifest.json itself so this never goes stale on a version bump. Every other
# field (name, permissions, host_permissions, action, ...) is identical between the two artifacts.
# -ListOnly prints the two archives' file lists and builds nothing. PUBLISHING.md forbids building
# a package from THIS repo (the mirror is what gets packaged), so it is the only way to prove what
# the discovery below would ship without breaking that rule.
#
# -ListOnly -Json prints ONE line of JSON instead - the Firefox names, the Chrome names and the Chrome
# manifest as an object - which is how scripts/verify-release.ps1 asks a TAG what it would have
# shipped (B261). It is that script's path on every OS, CI on Linux included, so EVERYTHING above
# the -ListOnly return below must run without Windows: no System.Drawing and no Add-Type, both of
# which stay below it.
param([switch]$ListOnly, [switch]$Json)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
# PowerShell's own location (Push-Location) and .NET's current directory are two separate
# things - relative paths passed into System.IO/System.IO.Compression APIs below resolve
# against the LATTER, which stays wherever the process originally started unless set explicitly.
[Environment]::CurrentDirectory = $root
try {
    # UTF-8 EXPLICITLY. Without -Encoding this PowerShell reads ANSI and pwsh 7 reads UTF-8, so a
    # manifest with one non-ASCII character would give a Linux run of -Json a different Chrome
    # manifest from the one the Windows build shipped - a verification failure on a good release.
    $manifestObj = Get-Content 'manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = $manifestObj.version

    # The complete runtime - the ONLY things that ship. Anything not on this list (dev-preview.html,
    # tests/, JSON_debug/, docs/, ...) never enters either archive.
    # THERE IS NO LIST (B154). Twice a module added months after the hand-kept list was written
    # went missing from it: roster-timeline.js shipped BROKEN in 1.1.0, and matchup-difficulty.js
    # was caught at the 1.3.0 gate by the import check. One dead import kills the whole module
    # graph, and the temporary-install testing everyone does loads from the directory, where
    # nothing is ever missing.
    #
    # The check that caught the second one walked the import graph to VERIFY the list. It builds
    # the list now. Roots are what the browser itself loads - manifest.json's declared files plus
    # the popup document - and everything reachable from there by an ES import or a local src/href
    # is packaged. A module nothing imports is not part of the extension and is not shipped; a
    # module something imports is shipped the moment the import is written.
    $graphRoots = @('dashboard.html')
    $manifestJson = Get-Content 'manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifestJson.action -and $manifestJson.action.default_popup) {
        $graphRoots += $manifestJson.action.default_popup
    }
    foreach ($size in $manifestJson.icons.PSObject.Properties) { $graphRoots += $size.Value }

    # THE TOOLBAR BUTTON'S OWN ICONS (B297). The manifest names them and nothing imports them, the
    # same case as a content script below, so they are roots or they are not shipped.
    #
    # theme_icons IS FIREFOX'S, AND ITS TWO KEYS READ BACKWARDS. By Mozilla's documentation "dark" is
    # the icon shown when the theme's TEXT is dark - which is a LIGHT toolbar - and "light" the one
    # shown when the text is light, a dark toolbar. So the manifest's "dark" entry is the brand's
    # toolbar-light-* file and its "light" entry toolbar-dark-*, the one carrying the hairline that
    # keeps a black tile visible on a dark toolbar (brand/BRAND.md). tests/parse-all.test.js holds
    # the pairing, because swapping it back looks like a correction.
    $toolbarFiles = @()
    if ($manifestJson.action) {
        $di = $manifestJson.action.default_icon
        if ($di -is [string]) { $graphRoots += $di }
        elseif ($di) { foreach ($size in $di.PSObject.Properties) { $graphRoots += $size.Value } }
        foreach ($t in @($manifestJson.action.theme_icons)) {
            foreach ($k in 'light', 'dark') { if ($t -and $t.$k) { $toolbarFiles += $t.$k } }
        }
    }
    $toolbarFiles = @($toolbarFiles | Sort-Object -Unique)
    $graphRoots += $toolbarFiles
    $graphRoots = @($graphRoots | Select-Object -Unique)

    # FILES THE MANIFEST NAMES AND NOTHING IMPORTS (B260). A content script's entry is imported by
    # no module - the BROWSER loads it - and a web-accessible resource is named at manifest level,
    # so neither is reachable from dashboard.html or from the popup. Seeding from those two alone
    # built room-reader.js and room-hook.js out of both archives: a package that installs, runs, and
    # silently never reads the draft room, with no error anywhere to say so. Found while they were
    # being written (4845506), before a release carried it.
    foreach ($cs in @($manifestJson.content_scripts)) {
        foreach ($j in @($cs.js))  { if ($j) { $graphRoots += $j } }
        foreach ($c in @($cs.css)) { if ($c) { $graphRoots += $c } }
    }

    # A RESOURCE MAY BE A GLOB, and the graph walk cannot follow one - "*.js" is not a file, and the
    # walk refuses to build on a path that does not exist. Expanded against the repo here, so the
    # manifest keeps whichever spelling it likes and the packer still ships actual files. A literal
    # entry is passed through untouched.
    $repoBase = (Get-Location).Path
    foreach ($war in @($manifestJson.web_accessible_resources)) {
        foreach ($res in @($war.resources)) {
            if (-not $res) { continue }
            if ($res -match '[*?]') {
                foreach ($hit in @(Get-ChildItem -Path $res -File -ErrorAction SilentlyContinue)) {
                    $graphRoots += ($hit.FullName.Substring($repoBase.Length + 1) -replace '\\', '/')
                }
            } else { $graphRoots += $res }
        }
    }

    # THE PANEL PATH CARRIES A QUERY STRING - "dashboard.html?surface=sidebar" - and the Chrome
    # rewrite below copies it verbatim into side_panel.default_path. Passed through as written it is
    # a file that does not exist and the walk throws, so both are cut at the first ? or #. side_panel
    # is read too although today's manifest has none: the rewrite is in-memory, and a manifest that
    # ever declares the key directly should not need this file edited again to be packaged.
    foreach ($panel in @($manifestJson.sidebar_action.default_panel, $manifestJson.side_panel.default_path)) {
        if ($panel) { $graphRoots += ($panel -split '[?#]')[0] }
    }

    # One file can arrive from several keys (the sidebar panel IS the popup document), and a root
    # enqueued twice is harmless but makes the root count a lie in the line printed below.
    $graphRoots = @($graphRoots | Where-Object { $_ } | Select-Object -Unique)

    # manifest.json roots the graph and is not reachable from it, so it is named here with the
    # icon set below. This is the whole non-graph remainder.
    $nonGraphFiles = @('manifest.json')

    # A SPECIFIER IS RESOLVED AGAINST THE FILE THAT WROTE IT (B288). The modules sit in folders,
    # so './x.js' in src/views/main.js is src/views/x.js and '../data/y.js' is src/data/y.js. The
    # walk used to strip the './' and read what was left as a path from the working directory,
    # which is right only while every module shares one folder, and it did not match '../' at all.
    # A leading '/' and a getURL name a path from the extension's root, which is this directory.
    function Resolve-FromFile([string]$from, [string]$spec) {
        $parts = [System.Collections.Generic.List[string]]::new()
        if (-not $spec.StartsWith('/')) {
            $dir = if ($from.Contains('/')) { $from.Substring(0, $from.LastIndexOf('/')) } else { '' }
            if ($dir) { foreach ($d in $dir.Split('/')) { $parts.Add($d) } }
        }
        foreach ($s in $spec.TrimStart('/').Split('/')) {
            if ($s -eq '' -or $s -eq '.') { continue }
            if ($s -eq '..') { if ($parts.Count) { $parts.RemoveAt($parts.Count - 1) }; continue }
            $parts.Add($s)
        }
        return ($parts -join '/')
    }

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
        # Static ES imports and re-exports, which is most cross-module edge this codebase has.
        foreach ($m in ([regex]::Matches($text, "(?:import|export)[^'`"]+['`"]((?:\.{1,2}/)+[\w./-]+)['`"]"))) {
            $targets += (Resolve-FromFile $file $m.Groups[1].Value)
        }

        # DYNAMIC import(), WHICH THIS FILE USED TO SAY IT COULD NOT SEE. It could: the pattern above
        # spans the opening bracket with [^'"]+, so import('./x.js') has always been followed - by
        # accident, not by intent, and an accident is not a thing to rest a release on. It is matched
        # deliberately here, and the ./ is optional because the next rule needs it to be.
        #
        # A CONTENT SCRIPT CANNOT USE A RELATIVE SPECIFIER AT ALL. import('./room-feed.js') inside a
        # content script resolves against the PAGE - espn.com - not against the extension, so the
        # only form that works is import(browser.runtime.getURL('src/data/room-feed.js')), which the pattern
        # above cannot see and which B252 item 1b is about to write. Followed here as a string
        # literal. Such a module also has to be in web_accessible_resources to load at all, and the
        # roots above already seed from that list, so this is the second of two locks rather than
        # the only one.
        #
        # A COMPUTED SPECIFIER IS UNFOLLOWABLE and always will be: import(someVariable) names a file
        # no regex can know. Nothing in this codebase writes one, and anything that starts to must
        # name the file somewhere this walk can reach - a static import, a manifest entry - or the
        # build will ship a graph with a hole in it and say nothing. THIS is the line to check if
        # that day comes.
        foreach ($m in ([regex]::Matches($text, "import\(\s*['`"](?!https?:)((?:\.{1,2}/)*/?[\w./-]+\.js)['`"]"))) {
            $targets += (Resolve-FromFile $file $m.Groups[1].Value)
        }
        foreach ($m in ([regex]::Matches($text, "runtime\.getURL\(\s*['`"]\.?/?([\w./-]+\.js)['`"]"))) {
            $targets += (Resolve-FromFile '' $m.Groups[1].Value)
        }
        if ($ext -eq '.html') {
            foreach ($m in ([regex]::Matches($text, "(?:src|href)=['`"](?!https?:|#|data:)([\w./-]+)['`"]"))) {
                $targets += (Resolve-FromFile $file $m.Groups[1].Value)
            }
        }
        foreach ($t in $targets) { if ($seen.Add($t)) { $queue.Enqueue($t) } }
    }

    $runtimeFiles = @($nonGraphFiles + ($seen | Sort-Object))
    # Not under -Json: a child process's Write-Host reaches its stdout, and the one line a caller
    # parses must be the only line there.
    if (-not $Json) { Write-Host ("Import graph: {0} files from {1} root(s)." -f $runtimeFiles.Count, $graphRoots.Count) }

    # Declared BEFORE the decode loop below, which reads it. Assigning it after meant $iconFiles was
    # $null there, PowerShell folded that into an empty array, and the loop ran over nothing at all:
    # the one guard standing between a corrupt icon and a build no Chrome user could install had
    # been silently checking zero files.
    $iconFiles = @('icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png')

    # ---- Chrome/Edge: manifest transformed in-memory ----
    # Computed HERE, above the -ListOnly return, so -Json can hand it out; the build below writes this
    # same object, so the listing and the build cannot disagree about it. Pure - no Windows in it.
    $chromeManifest = $manifestObj | Select-Object * -ExcludeProperty browser_specific_settings, sidebar_action
    $chromeManifest.icons = [ordered]@{
        '16'  = 'icons/icon-16.png'
        '32'  = 'icons/icon-32.png'
        '48'  = 'icons/icon-48.png'
        '128' = 'icons/icon-128.png'
    }
    $chromeManifest | Add-Member -NotePropertyName 'minimum_chrome_version' -NotePropertyValue '110'
    # theme_icons is a key Chrome does not have, so it goes the way of the other Firefox-only keys,
    # and the four toolbar files it names are left out of the Chrome package with it: Chrome draws
    # the action's default_icon on every toolbar.
    if ($manifestObj.action -and $manifestObj.action.theme_icons) {
        $chromeManifest.action = $manifestObj.action | Select-Object * -ExcludeProperty theme_icons
    }
    # The Chrome package's files: the runtime without the toolbar pair, and the PNG set, each once -
    # the manifest's own icons already put two of the set among the runtime files.
    $chromeFiles = @($runtimeFiles | Where-Object { $toolbarFiles -notcontains $_ })
    $chromeFiles = @($chromeFiles + ($iconFiles | Where-Object { $chromeFiles -notcontains $_ }))
    # Chrome's own side panel, same URL as Firefox's sidebar_action.default_panel - the two keys
    # say the same thing in each browser's own vocabulary, so this reads the Firefox one rather
    # than repeating the literal string a second place would drift from.
    #
    # ONLY WHEN THERE IS A SIDEBAR (B261). Both used to be added unconditionally, so a manifest with no
    # sidebar_action came out with `side_panel: { default_path: null }` and a sidePanel permission it
    # had no use for. Harmless while the manifest has one; wrong the moment it does not - and 1.6.0's
    # manifest is exactly that case, which is how verify-release found it.
    if ($manifestObj.sidebar_action) {
        $chromeManifest | Add-Member -NotePropertyName 'side_panel' -NotePropertyValue ([ordered]@{
            default_path = $manifestObj.sidebar_action.default_panel
        })
        $chromeManifest.permissions = @($chromeManifest.permissions) + 'sidePanel'
    }

    # The dry listing, and it stops here: nothing below this point writes anything.
    if ($ListOnly -and $Json) {
        $doc = [ordered]@{
            version        = $version
            firefox        = @($runtimeFiles)
            chrome         = @($chromeFiles)
            chromeManifest = $chromeManifest
        }
        # ONE LINE, AND ASCII ONLY. A child process's stdout is decoded by its reader's console code
        # page, which differs between the two PowerShells and between machines; every non-ASCII
        # character goes out as a JSON \u escape instead, which ConvertFrom-Json reads back exactly.
        $text = $doc | ConvertTo-Json -Depth 20 -Compress
        $text = [regex]::Replace($text, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
        Write-Output $text
        return
    }
    if ($ListOnly) {
        Write-Output ("ROOTS ({0}): {1}" -f $graphRoots.Count, ($graphRoots -join ', '))
        Write-Output ""
        Write-Output ("FIREFOX .xpi would hold {0} files:" -f $runtimeFiles.Count)
        $runtimeFiles | ForEach-Object { Write-Output "  $_" }
        Write-Output ""
        $chromeList = @($chromeFiles)
        Write-Output ("CHROME .zip would hold {0} files:" -f $chromeList.Count)
        $chromeList | ForEach-Object { Write-Output "  $_" }
        return
    }

    # Full decode of every packaged image, in the script rather than in review tooling: the 1.0.0
    # icon had a bad IDAT that only a complete decode catches, and header checks passed it into a
    # build no Chrome user could install.
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

    # Entries is an ordered map of zip-entry-name -> either a source file path (string) or raw
    # bytes (used only for the in-memory Chrome manifest, which never touches disk).
    $zipFloor = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    function New-ZipFromEntries {
        param([string]$Path, [System.Collections.Specialized.OrderedDictionary]$Entries)
        if (Test-Path $Path) { Remove-Item $Path -Force }
        $zip = [System.IO.Compression.ZipFile]::Open($Path, 'Create')
        try {
            foreach ($name in $Entries.Keys) {
                $value = $Entries[$name]
                $bytes = if ($value -is [byte[]]) { $value } else { [IO.File]::ReadAllBytes($value) }
                $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
                # EVERY ENTRY'S TIME IS PINNED, so one tree builds to one set of bytes (B261). Left
                # alone it is the moment of the build: measured on two builds of one tree, a few
                # seconds apart, the archives differed in date_time on every entry and in NOTHING
                # else - same names, same order, same content, same CRC, same compressed size, no
                # extra field. The pin is the zip format's own floor, 1980-01-01, because the one
                # date that would mean something - the tag's - is not knowable at build time. The
                # setter keeps the clock time and drops the offset, so the local time zone cannot
                # move it below the floor.
                $entry.LastWriteTime = $zipFloor
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

    # ---- Chrome/Edge: the transformed manifest, computed above the -ListOnly return ----
    $chromeManifestBytes = [Text.Encoding]::UTF8.GetBytes(($chromeManifest | ConvertTo-Json -Depth 10))

    # Plain if/else STATEMENTS, not an if-as-expression assignment - PowerShell's pipeline output
    # unrolls a byte[] into individual bytes (collected as a generic Object[]) when an if-block's
    # value is captured via assignment from an inline `if(){} else{}` expression; imperative
    # assignment inside each branch avoids that entirely.
    $chromeEntries = [ordered]@{}
    foreach ($f in $chromeFiles) {
        if ($f -eq 'manifest.json') { $chromeEntries[$f] = $chromeManifestBytes }
        else { $chromeEntries[$f] = $f }
    }
    $chromePath = "dist/leaguewise-$version-chrome.zip"
    New-ZipFromEntries -Path $chromePath -Entries $chromeEntries

    Write-Output "Built $firefoxPath ($($runtimeFiles.Count) files)"
    Write-Output "Built $chromePath ($($chromeFiles.Count) files)"

    # THE HASH FILE (B261), so a reader can prove the package a store installed is the one the
    # release published: `sha256sum -c leaguewise-<version>.sha256`, run inside dist/. That tool's
    # own format - lowercase hex, TWO spaces, the bare file name - and LF line ends, since GNU
    # sha256sum reads a trailing CR as part of the file name and then reports the file missing.
    # Written through .NET with no BOM for the same reason; Set-Content in this PowerShell adds one.
    $hashPath = "dist/leaguewise-$version.sha256"
    $hashLines = foreach ($artifact in @($firefoxPath, $chromePath)) {
        $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
        "$digest  $([IO.Path]::GetFileName($artifact))"
    }
    [IO.File]::WriteAllText($hashPath, (($hashLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Output ""
    Write-Output "Wrote $hashPath"
    $hashLines | ForEach-Object { Write-Output "  $_" }
} finally {
    Pop-Location
}
