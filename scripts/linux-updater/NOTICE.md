# Linux update replacement

AppImages are packaged with pinned electron-builder 26.18.0. The desktop adapter
uses the shared bounded GitHub asset downloader and authenticated release SHA-256.
It does not fetch or interpret remote Linux channel YAML. Generated channel files
remain release compatibility assets, not runtime authority.

Preparation copies the verified image to an exclusive hidden file beside the
current image, flushes it, verifies the hash again, and checks both file identities.
After the caller successfully closes its engine, a fixed /bin/sh relaunch waiter
acknowledges readiness. Its only arguments are the current numeric PID and the
verified application path, passed as quoted positional parameters. It waits at
most 30 seconds, never kills a PID, and relaunches with the sandbox enabled.

Atomic rename over the old image is the commit point. The adapter never unlinks
the current image. A failure or crash before commit leaves that image intact.
After commit the path contains the complete verified new image; a relaunch or
durability failure requires restart/recovery and must not claim the old image is
still installed. A controlled receipt records the committed target version.

Native acceptance runs the actual AppImage/runtime on disposable CI with generated
profiles. It does not disable the sandbox, change global OS security settings,
inspect account/media data, or run an installer on an operator computer.
