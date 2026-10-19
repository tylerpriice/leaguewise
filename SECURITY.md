# Security

## Supported versions

Only the latest release is supported. Security fixes land in a new release, not in older ones.

## Reporting a vulnerability

Report it privately through this repository's **Security** tab, using **Report a vulnerability**. That is the only channel for security reports. Please don't open a public issue for one.

Include the version, the browser, and the steps that show the problem.

## Scope

In scope:

- The Leaguewise packages on the Firefox Add-ons store and the Chrome Web Store
- This repository, including its scripts and workflows

Out of scope:

- ESPN's own website, API, and accounts. Report those to ESPN.

## Verifying a release

Every release from 1.7.0 on is signed. Its GitHub release carries the two packages, a hash file listing their SHA-256, and a signature over that hash file made with the release key.

Release key fingerprint: F1D4 8378 26F4 78F8 5A12 F11B 1E54 9722 1A06 0045

The public key is `RELEASE-KEY.asc` at the root of this repository.

1. From the release, download the package you want, `leaguewise-X.Y.Z.sha256`, and `leaguewise-X.Y.Z.sha256.asc`.
2. Check the signature on the hash file:

   ```
   gpg --import RELEASE-KEY.asc
   gpg --verify leaguewise-X.Y.Z.sha256.asc leaguewise-X.Y.Z.sha256
   ```

   gpg reports a good signature, and the fingerprint it prints matches the one above.

3. Check the package against the hash file:

   ```
   sha256sum --check --ignore-missing leaguewise-X.Y.Z.sha256
   ```

   On Windows, `Get-FileHash <package>` prints the SHA-256 to compare with the hash file's line.

4. To check the package against the source, file by file, clone the repository at the release's tag and run its verification script with PowerShell:

   ```
   git clone --branch vX.Y.Z https://github.com/tylerpriice/leaguewise
   cd leaguewise
   pwsh scripts/verify-release.ps1 -Artifact ../leaguewise-X.Y.Z-firefox.xpi -Tag vX.Y.Z
   ```

   It prints `RESULT: VERIFIED` when every file in the package is the tagged source.

When a release is published, GitHub runs these same checks. The result is on this repository's **Actions** tab, under **Verify release**.

The copies the stores install are signed by the stores, which adds the stores' own signature files to each package. Those files aren't part of this repository, so run these checks on the packages attached to the release.
