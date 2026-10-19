# PROVES THAT THE PACKAGE A STORE SERVES IS THE TAG ITS OWN MANIFEST NAMES: every entry of the
# downloaded file is compared with the file the tagged tree holds, by name, size and SHA-256.
#
#   pwsh -NoProfile -File store-parity.ps1 -Package <file> -PrintVersion
#   pwsh -NoProfile -File store-parity.ps1 -Package <file> -Store amo|chrome -TagDir <dir> [-Summary <file>]
#
# -Package is the file as the store served it: a signed .xpi from addons.mozilla.org, or the CRX3
# the Chrome Web Store's update endpoint answers with. -TagDir is a checkout of the tag named by the
# package's own manifest version, made with line-end conversion off so its files are the tag's
# bytes. -PrintVersion prints that version and stops, which is how a caller learns which tag to
# check out. It reads both and writes nothing but the summary.
#
# verify-release.ps1 proves a RELEASE'S asset is its tag. This is the next link: the file a store
# hands a browser is not the release's asset - each store signs what it was sent and serves its own
# file - so it is checked on its own, on a schedule, for as long as the store serves it.
#
# A CRX3 IS A ZIP BEHIND A HEADER. Four bytes of magic ("Cr24"), a little-endian uint32 version, a
# little-endian uint32 header length at offset 8, the header, then the zip - at offset 12 plus that
# length. Only version 3 is read: version 2 lays its header out differently, and a parser that
# guessed would compare the wrong bytes and could call them equal.
#
# WHAT A STORE ADDS, AND NOTHING ELSE, IS IGNORED: its signature files, under META-INF/ for
# addons.mozilla.org and _metadata/ for the Chrome Web Store. An entry anywhere else that the tag
# does not hold is EXTRA and fails the run.
#
# THE MANIFEST IS READ BY MEANING. Chrome's is not a file at the tag at all: the tag's packer
# writes it from manifest.json, and the store then adds a key of its own. So both sides are parsed
# and compared as JSON - the same keys at every depth, the same values, arrays in order - and every
# difference is listed. The differences allowed are named in this file, per store, and any other
# fails the run.
#
# THE CLASSES, each reported by name:
#   MISSING     the tag's packer ships it and the package lacks it
#   EXTRA       the package holds it, it is not a store's signature file, and the tag does not ship it
#   DUPLICATE   two entries under one name; a browser may load either, so it is refused outright
#   DIFFERING   the same name with other bytes, or a manifest that differs beyond what is allowed
#
# WHAT THE TAG SHIPS is asked of the tag's own packer (scripts/package.ps1 -ListOnly -Json), never of
# today's. A tag whose packer predates that switch (1.6.0 and before) cannot be asked without
# building it, so for such a tag MISSING is reported as NOT CHECKED, the Chrome manifest is compared
# against the transform that packer documents, and every entry the package does hold is still
# compared with the tag's file.
#
# EXIT: 0 the package is the tag. 1 a finding. 3 could not run - a file that is neither a zip nor a
# CRX3, a manifest that does not parse, a missing argument. 3 is never a pass.
param(
    [Parameter(Mandatory = $true)][string]$Package,
    [ValidateSet('amo', 'chrome')][string]$Store = 'amo',
    [string]$TagDir = '',
    [string]$Summary = '',
    [switch]$PrintVersion
)
$ErrorActionPreference = 'Stop'

# Written to the host, not to the output stream: this is called from inside functions whose output
# is their return value, where a line written as output would be swallowed and the run would end
# with a code and no reason.
function Stop-Run([int]$code, [string]$why) {
    Write-Host $why
    exit $code
}
if (-not ('System.IO.Compression.ZipArchive' -as [type])) { Add-Type -AssemblyName System.IO.Compression }
$psExe = (Get-Process -Id $PID).Path

# The stores' own files, the only entries left out of the comparison.
$storeFiles = @{ amo = 'META-INF/'; chrome = '_metadata/' }

