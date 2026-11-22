# Putio Manager agent operation

Use the CLI for all agent administration. The desktop GUI is for people; agents must not use it to manage accounts, settings, jobs or services.

Start with `help`, then `status`, `analytics`, `storage` and `downloads`. Use the saved Remote connection with the desktop executable's `--agent` option, or the headless CLI with its private server configuration. Follow the CLI section in README.md.

The CLI returns an allowlisted status view by default. Use its anonymous job and root references for changes. Do not print full internal snapshots, configuration, credentials, authorization links, filenames, folder paths or raw server errors. Do not open media contents for administration or analytics. Read filesystem capacity through the CLI's metadata-only storage command.

Respect the executing host. Desktop agent mode requires an existing Remote profile and never starts a Local download engine as a fallback. A disconnected server requires a connection repair, not a switch to Local.

Use only authorized operations. Retry and cleanup must pass the existing verification, file-identity and recovery guards. Cleanup requests only the manager's guarded temporary-file cleanup; it does not authorize deleting completed downloads or put.io sources manually. Preserve uncertain state and report the controlled error when a guard blocks work.

Test changes with generated fixtures. Automated renderer fixtures may validate display behavior without a live account; they are not an administration method. Keep generated screenshots and examples free of private account or machine data. Run the relevant tests and report built, installed and live-verified states separately.
