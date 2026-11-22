import type { DesktopUpdateAdapter, DesktopUpdatePhase, DesktopUpdateStatus, VerifiedDesktopRelease } from "./update-types";
import { DesktopUpdateFailure, updateErrorCode, updateErrorMessage } from "./update-errors";
import { checkDesktopRelease, stableVersion, updatePlatform, type ReleaseProviderOptions } from "./update-release";

export interface DesktopUpdaterOptions extends ReleaseProviderOptions {
  adapter: DesktopUpdateAdapter;
  beforeInstall(): Promise<void>;
  onStatus?(status: DesktopUpdateStatus): void;
  releaseCheck?: typeof checkDesktopRelease;
  previousOutcome?: {phase:'updated'|'failed'|'restart-required';errorCode?: import('./update-types').DesktopUpdateError};
}
/** Main-process state machine. Neither account credentials nor engine snapshots enter it. */
export class DesktopUpdater {
  private value: DesktopUpdateStatus;
  private release?: VerifiedDesktopRelease;
  private active?: Promise<DesktopUpdateStatus>;
  private abort?: AbortController;
  private cancelled = false;
  constructor(private readonly options: DesktopUpdaterOptions) {
    const supported = options.adapter.supported && stableVersion(options.currentVersion);
    this.value = { schema: 1, source: "github", platform: updatePlatform(options.platform), currentVersion: stableVersion(options.currentVersion) ? options.currentVersion : "0.0.0", capability: supported ? "automatic" : "unavailable", phase: supported ? "idle" : "unavailable", message: supported ? "Check GitHub for a newer desktop version." : "This copy cannot install updates automatically.", restartRequired: false };
    if(options.previousOutcome?.phase==='updated')this.value={...this.value,phase:'updated',message:'The desktop update is installed.'};
    else if(options.previousOutcome){const code=options.previousOutcome.errorCode??'installer-failed';this.value={...this.value,phase:'failed',errorCode:code,...updateErrorMessage(code),restartRequired:code==='restart-required'};}
  }
  status(): DesktopUpdateStatus { return { ...this.value }; }
  private emit(patch: Partial<DesktopUpdateStatus>): DesktopUpdateStatus {
    this.value = { ...this.value, progressPercent: undefined, errorCode: undefined, nextAction: undefined, restartRequired:false, ...patch };
    try { this.options.onStatus?.(this.status()); } catch { /* Closing a view cannot change update ownership. */ }
    return this.status();
  }
  private failure(error: unknown): DesktopUpdateStatus {
    if (this.cancelled) return this.emit({ phase: "cancelled", message: "The update download was cancelled.", nextAction: "Check for updates when you are ready." });
    const code = updateErrorCode(error);
    return this.emit({ phase: "failed", errorCode: code, ...updateErrorMessage(code),restartRequired:code==='restart-required' });
  }
  private run(operation: () => Promise<DesktopUpdateStatus>): Promise<DesktopUpdateStatus> {
    if (this.active) return this.active;
    this.cancelled = false; this.abort = new AbortController();
    const promise = operation().catch(async error => {
      await this.options.adapter.cancel?.().catch(() => {});
      return this.failure(error);
    }).finally(() => { if (this.active === promise) this.active = undefined; this.abort = undefined; });
    this.active = promise; return promise;
  }
  check(): Promise<DesktopUpdateStatus> {
    if (this.active) return this.active;
    if (this.value.phase === "installing") return Promise.resolve(this.status());
    return this.run(async () => {
      this.emit({ phase: "checking", availableVersion: undefined, message: "Checking the published GitHub release." });
      const signal = AbortSignal.any([this.abort!.signal, AbortSignal.timeout(45000)]);
      this.release = await (this.options.releaseCheck ?? checkDesktopRelease)(this.options, signal);
      return this.release
        ? this.emit({ phase: "available", availableVersion: this.release.version, message: "A newer desktop version is available.", nextAction: this.options.adapter.supported ? "Select Update and restart when you are ready." : "Install the updating edition from the GitHub release page." })
        : this.emit({ phase: "current", availableVersion: undefined, message: "This desktop version is up to date." });
    });
  }
  async install(): Promise<DesktopUpdateStatus> {
    if (this.active) {
      const checking=this.value.phase==='checking';
      const result=await this.active;
      return checking&&result.phase==='available'?this.install():result;
    }
    if (this.value.phase === "installing") return this.status();
    if (!this.options.adapter.supported) return this.failure(new DesktopUpdateFailure("unsupported-installation"));
    if (!this.release) {
      const checked = await this.check();
      if (!this.release || checked.phase !== "available") return checked;
    }
    return this.run(async () => {
      const release = this.release!;
      this.emit({ phase: "downloading", message: "Downloading and verifying the desktop update.", progressPercent: 0 });
      const signal = AbortSignal.any([this.abort!.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const prepared = await this.options.adapter.prepare(release, signal, progress => {
        if (!["downloading", "verifying", "ready"].includes(progress.phase) || signal.aborted) return;
        const percent = typeof progress.percent === "number" && Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : undefined;
        const phase = progress.phase as DesktopUpdatePhase;
        this.emit({ phase, progressPercent: percent, message: phase === "verifying" ? "Verifying the downloaded update." : phase === "ready" ? "The verified update is ready." : "Downloading the desktop update." });
      });
      if (signal.aborted || this.cancelled) throw new DesktopUpdateFailure("installer-cancelled");
      if (prepared.version !== release.version || typeof prepared.id !== "string" || !prepared.id) throw new DesktopUpdateFailure("download-invalid");
      this.emit({ phase: "preparing", message: "Saving current work before the desktop restarts." });
      try { await this.options.beforeInstall(); }
      catch { throw new DesktopUpdateFailure("shutdown-unconfirmed"); }
      this.emit({ phase: "installing", progressPercent: 100, message: "Installing the verified update and restarting the desktop.", restartRequired: true });
      await this.options.adapter.handoff(prepared);
      return this.status();
    });
  }
  async cancel(): Promise<DesktopUpdateStatus> {
    if (["preparing", "installing"].includes(this.value.phase)) return this.status();
    this.cancelled = true; this.abort?.abort();
    await this.options.adapter.cancel?.().catch(() => {});
    if (this.active) await this.active;
    return this.emit({ phase: "cancelled", message: "The update operation was cancelled.", nextAction: "Check for updates when you are ready." });
  }
}
