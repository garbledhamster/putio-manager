# Windows installer implementation

The Electron Packager application remains the authoritative desktop payload. Windows packaging adds a native per-user MSI and a Burn EXE containing that exact MSI. The installed application uses the historical Electron profile independently of its install directory.

WiX and its BootstrapperApplications extension are pinned to 6.0.2. The build reads its runtime version and refuses a different tool. Build and audit require Windows and a .NET 8 SDK. Neither .NET nor WiX tooling is installed on an application user's machine.

## Commands and integration

Run these from the repository after building the existing native Packager application:

```text
node scripts/windows-installer/build.mjs
node scripts/windows-installer/audit.mjs
```

Both commands default to `release/PutioManager-win32-{process.arch}` and `release-assets`. Exports accept explicit version, architecture, application/output directories and optional tools directory. Native build architecture must match the host. Existing outputs are refused.

Call `stageWindowsUpdateRuntime(appDirectory)` before packaged application smoke tests. It stages the build's exact Node executable under `resources/update-runtime/node.exe`, its exact-version license and a hash/version/architecture provenance record. It also stages WiX notices and the corresponding-source reference. Repeated staging verifies identical existing bytes instead of replacing them. Build calls this again defensively.

`auditWindowsInstallers(options)` reads the final MSI with DTF in read-only mode, extracts cabinets without invoking installation sequences, and compares every extracted application byte with the Packager payload. It extracts the EXE with `wix burn extract` and requires the embedded MSI to equal the published MSI exactly. It validates native MSI architecture, product and upgrade identities, fixed per-user location, HKCU component key paths, ownership values, upgrade scheduling, shortcuts, file removal rules and absence of unexpected custom actions/binaries. The optional `verifyPayload(directory)` callback runs the shared privacy scanner. The CLI uses the scanner's `app` mode.

The successful audit returns temporary `payloadDirectory`, `bootstrapperDirectory` and `containerDirectory` paths for additional checks, plus hashes and controlled identity fields. Always call the returned `cleanup()` after inspection. Do not publish temporary inspection JSON: it contains private build paths needed only inside the audit.

Failures report a fixed stage and invariant code, plus bounded compiler or DTF operation codes when applicable. They never print extracted metadata, paths, exception messages or compiler output. For example, `audit-helper-build` with a `CS` code identifies a compiler failure; `msi-read` with `DTF_FILES_INVALID` identifies a read-only file-table invariant; `msi-metadata` with `msi-owner-values` identifies the ownership contract. These diagnostics preserve the same fail-closed checks and permit correction from native CI evidence.

## Installed identity

The normal installation directory is `%LOCALAPPDATA%/Programs/PutioManager`. Each CPU architecture has a separate fixed upgrade family; each version has its own deterministic product identity. Before a new installation changes files or removes an earlier version, MSI searches the opposite architecture's fixed 64-bit HKCU `InstallLocation` value and refuses installation if it is present. Both EXE and standalone MSI use that same guard. To switch CPU editions, uninstall the existing edition first; settings and downloaded media remain. Existing-product repair and uninstall remain available even if a conflicting marker is found. Cross-architecture coinstallation and automatic architecture replacement are not supported.

MSI writes three `REG_SZ` values under `HKCU/Software/PutioManager/Installer/application/{arch}`:

- `InstalledVersion`: the exact three-field numeric application version.
- `InstallLocation`: the resolved installation directory, including its normal trailing separator.
- `ProductCode`: the resolved native MSI product code.

The update helper validates these values and the actual running executable location. The portable tree has no installer marker file; including the shared update runtime does not make a portable application an installed product. Uninstall removes application-owned registration and files, preserving userData and downloaded media.

Every MSI payload component has a stable GUID and HKCU registry key path. The generator avoids the per-user `<Files>` harvesting/ICE38 problem. Major upgrades remove the previous version after `InstallInitialize`, inside the rollback transaction.

Burn's chain uses `Permanent="yes" Visible="yes"` so MSI owns uninstall and the temporary EXE is not intended to retain a second servicing identity. This is chain ownership, not permanent MSI file components. One-registration behavior is an acceptance test, not an assumption established by authoring alone.

Native ownership checks use the Windows Installer product API for installation context, product code and version. They separately inspect both HKCU and HKLM Uninstall registry views for duplicate, hidden or stale program records. Hosted x64 and ARM64 evidence showed that a correctly installed per-user MSI can expose its program record under HKLM; the registry hive alone does not determine MSI installation context. Both lifecycle and actual update fixtures require one installed per-user MSI, the expected identity and version, no machine-context product, and one visible MSI program record without a Burn record. The actual update fixture's read-only API inspection additionally requires its generated ownership marker inside the disposable runner work directory.

## Disposable native acceptance

Only the repository's GitHub-hosted Windows runner can execute:

```text
node scripts/windows-installer/native-fixture.mjs --disposable-ci
```

The fixture uses a random separate installer family, generated application files, a generated profile and generated media. It never runs the real application or reads an account profile. A synthetic opposite-architecture marker first proves that the MSI refuses installation before creating an application executable or product record. It then tests EXE A to MSI B, MSI A to EXE B, reinstall, repair using retained source MSI, refused downgrade, an intentionally failed upgrade with rollback, uninstall, one current MSI registration and no surviving Burn registration. It also checks the helper's ownership values and preserved generated profile/media after each step.

Busy/canceled/reboot-required update handoff outcomes belong to the desktop helper's controlled result tests. This installer fixture does not simulate those OS outcomes or claim an unattended installation on an operator machine. Initial installer and DTF compilation plus native acceptance must pass CI before the installer is described as verified working.

After the installer fixture, the same hosted runner executes the actual desktop update acceptance:

```text
node scripts/windows-installer/native-update-test.mjs --disposable-ci
```

This test requires clean production-family installation ownership and an absent default `putio-manager` profile; it refuses to adopt existing data. It builds A from the real Packager payload and B from a copy changing only the packaged application version to the next patch. After installing A, the real installed executable must report A through `--app-update status`.

An external Node child loads the installed A application's real controller, Windows adapter and engine. It supplies an existing `releaseCheck` fixture descriptor and serves only the actual B MSI at the exact trusted GitHub asset URL. Production signature/provider tests remain separate. The real transfer hashes the MSI, closes the generated engine, stages the helper outside the installation and exits only through the adapter's application-quit callback. The detached helper performs real Windows Installer servicing and verifies the installed executable. The test waits for its controlled successful receipt, actual B relaunch and helper exit, verifies B through the real executable CLI and checks one MSI owner, saved pause/deletion choices and generated profile/media. It then stops only the verified fixture-owned application and uninstalls it. No production test flags or alternate installation hooks are added.

## License and source provenance

The exact v6.0.2 OSMF EULA exempts non-revenue-generating use. This free application task uses that stated exemption; public/GPL source alone is not the exemption. The WiX MS-RL notices remain separate from the application GPL license.

Each installer includes WiX notices and a source reference pinned to commit `b3f340393117094a75ea8ced77f2357e4aa095e7`. The release assembler supplies the corresponding source once as `PutioManager-WiX-6.0.2-source.tar.gz`. Windows jobs do not duplicate that asset. Build intermediates and `.wixpdb` files are excluded from publication.
