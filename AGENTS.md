# Putio Manager agent operation

Use the CLI for all agent administration. The desktop GUI is for people; agents must not use it to manage accounts, settings, jobs or services.

Start with `help`, then `status`, `analytics`, `storage` and `downloads`. Use the saved Remote connection with the desktop executable's `--agent` option, or the headless CLI with its private server configuration. Follow the CLI section in README.md.

The CLI returns an allowlisted status view by default. Use its anonymous job and root references for changes. Do not print full internal snapshots, configuration, credentials, authorization links, filenames, folder paths or raw server errors. Do not open media contents for administration or analytics. Read filesystem capacity through the CLI's metadata-only storage command.

Respect the executing host. Desktop agent mode requires an existing Remote profile and never starts a Local download engine as a fallback. A disconnected server requires a connection repair, not a switch to Local.

Use only authorized operations. Retry and cleanup must pass the existing verification, file-identity and recovery guards. Cleanup requests only the manager's guarded temporary-file cleanup; it does not authorize deleting completed downloads or put.io sources manually. Preserve uncertain state and report the controlled error when a guard blocks work.

Test changes with generated fixtures. Automated renderer fixtures may validate display behavior without a live account; they are not an administration method. Keep generated screenshots and examples free of private account or machine data. Run the relevant tests and report built, installed and live-verified states separately.

## Engineering context

Use this repository's GitHub Issues for public code work. Keep operator plans, private installation evidence and machine configuration outside the public tree. The [product context](docs/PRODUCT.md) records the existing interface and privacy requirements.

Set an explicit project identity and a noreply email for automated commit authors and committers. Check all new reachable commit metadata before publishing. Avoid file-writing tools that silently select an account's personal email.

Plan the requested batch, implement the complete ticket set, test the assembled system and fix failures until the acceptance checks pass. Preserve unrelated work. Installer and updater tests must run on generated profiles in disposable native runners; do not execute test installers against a live personal installation.