# THE MANIFEST DIFFERENCES A STORE IS ALLOWED, each a path in the parsed JSON. The Chrome Web Store
# adds update_url to the manifest it serves. Nothing is listed for addons.mozilla.org; if it turns
# out to alter the manifest, the run fails with the difference named, and adding it here is then a
# decision somebody makes rather than a tolerance nobody chose.
$storeAdds = @{ amo = @(); chrome = @('manifest.update_url') }

# THE TRANSFORM OF A PACKER THAT CANNOT LIST (1.6.0 and before), as its own header documents it:
# browser_specific_settings dropped, minimum_chrome_version added, the icons block swapped for the
# PNG set. Used only for such a tag, and only for Chrome.
$legacyTransform = @('manifest.browser_specific_settings', 'manifest.minimum_chrome_version', 'manifest.icons')

function Get-Sha256([byte[]]$Bytes) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })) } finally { $hasher.Dispose() }
}

# The zip inside the file, as bytes: the file itself for a plain zip, the part after the header for
# a CRX3.
function Get-ZipBytes([byte[]]$File) {
    if ($File.Length -lt 16) { Stop-Run 3 'COULD NOT RUN: the package is too short to be a zip or a CRX' }
    $magic = [Text.Encoding]::ASCII.GetString($File, 0, 4)
    if ($magic -eq "PK$([char]3)$([char]4)") { return , $File }
    if ($magic -ne 'Cr24') { Stop-Run 3 'COULD NOT RUN: the package is neither a zip nor a CRX (no PK and no Cr24 magic)' }
    $version = [BitConverter]::ToUInt32($File, 4)
    if (-not [BitConverter]::IsLittleEndian) { Stop-Run 3 'COULD NOT RUN: this machine is big-endian and the CRX header is read little-endian' }
    if ($version -ne 3) { Stop-Run 3 "COULD NOT RUN: a CRX of version $version; only version 3 is read" }
    $headerLength = [BitConverter]::ToUInt32($File, 8)
    $start = 12 + [long]$headerLength
    if ($start + 4 -gt $File.Length) { Stop-Run 3 "COULD NOT RUN: the CRX header claims $headerLength bytes and the file holds $($File.Length)" }
    if ([Text.Encoding]::ASCII.GetString($File, [int]$start, 2) -ne 'PK') { Stop-Run 3 'COULD NOT RUN: no zip where the CRX header says it starts' }
    $zip = New-Object byte[] ($File.Length - $start)
    [Array]::Copy($File, $start, $zip, 0, $zip.Length)
    return , $zip
}

