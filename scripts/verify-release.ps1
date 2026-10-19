# PROVES THAT A RELEASE'S PACKAGE IS ITS TAG (B261): every entry of a .xpi or .zip is compared with
# the file the tagged tree holds, and the archive's list of entries with the list the tag's own
# packer says it ships.
#
#   powershell -NoProfile -File scripts/verify-release.ps1 -Artifact <path> -Tag vX.Y.Z [-Repo <repo>]
#                                                          [-HashFile <path>]
#
# -Repo defaults to the repository this script sits in, which is the mirror when it runs there. It
# READS the repository and writes nothing to it: the tag is materialised through a temporary index
# file into a directory of this script's own under the temp root, never through the repository's
# index or working tree.
#
# WHAT IT PROVES, AND WHAT IT DOES NOT. The hash file package.ps1 writes proves that the package a
# store installed is the release's asset; this proves that the release's asset is the tag. Neither
# needs anyone to rebuild the package byte for byte on another machine, which is why the entry order
# and the deflate output - both of which can differ between machines - are not compared at all.
#
# THE CLASSES, each reported by name:
#   MISSING            the tag's packer ships it and the archive lacks it
#   EXTRA              the archive holds it and the tag's packer does not ship it
#   DUPLICATE          two entries under one name. A zip can carry that, and a verifier that checks
#                      one of them while the browser loads the other would pass a tampered package,
#                      so it is refused outright rather than resolved.
#   DIFFERING          bytes that are not the tag's
#   LINE ENDINGS ONLY  the tag's content with its line ends converted - a checkout that converted
#                      them, which is a broken build rather than a tampered one and is named as such
#                      so it is diagnosed instead of mistaken for either a pass or an attack
#
# THE SIGNATURE, the fourth result (B261, Q29 ruled by the owner). From 1.7.0 the hash file is signed
# detached with the owner's key and the public half is committed at the root as RELEASE-KEY.asc. The
# key is read FROM THE TAG, never from beside the package: a replaced download cannot replace a key
# inside the tagged tree. It is imported into a keyring of this script's own, so nobody's own
# keyring is touched. GOOD needs both halves - the signature verifies, AND the signed file lists
# this package under its own name with its own SHA-256; a good signature on a file that does not
# vouch for this package is not a result about it. BAD is a finding. NOT CHECKED - no gpg on the
# path, a tag that carries no key, no hash file or signature beside the package - is said on the
# RESULT line and counted neither as a pass nor as a failure.
#
# EXIT: 0 VERIFIED, every class empty. 1 NOT VERIFIED, a finding. 2 CANNOT VERIFY HERE: a tag whose
# packer predates -ListOnly -Json can only be asked what it ships by building it, and its build
# needs Windows. 3 COULD NOT RUN: bad arguments, a missing tag, or git or the tag's packer failing.
# 2 and 3 are never a pass and never a claim that the package is corrupt.
param(
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Repo = '',
    # Where the release's hash file is; beside the package by default, the way a release's assets
    # download. Its signature is the same path with .asc.
    [string]$HashFile = ''
)
$ErrorActionPreference = 'Stop'
# Resolved here rather than as the parameter's default: Windows PowerShell 5.1 leaves $PSScriptRoot
# empty inside a param block, so the default failed to bind before the script had even started.
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }

function Stop-Run([int]$code, [string]$why) {
    Write-Output $why
    exit $code
}

$onWindows = if ($PSVersionTable.PSEdition -eq 'Desktop') { $true } else { [bool]$IsWindows }
$psExe = (Get-Process -Id $PID).Path
if (-not ('System.IO.Compression.ZipArchive' -as [type])) { Add-Type -AssemblyName System.IO.Compression }

# Latin-1 maps every byte to one character and back, so converting line ends through it is exact for
# any file, text or not.
$latin1 = [Text.Encoding]::GetEncoding(28591)

