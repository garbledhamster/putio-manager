# Native updater provenance

The macOS updater uses Sparkle 2.10.1, source commit
`ab7d71291238df6e0492143b120c9b696a35f603`:
https://github.com/sparkle-project/Sparkle/tree/ab7d71291238df6e0492143b120c9b696a35f603

Sparkle and its bundled components retain their upstream license notices. The
native build copies Sparkle's complete LICENSE to LICENSE-Sparkle.txt beside the
runtime helper and records its source pin. Source changes are reproducible in
patch-sparkle.mjs: helper identity, HTTPS transport, no system profiling,
allowlisted progress, exact expected version/URL and an asynchronous install gate.
Sparkle's verification, extraction, authorization and replacement code is intact.

Runtime Mac payload authentication uses Sparkle's Ed25519 archive signature before
extraction, plus the exact version and URL selected from the authenticated release.
The publication audit binds that signature to the archive hash and byte count in
the signed release metadata. Linux rehashes downloaded AppImage bytes against the
authenticated SHA-256 and uses same-filesystem atomic replacement.

Native fixtures use independent ephemeral Ed25519 keys and generated profiles.
They do not import production credentials or relax Gatekeeper or the sandbox.

Developer ID signing/notarization can replace the valid ad-hoc baseline when an
authorized signing identity is available. Neither archive signatures nor ad-hoc
code signatures establish notarization or remove normal OS authorization rules.