# Every entry of the zip with its bytes, read in memory and never extracted. A directory entry is a
# name ending in a slash with nothing in it, and is not a file.
function Read-ZipEntries([byte[]]$Zip) {
    $stream = New-Object IO.MemoryStream (, $Zip)
    try {
        $archive = New-Object IO.Compression.ZipArchive ($stream, [IO.Compression.ZipArchiveMode]::Read)
        try {
            foreach ($entry in $archive.Entries) {
                if ($entry.FullName.EndsWith('/')) { continue }
                $buffer = New-Object IO.MemoryStream
                $reader = $entry.Open()
                try { $reader.CopyTo($buffer) } finally { $reader.Dispose() }
                [pscustomobject]@{ Name = $entry.FullName; Bytes = $buffer.ToArray() }
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
}

function Read-Json([byte[]]$Bytes, [string]$What) {
    try { return ([Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json) }
    catch { Stop-Run 3 "COULD NOT RUN: $What does not parse as JSON" }
}

# The same comparison verify-release.ps1 makes, with the two sides named for this check.
function Get-JsonKind($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return 'bool' }
    if ($Value -is [string]) { return 'string' }
    if ($Value -is [datetime]) { return 'string' }
    if ($Value -is [System.Management.Automation.PSCustomObject]) { return 'object' }
    if ($Value -is [System.Collections.IDictionary]) { return 'object' }
    if ($Value -is [System.Collections.IEnumerable]) { return 'array' }
    if ($Value -is [ValueType]) { return 'number' }
    return 'other'
}
function Get-JsonKeys($Object) {
    if ($Object -is [System.Collections.IDictionary]) { return @($Object.Keys) }
    return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}
# Each difference is recorded as its PATH and a sentence, so an allowed path can be told from any
# other without reading the sentence.
function Compare-Json($Served, $Expected, [string]$At, [System.Collections.Generic.List[object]]$Found) {
    $ks = Get-JsonKind $Served
    $ke = Get-JsonKind $Expected
    if ($ks -ne $ke) { $Found.Add([pscustomobject]@{ Path = $At; Text = "$At is a $ks in the package and a $ke at the tag" }); return }
    switch ($ks) {
        'object' {
            $ns = Get-JsonKeys $Served
            $ne = Get-JsonKeys $Expected
            foreach ($k in $ns) { if ($ne -cnotcontains $k) { $Found.Add([pscustomobject]@{ Path = "$At.$k"; Text = "$At.$k is in the package only" }) } }
            foreach ($k in $ne) { if ($ns -cnotcontains $k) { $Found.Add([pscustomobject]@{ Path = "$At.$k"; Text = "$At.$k is at the tag only" }) } }
            foreach ($k in $ns) {
                if ($ne -ccontains $k) {
                    $vs = if ($Served -is [System.Collections.IDictionary]) { $Served[$k] } else { $Served.PSObject.Properties[$k].Value }
                    $ve = if ($Expected -is [System.Collections.IDictionary]) { $Expected[$k] } else { $Expected.PSObject.Properties[$k].Value }
                    Compare-Json $vs $ve "$At.$k" $Found
                }
            }
        }
        'array' {
            $ls = @($Served)
            $le = @($Expected)
            if ($ls.Count -ne $le.Count) { $Found.Add([pscustomobject]@{ Path = $At; Text = "$At holds $($ls.Count) in the package and $($le.Count) at the tag" }); return }
            for ($i = 0; $i -lt $ls.Count; $i++) { Compare-Json $ls[$i] $le[$i] "$At[$i]" $Found }
        }
        'number' { if ([double]$Served -ne [double]$Expected) { $Found.Add([pscustomobject]@{ Path = $At; Text = "$At is $Served in the package and $Expected at the tag" }) } }
        'null' { }
        default { if ([string]$Served -cne [string]$Expected) { $Found.Add([pscustomobject]@{ Path = $At; Text = "$At is '$Served' in the package and '$Expected' at the tag" }) } }
    }
}
# Is this difference inside one of the allowed paths? The path itself, or anything beneath it.
function Test-Allowed([string]$Path, [string[]]$Allowed) {
    foreach ($a in $Allowed) { if ($Path -ceq $a -or $Path.StartsWith("$a.") -or $Path.StartsWith("$a[")) { return $true } }
    return $false
}

# ------------------------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Package -PathType Leaf)) { Stop-Run 3 "COULD NOT RUN: no such package: $Package" }
$fileBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Package).Path)
$container = if ([Text.Encoding]::ASCII.GetString($fileBytes, 0, [Math]::Min(4, $fileBytes.Length)) -eq 'Cr24') { 'CRX3' } else { 'zip' }
$entries = @(Read-ZipEntries (Get-ZipBytes $fileBytes))
$servedManifestEntry = $entries | Where-Object { $_.Name -ceq 'manifest.json' } | Select-Object -First 1
if (-not $servedManifestEntry) { Stop-Run 3 'COULD NOT RUN: the package holds no manifest.json' }
$servedManifest = Read-Json $servedManifestEntry.Bytes "the package's manifest.json"
$version = [string]$servedManifest.version
if ($version -notmatch '^\d+(\.\d+){1,3}$') { Stop-Run 3 "COULD NOT RUN: the package's manifest names no usable version ('$version')" }
if ($PrintVersion) { Write-Output $version; exit 0 }

if (-not $TagDir -or -not (Test-Path -LiteralPath $TagDir -PathType Container)) { Stop-Run 3 "COULD NOT RUN: no such tag checkout: $TagDir" }
$TagDir = (Resolve-Path -LiteralPath $TagDir).Path
$tagManifestPath = Join-Path $TagDir 'manifest.json'
if (-not (Test-Path -LiteralPath $tagManifestPath)) { Stop-Run 3 "COULD NOT RUN: $TagDir holds no manifest.json" }
$tagManifest = Read-Json ([IO.File]::ReadAllBytes($tagManifestPath)) "the tag's manifest.json"
# The checkout must BE the version the package names, or every row below compares the wrong tree.
if ([string]$tagManifest.version -cne $version) { Stop-Run 3 "COULD NOT RUN: the package is version $version and the checkout is $($tagManifest.version)" }

# ---- what the tag ships, asked of the tag's own packer where it can answer ----
$expectedNames = $null
$expectedManifest = $tagManifest
$allowed = @($storeAdds[$Store])
$route = 'the tag''s own packer, -ListOnly -Json'
$tagPacker = Join-Path $TagDir 'scripts/package.ps1'
$canList = (Test-Path -LiteralPath $tagPacker) -and ([IO.File]::ReadAllText($tagPacker) -match '\[switch\]\s*\$Json')
if ($canList) {
    $out = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tagPacker -ListOnly -Json
    if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: the tag's packer failed to list ($LASTEXITCODE)" }
    $jsonLine = @($out) | Where-Object { $_ -like '{*' } | Select-Object -Last 1
    if (-not $jsonLine) { Stop-Run 3 'COULD NOT RUN: the tag''s packer printed no listing' }
    $shipped = $jsonLine | ConvertFrom-Json
    $expectedNames = @(if ($Store -eq 'amo') { $shipped.firefox } else { $shipped.chrome })
    if ($Store -eq 'chrome') { $expectedManifest = $shipped.chromeManifest }
} else {
    $route = 'the tag''s tree (its packer predates -ListOnly -Json, so MISSING is not checked)'
    if ($Store -eq 'chrome') { $allowed += $legacyTransform }
}

# ---- every entry of the package against the tag's file ----
$missing = New-Object System.Collections.Generic.List[string]
$extra = New-Object System.Collections.Generic.List[string]
$duplicate = New-Object System.Collections.Generic.List[string]
$differing = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]
$ignored = 0
$identical = 0
$manifestNote = ''
$seen = New-Object 'System.Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)
foreach ($e in $entries) { $seen[$e.Name] = 1 + $(if ($seen.ContainsKey($e.Name)) { $seen[$e.Name] } else { 0 }) }
foreach ($name in $seen.Keys) { if ($seen[$name] -gt 1) { $duplicate.Add("$name ($($seen[$name]) entries)") } }