# ------------------------------------------------------------------------------------------------
# Git's own id for a blob, computed here rather than by `git hash-object --no-filters` on an
# extracted copy. It is the same number by definition - the hash of "blob <length>\0" and the raw
# bytes - and doing it in-process means no extraction directory at all, and no native tool's binary
# output passing through this PowerShell's pipeline, which re-encodes it as text. SHA-256 when the
# repository's ids are 64 hex characters, SHA-1 otherwise.
function Get-BlobId([byte[]]$Bytes, [bool]$Sha256) {
    $hasher = if ($Sha256) { [Security.Cryptography.SHA256]::Create() } else { [Security.Cryptography.SHA1]::Create() }
    try {
        $header = [Text.Encoding]::ASCII.GetBytes("blob $($Bytes.Length)`0")
        $null = $hasher.TransformBlock($header, 0, $header.Length, $null, 0)
        $null = $hasher.TransformFinalBlock($Bytes, 0, $Bytes.Length)
        return (-join ($hasher.Hash | ForEach-Object { $_.ToString('x2') }))
    } finally { $hasher.Dispose() }
}

# Every entry of a zip, in its own order, with its bytes - read from the archive itself, never
# extracted to disk.
function Read-ZipEntries([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
        try {
            foreach ($entry in $zip.Entries) {
                $buffer = [IO.MemoryStream]::new()
                $reader = $entry.Open()
                try { $reader.CopyTo($buffer) } finally { $reader.Dispose() }
                [pscustomobject]@{ Name = $entry.FullName; Bytes = $buffer.ToArray() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}

# ------------------------------------------------------------------------------------------------
# THE CHROME MANIFEST IS THE ONE ENTRY READ BY MEANING RATHER THAN BY BYTES. It is not a file at the
# tag: package.ps1 writes it from the tag's manifest.json, and its bytes are the serialiser's rather
# than the release's - Windows PowerShell 5.1 writes two spaces after every colon and CRLF, pwsh 7
# one space and LF on Linux (measured). A byte comparison would fail every release checked on a
# machine other than the one that built it. So both sides are parsed and compared as JSON: the same
# keys at every depth, nothing extra and nothing missing, the same values, arrays in order, the
# order of an object's keys ignored.
function Get-JsonKind($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return 'bool' }
    if ($Value -is [string]) { return 'string' }
    if ($Value -is [datetime]) { return 'string' }   # pwsh 7 reads an ISO date string as a date
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
function Compare-Json($Archive, $Expected, [string]$At, [System.Collections.Generic.List[string]]$Found) {
    $ka = Get-JsonKind $Archive
    $ke = Get-JsonKind $Expected
    if ($ka -ne $ke) { $Found.Add("$At is a $ka in the archive and a $ke at the tag"); return }
    switch ($ka) {
        'object' {
            $na = Get-JsonKeys $Archive
            $ne = Get-JsonKeys $Expected
            foreach ($k in $na) { if ($ne -cnotcontains $k) { $Found.Add("$At.$k is in the archive only") } }
            foreach ($k in $ne) { if ($na -cnotcontains $k) { $Found.Add("$At.$k is at the tag only") } }
            foreach ($k in $na) {
                if ($ne -ccontains $k) {
                    # Indexed inline, never returned from a helper: a function's output unrolls, and
                    # a one-element array would come back as its element and compare as the wrong kind.
                    $va = if ($Archive -is [System.Collections.IDictionary]) { $Archive[$k] } else { $Archive.PSObject.Properties[$k].Value }
                    $ve = if ($Expected -is [System.Collections.IDictionary]) { $Expected[$k] } else { $Expected.PSObject.Properties[$k].Value }
                    Compare-Json $va $ve "$At.$k" $Found
                }
            }
        }
        'array' {
            $la = @($Archive)
            $le = @($Expected)
            if ($la.Count -ne $le.Count) { $Found.Add("$At holds $($la.Count) in the archive and $($le.Count) at the tag"); return }
            for ($i = 0; $i -lt $la.Count; $i++) { Compare-Json $la[$i] $le[$i] "$At[$i]" $Found }
        }
        'number' { if ([double]$Archive -ne [double]$Expected) { $Found.Add("$At is $Archive in the archive and $Expected at the tag") } }
        'null' { }
        default { if ([string]$Archive -cne [string]$Expected) { $Found.Add("$At is '$Archive' in the archive and '$Expected' at the tag") } }
    }
}

# ------------------------------------------------------------------------------------------------
$tmpRoot = $null
$hadIndex = Test-Path Env:GIT_INDEX_FILE
$priorIndex = $env:GIT_INDEX_FILE
try {
    if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) { Stop-Run 3 "COULD NOT RUN: no such artifact: $Artifact" }
    $Artifact = (Resolve-Path -LiteralPath $Artifact).Path
    $kind = switch -Regex ([IO.Path]::GetExtension($Artifact).ToLowerInvariant()) {
        '^\.xpi$' { 'firefox' }
        '^\.zip$' { 'chrome' }
        default { $null }
    }
    if (-not $kind) { Stop-Run 3 "COULD NOT RUN: $Artifact is neither a .xpi (Firefox) nor a .zip (Chrome)" }
    if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { Stop-Run 3 "COULD NOT RUN: no such repository: $Repo" }
    $Repo = (Resolve-Path -LiteralPath $Repo).Path

    $commit = & git -C $Repo rev-parse --verify --quiet "$Tag^{commit}"
    if ($LASTEXITCODE -ne 0 -or -not $commit) { Stop-Run 3 "COULD NOT RUN: $Repo has no tag or commit named $Tag" }

    # ---- the tag's tree: every blob by path ----
    $tree = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    $lines = & git -C $Repo -c core.quotepath=off ls-tree -r $Tag
    if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: git ls-tree failed for $Tag" }
    foreach ($line in $lines) {
        $tab = $line.IndexOf("`t")
        if ($tab -lt 0) { continue }
        $meta = $line.Substring(0, $tab) -split ' '
        if ($meta[1] -eq 'blob') { $tree[$line.Substring($tab + 1)] = $meta[2] }
    }
    $sha256 = (@($tree.Values)[0].Length -eq 64)

    # ---- the tag, materialised in a directory of this script's own ----
    # A fresh name under the temp root, created here and removed file by file in the finally below:
    # the repository's own index and working tree are never touched, and nothing is ever deleted
    # recursively (golden rule 13).
    $tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ('leaguewise-verify-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $tmpRoot
    $checkout = Join-Path $tmpRoot 'tag'
    $env:GIT_INDEX_FILE = Join-Path $tmpRoot 'index'
    & git -C $Repo read-tree $Tag
    if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: git read-tree failed for $Tag" }
    # CONVERSION OFF, and no links: the files land as the tag's own bytes, and a link in the tag
    # arrives as a plain file rather than as something the clean-up below could follow.
    & git -C $Repo -c core.autocrlf=false -c core.symlinks=false checkout-index -a -f "--prefix=$(($checkout -replace '\\', '/'))/"
    if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: git checkout-index failed for $Tag" }
    if ($hadIndex) { $env:GIT_INDEX_FILE = $priorIndex } else { Remove-Item Env:GIT_INDEX_FILE }

    # ---- ask the TAG what it ships, with the tag's own code ----
    # NEVER TODAY'S PACKER. Copied into an old tag's checkout it would list and transform with today's
    # rules: at 1.6.0 that reports side_panel and a sidePanel permission as differing, because the
    # transform that adds them was written after the release. Every tag is asked with its own code.
    $tagPacker = Join-Path $checkout 'scripts/package.ps1'
    if (-not (Test-Path -LiteralPath $tagPacker)) { Stop-Run 3 "COULD NOT RUN: $Tag carries no scripts/package.ps1" }
    $packerText = [IO.File]::ReadAllText($tagPacker)
    if ($packerText -match '\[switch\]\s*\$Json') {
        $route = 'the tag''s own packer, -ListOnly -Json'
        $out = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tagPacker -ListOnly -Json
        if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: the tag's packer failed to list ($LASTEXITCODE)" }
        $jsonLine = @($out) | Where-Object { $_ -like '{*' } | Select-Object -Last 1
        if (-not $jsonLine) { Stop-Run 3 "COULD NOT RUN: the tag's packer printed no listing" }
        $shipped = $jsonLine | ConvertFrom-Json
        $expectedNames = @(if ($kind -eq 'firefox') { $shipped.firefox } else { $shipped.chrome })
        $expectedManifest = $shipped.chromeManifest
    } else {
        # THE LEGACY PATH, for a tag whose packer predates -ListOnly -Json (1.6.0 and before). Such a
        # packer cannot be asked for a list - a script with no param block takes -ListOnly into $args
        # and runs its build, measured - so it is run AS a build, inside the checkout, and its own
        # archives are read: their names, and the Chrome one's manifest. That is the tag's code
        # exactly, and it needs Windows, because that packer decodes its icons through System.Drawing.
        if (-not $onWindows) {
            Stop-Run 2 "CANNOT VERIFY HERE: $Tag's packer predates -ListOnly -Json, so it can only be asked what it ships by building it, and that build needs Windows. Run this on Windows."
        }
        $route = 'the tag''s own packer, run as a build (it predates -ListOnly -Json)'
        $null = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tagPacker
        if ($LASTEXITCODE -ne 0) { Stop-Run 3 "COULD NOT RUN: the tag's packer failed to build ($LASTEXITCODE)" }
        $tagManifest = [IO.File]::ReadAllText((Join-Path $checkout 'manifest.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $built = Join-Path $checkout "dist/leaguewise-$($tagManifest.version)-$kind.$(if ($kind -eq 'firefox') { 'xpi' } else { 'zip' })"
        if (-not (Test-Path -LiteralPath $built)) { Stop-Run 3 "COULD NOT RUN: the tag's build wrote no $built" }
        $builtEntries = @(Read-ZipEntries $built)
        $expectedNames = @($builtEntries | ForEach-Object { $_.Name })
        $expectedManifest = $null
        if ($kind -eq 'chrome') {
            $m = $builtEntries | Where-Object { $_.Name -ceq 'manifest.json' } | Select-Object -First 1
            if ($m) { $expectedManifest = [Text.Encoding]::UTF8.GetString($m.Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json }
        }
    }

    # ---- the archive ----
    $entries = @(Read-ZipEntries $Artifact)
    $seen = [System.Collections.Generic.Dictionary[string, int]]::new([StringComparer]::Ordinal)
    foreach ($e in $entries) { $seen[$e.Name] = 1 + $(if ($seen.ContainsKey($e.Name)) { $seen[$e.Name] } else { 0 }) }
    $expected = [System.Collections.Generic.HashSet[string]]::new([string[]]$expectedNames, [StringComparer]::Ordinal)

    # SETS, NOT SEQUENCES: the order a packer sorts its entries into is culture-aware and can differ
    # between machines, and an archive in another order is the same archive.
    $missing = [System.Collections.Generic.List[string]]::new()
    $extra = [System.Collections.Generic.List[string]]::new()
    $duplicate = [System.Collections.Generic.List[string]]::new()
    $differing = [System.Collections.Generic.List[string]]::new()
    $eolOnly = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $expected) { if (-not $seen.ContainsKey($name)) { $missing.Add($name) } }
    foreach ($name in $seen.Keys) {
        if ($seen[$name] -gt 1) { $duplicate.Add("$name ($($seen[$name]) entries)") }
        if (-not $expected.Contains($name)) { $extra.Add($name) }
    }

    $byBytes = 0
    $byMeaning = $null
    $compared = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($e in $entries) {
        if (-not $expected.Contains($e.Name) -or -not $compared.Add($e.Name)) { continue }
        if ($kind -eq 'chrome' -and $e.Name -ceq 'manifest.json') {
            $found = [System.Collections.Generic.List[string]]::new()
            try {
                $archiveManifest = [Text.Encoding]::UTF8.GetString($e.Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
                Compare-Json $archiveManifest $expectedManifest 'manifest' $found
            } catch { $found.Add("manifest.json does not parse as JSON: $($_.Exception.Message)") }
            if ($found.Count) { $differing.Add("manifest.json, by meaning: $($found -join '; ')") }
            $byMeaning = if ($found.Count) { 'differs' } else { 'matches' }
            continue
        }
        if (-not $tree.ContainsKey($e.Name)) { $differing.Add("$($e.Name) (the tag holds no such file)"); continue }
        $want = $tree[$e.Name]
        if ((Get-BlobId $e.Bytes $sha256) -eq $want) { $byBytes++; continue }
        $text = $latin1.GetString($e.Bytes)
        $lf = $text.Replace("`r`n", "`n")
        $crlf = $lf.Replace("`n", "`r`n")
        if ((Get-BlobId $latin1.GetBytes($lf) $sha256) -eq $want -or (Get-BlobId $latin1.GetBytes($crlf) $sha256) -eq $want) {
            $eolOnly.Add($e.Name)
        } else {
            $differing.Add($e.Name)
        }
    }

    # ---- the fourth result: the hash file's signature ----
    $sigState = 'NOT CHECKED'
    $sigWhy = ''
    $keyPath = Join-Path $checkout 'RELEASE-KEY.asc'
    $tagVersion = ([IO.File]::ReadAllText((Join-Path $checkout 'manifest.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).version
    if (-not $HashFile) { $HashFile = Join-Path (Split-Path -Parent $Artifact) "leaguewise-$tagVersion.sha256" }
    $sigPath = "$HashFile.asc"
    $gpg = Get-Command gpg -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $keyPath)) { $sigWhy = "$Tag carries no RELEASE-KEY.asc (releases are signed from 1.7.0)" }
    elseif (-not $gpg) { $sigWhy = 'gpg is not on the path' }
    elseif (-not (Test-Path -LiteralPath $HashFile)) { $sigWhy = "no hash file beside the package ($HashFile)" }
    elseif (-not (Test-Path -LiteralPath $sigPath)) { $sigWhy = "no signature beside the hash file ($sigPath)" }
    else {
        $keyring = Join-Path $tmpRoot 'gnupg'
        $null = New-Item -ItemType Directory -Path $keyring
        $ring = $keyring -replace '\\', '/'
        # gpg reports on stderr, and this PowerShell turns a redirected native stderr line into a
        # terminating error under 'Stop'; the verdict is read from --status-fd instead, so stderr is
        # discarded under 'Continue' for these calls only.
        $ErrorActionPreference = 'Continue'
        try {
            $imported = @(& $gpg.Source --homedir $ring --batch --status-fd 1 --import $keyPath 2>$null)
            $status = @(& $gpg.Source --homedir $ring --batch --status-fd 1 --verify $sigPath $HashFile 2>$null)
        } finally {
            # A keyring gpg has touched can leave a daemon holding it open, which would stop the
            # file-by-file clean-up below; it is stopped for THIS keyring only.
            $gpgconf = Get-Command gpgconf -ErrorAction SilentlyContinue
            if ($gpgconf) { $null = & $gpgconf.Source --homedir $ring --kill all 2>$null }
            $ErrorActionPreference = 'Stop'
        }
        # BAD ONLY ON GPG'S OWN VERDICT. A gpg that could not run is not a bad signature: measured here,
        # the gpg that ships inside Git for Windows cannot start its agent in a keyring whose path
        # carries a drive letter - "':' are not allowed in the socket name" - and a check that read
        # every silence as BAD would call a good release tampered on any such machine. So a verdict
        # line decides GOOD or BAD, and no verdict is NOT CHECKED, with the reason.
        $status = @($status)
        $valid = $status | Where-Object { $_ -like '`[GNUPG:`] VALIDSIG *' } | Select-Object -First 1
        $good = $status | Where-Object { $_ -like '`[GNUPG:`] GOODSIG *' } | Select-Object -First 1
        $refusal = $status | Where-Object { $_ -match '^\[GNUPG:\] (BADSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NODATA|NO_PUBKEY)\b' } | Select-Object -First 1
        if (-not (@($imported) -match '^\[GNUPG:\] IMPORT_OK\b')) {
            $sigWhy = "$Tag's RELEASE-KEY.asc did not import (gpg could not run in a keyring here, or the file is not a public key)"
        } elseif ($refusal) {
            $sigState = 'BAD'
            $word = ($refusal -split ' ')[1]
            $sigWhy = switch ($word) {
                'BADSIG' { "gpg reports BADSIG: the hash file was changed after it was signed" }
                'NO_PUBKEY' { "gpg reports NO_PUBKEY: the signature was not made by the key $Tag carries" }
                'NODATA' { "gpg reports NODATA: the file beside the hash file is not a signature" }
                default { "gpg reports ${word}: signed by an expired or revoked key" }
            }
        } elseif (-not ($valid -and $good)) {
            $sigWhy = 'gpg ran but gave no verdict'
        } else {
            $fingerprint = ($valid -split ' ')[-1]
            $mine = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash.ToLowerInvariant()
            $leaf = [IO.Path]::GetFileName($Artifact)
            $listed = [IO.File]::ReadAllLines($HashFile) | Where-Object { $_ -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -ceq $leaf } |
                ForEach-Object { ($_ -split ' ')[0].ToLowerInvariant() } | Select-Object -First 1
            if ($listed -eq $mine) {
                $sigState = 'GOOD'
                $sigWhy = "signed by $fingerprint, the key $Tag carries, and it lists this package's hash"
            } else {
                $sigState = 'BAD'
                $sigWhy = if ($listed) { "the signed hash file lists $leaf as $listed, and this package is $mine" } else { "the signed hash file does not list $leaf at all" }
            }
        }
    }

    # ---- the report ----
    $sorted = { param($list) $a = @($list); [Array]::Sort($a, [StringComparer]::Ordinal); $a }
    Write-Output ("verify-release: {0} against {1} ({2})" -f [IO.Path]::GetFileName($Artifact), $Tag, $kind)
    Write-Output ("  listed by {0}" -f $route)
    Write-Output ("  entries in the archive: {0}; shipped by the tag: {1}" -f $entries.Count, $expected.Count)
    Write-Output ("  compared by bytes against the tag's blobs: {0}{1}" -f $byBytes, $(if ($byMeaning) { "; manifest.json by meaning: $byMeaning" } else { '' }))
    foreach ($class in @(
            @('MISSING           ', $missing),
            @('EXTRA             ', $extra),
            @('DUPLICATE         ', $duplicate),
            @('DIFFERING         ', $differing),
            @('LINE ENDINGS ONLY ', $eolOnly))) {
        foreach ($item in (& $sorted $class[1])) { Write-Output ("  {0} {1}" -f $class[0], $item) }
    }
    $sigLine = if ($sigState -eq 'NOT CHECKED') { "signature not checked here: $sigWhy" } else { $sigWhy }
    Write-Output ("  SIGNATURE          {0} - {1}" -f $sigState, $sigLine)
    $counts = "{0} missing, {1} extra, {2} duplicate, {3} differing, {4} line endings only" -f $missing.Count, $extra.Count, $duplicate.Count, $differing.Count, $eolOnly.Count
    $sigNote = if ($sigState -eq 'GOOD') { 'signature good' } else { $sigLine }
    if ($sigState -eq 'BAD') {
        Write-Output "RESULT: NOT VERIFIED - the signature is BAD ($counts; $sigWhy)"
        exit 1
    }
    if ($missing.Count + $extra.Count + $duplicate.Count + $differing.Count + $eolOnly.Count -eq 0) {
        Write-Output "RESULT: VERIFIED - every entry is the tag's ($($compared.Count) compared; $counts; $sigNote)"
        exit 0
    }
    if ($missing.Count + $extra.Count + $duplicate.Count + $differing.Count -eq 0) {
        Write-Output "RESULT: NOT VERIFIED - the tag's content with converted line endings ($counts). The package was built from a checkout that converts line ends; rebuild from one that does not."
        exit 1
    }
    Write-Output "RESULT: NOT VERIFIED - this package is not the tag ($counts)"
    exit 1
} catch {
    # AN ERROR IS NOT A FINDING. Left to itself a terminating error exits 1, which is NOT VERIFIED's
    # code - so a crash would read as "this package is not the tag". It is COULD NOT RUN instead.
    Write-Output "COULD NOT RUN: $($_.Exception.Message)"
    exit 3
} finally {
    if ($hadIndex) { $env:GIT_INDEX_FILE = $priorIndex } elseif (Test-Path Env:GIT_INDEX_FILE) { Remove-Item Env:GIT_INDEX_FILE }
    # FILE BY FILE, THEN EACH EMPTIED DIRECTORY, NEVER A RECURSIVE DELETE (golden rule 13), and only
    # ever inside the directory this run created: every path is checked against its prefix first.
    if ($tmpRoot -and (Test-Path -LiteralPath $tmpRoot)) {
        $prefix = $tmpRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        foreach ($f in @(Get-ChildItem -LiteralPath $tmpRoot -Recurse -File -Force)) {
            if ($f.FullName.StartsWith($prefix, [StringComparison]::Ordinal)) { Remove-Item -LiteralPath $f.FullName -Force }
        }
        foreach ($d in @(Get-ChildItem -LiteralPath $tmpRoot -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending)) {
            if ($d.FullName.StartsWith($prefix, [StringComparison]::Ordinal)) { Remove-Item -LiteralPath $d.FullName -Force }
        }
        Remove-Item -LiteralPath $tmpRoot -Force
    }
}
