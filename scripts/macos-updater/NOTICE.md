# Native updater provenance

The macOS updater uses Sparkle 2.10.1, source commit
`ab7d71291238df6e0492143b120c9b696a35f603`:
https://github.com/sparkle-project/Sparkle/tree/ab7d71291238df6e0492143b120c9b696a35f603

Sparkle and its bundled components retain their upstream license notices. The
native build copies Sparkle's complete LICENSE to LICENSE-Sparkle.txt beside the
runtime helper and records its source pin. Source changes are reproducible in
patch-sparkle.mjs: helper identity, HTTPS transport, no system profiling,
allowlisted progress, exact signed descriptor matching and an asynchronous install gate.
Sparkle's verification, extraction, authorization and replacement code is intact.

Mac preparation performs one bounded GitHub archive download and SHA-256 check
against the signed release descriptor without starting Sparkle. Cancellation or
host exit during preparation cannot leave a native installer behind. Only after
successful engine shutdown does handoff open an ephemeral nonce-scoped loopback
listener and authorize Sparkle to ingest the frozen metadata and cached ZIP.
This listener is part of the app process, never an installed background service;
it closes after the local copy or any error/cancellation/deadline. Routes, request
counts, ranges, byte budget and cache identity are bounded. The helper's broad
upstream ATS bypass is replaced with an HTTP exception for exactly 127.0.0.1,
without subdomains, LAN ranges or a global/local-network bypass. Apple documents
this exact-IP mechanism for macOS 14+; older supported macOS allows IP loads by
default. Native hosted CI must verify the resulting loopback transport policy.
https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains

Runtime Mac payload authentication still uses Sparkle's Ed25519 archive signature
before extraction. The authenticated release descriptor carries that same raw
archive signature, version, GitHub URL and byte count. Public SUAppcastItem
properties match the frozen local ingestion descriptor before proceeding and
again in willDownloadUpdate (including any selected delta).
Public user-driver download callbacks cancel declared or received bytes above the
signed limit; the native signature verifier still authenticates the payload.
The publication audit verifies both archive signatures and the exact manifest
binding. Linux rehashes downloaded AppImage bytes against the
authenticated SHA-256 and uses same-filesystem atomic replacement.

Native fixtures use independent ephemeral Ed25519 keys and generated profiles.
They do not import production credentials or relax Gatekeeper or the sandbox.

Developer ID signing/notarization can replace the valid ad-hoc baseline when an
authorized signing identity is available. Neither archive signatures nor ad-hoc
code signatures establish notarization or remove normal OS authorization rules.