$compared = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($e in ($entries | Sort-Object { $_.Name })) {
    if ($e.Name.StartsWith($storeFiles[$Store], [StringComparison]::Ordinal)) { $ignored++; continue }
    if (-not $compared.Add($e.Name)) { continue }
    $servedHash = Get-Sha256 $e.Bytes
    # A name is joined to the checkout only when it is a plain relative path; one that climbs out of
    # it, or names a drive or a root, is not a file the tag could hold and is reported as extra.
    $safe = ($e.Name -notmatch '(^|/)\.\.(/|$)') -and ($e.Name -notmatch '^[/\\]') -and ($e.Name -notmatch ':') -and ($e.Name -notmatch '\\')
    $tagPath = if ($safe) { Join-Path $TagDir ($e.Name -replace '/', [IO.Path]::DirectorySeparatorChar) } else { $null }
    $isManifest = ($e.Name -ceq 'manifest.json')

    if ($isManifest) {
        $found = New-Object System.Collections.Generic.List[object]
        Compare-Json $servedManifest $expectedManifest 'manifest' $found
        $bad = @($found | Where-Object { -not (Test-Allowed $_.Path $allowed) })
        $ok = @($found | Where-Object { Test-Allowed $_.Path $allowed })
        if ($bad.Count) {
            $differing.Add("manifest.json, by meaning: $(($bad | ForEach-Object { $_.Text }) -join '; ')")
            $verdict = 'DIFFERING'
        } else {
            $identical++
            $verdict = if ($found.Count) { 'same, by meaning' } else { 'same' }
        }
        if ($ok.Count) { $manifestNote = "allowed: $(($ok | ForEach-Object { $_.Text }) -join '; ')" }
        $rows.Add([pscustomobject]@{ Name = $e.Name; Served = $e.Bytes.Length; Tag = '-'; Hash = $servedHash; Verdict = $verdict })
        continue
    }
    if ($expectedNames -and ($expectedNames -cnotcontains $e.Name)) {
        $extra.Add($e.Name)
        $rows.Add([pscustomobject]@{ Name = $e.Name; Served = $e.Bytes.Length; Tag = '-'; Hash = $servedHash; Verdict = 'EXTRA' })
        continue
    }
    if (-not $tagPath -or -not (Test-Path -LiteralPath $tagPath -PathType Leaf)) {
        $extra.Add("$($e.Name) (the tag holds no such file)")
        $rows.Add([pscustomobject]@{ Name = $e.Name; Served = $e.Bytes.Length; Tag = '-'; Hash = $servedHash; Verdict = 'EXTRA' })
        continue
    }
    $tagBytes = [IO.File]::ReadAllBytes($tagPath)
    $same = ($tagBytes.Length -eq $e.Bytes.Length) -and ((Get-Sha256 $tagBytes) -eq $servedHash)
    if ($same) { $identical++ } else { $differing.Add($e.Name) }
    $rows.Add([pscustomobject]@{ Name = $e.Name; Served = $e.Bytes.Length; Tag = $tagBytes.Length; Hash = $servedHash; Verdict = $(if ($same) { 'same' } else { 'DIFFERING' }) })
}
if ($expectedNames) { foreach ($name in $expectedNames) { if (-not $seen.ContainsKey($name)) { $missing.Add($name) } } }

$findings = $missing.Count + $extra.Count + $duplicate.Count + $differing.Count
$storeName = if ($Store -eq 'amo') { 'addons.mozilla.org' } else { 'Chrome Web Store' }
$result = if ($findings) { 'NOT THE TAG' } else { 'THE TAG' }
$missingText = if ($expectedNames) { "$($missing.Count) missing" } else { 'missing NOT CHECKED' }
$line = "RESULT: $storeName serves $version as a $container - $result. $identical of $($rows.Count) entries the same, $missingText, $($extra.Count) extra, $($duplicate.Count) duplicated, $($differing.Count) differing; $ignored of the store's own files left out."

$report = New-Object System.Collections.Generic.List[string]
$report.Add("### $storeName, version $version")
$report.Add('')
$report.Add($line)
$report.Add('')
$report.Add("What the tag ships was read from $route.")
if ($manifestNote) { $report.Add(''); $report.Add("The manifest, $manifestNote.") }
foreach ($pair in @(@('MISSING', $missing), @('EXTRA', $extra), @('DUPLICATE', $duplicate), @('DIFFERING', $differing))) {
    if ($pair[1].Count) { $report.Add(''); $report.Add("**$($pair[0])**"); foreach ($item in $pair[1]) { $report.Add("- $item") } }
}
$report.Add('')
$report.Add('| entry | bytes served | bytes at the tag | SHA-256 served | |')
$report.Add('|---|---:|---:|---|---|')
foreach ($r in $rows) { $report.Add("| ``$($r.Name)`` | $($r.Served) | $($r.Tag) | ``$($r.Hash)`` | $($r.Verdict) |") }
$report.Add('')

if ($Summary) { [IO.File]::AppendAllText($Summary, (($report -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false)) }
Write-Output $line
foreach ($pair in @(@('MISSING', $missing), @('EXTRA', $extra), @('DUPLICATE', $duplicate), @('DIFFERING', $differing))) {
    foreach ($item in $pair[1]) { Write-Output "  $($pair[0]): $item" }
}
if ($manifestNote) { Write-Output "  manifest, $manifestNote" }
if ($findings) { exit 1 }
exit 0
