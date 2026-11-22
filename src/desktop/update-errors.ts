import type { DesktopUpdateError } from "./update-types";

const codes: readonly DesktopUpdateError[] = ["network", "release-invalid", "signature-invalid", "download-invalid", "storage-unavailable", "permission-required", "app-busy", "shutdown-unconfirmed", "installer-busy", "installer-cancelled", "installer-failed", "restart-required", "unsupported-installation", "update-failed"];
export class DesktopUpdateFailure extends Error {
  constructor(readonly updateCode: DesktopUpdateError) { super(updateCode); this.name = "DesktopUpdateFailure"; }
}
export function updateErrorCode(error: unknown): DesktopUpdateError {
  if (error instanceof Error && codes.includes(error.message as DesktopUpdateError)) return error.message as DesktopUpdateError;
  if (error && typeof error === "object") {
    const item = error as { updateCode?: unknown; code?: unknown };
    if (codes.includes(item.updateCode as DesktopUpdateError)) return item.updateCode as DesktopUpdateError;
    if (item.code === "ENOSPC" || item.code === "EDQUOT") return "storage-unavailable";
    if (item.code === "EACCES" || item.code === "EPERM") return "permission-required";
  }
  return "update-failed";
}
export function updateErrorMessage(code: DesktopUpdateError): { message: string; nextAction: string } {
  const messages: Record<DesktopUpdateError, [string, string]> = {
    network: ["The app cannot contact the update service.", "Check your internet connection, then check for updates again."],
    "release-invalid": ["The release information did not pass the update checks.", "Try again later. The previous application is still installed."],
    "signature-invalid": ["The update signature could not be verified.", "Do not install this download. Check for updates again later."],
    "download-invalid": ["The downloaded update did not pass verification.", "Check your connection and free space, then try again."],
    "storage-unavailable": ["The app cannot save the update.", "Make space in the application cache, then try again."],
    "permission-required": ["The operating system did not allow this update.", "Use the normal operating-system permission prompt, or ask your administrator for help."],
    "app-busy": ["Another update operation is still running.", "Wait for it to finish, or cancel its download."],
    "shutdown-unconfirmed": ["The app could not safely finish its current work.", "The update was not started. Restart the app after resolving the download warning."],
    "installer-busy": ["Windows Installer is busy with another installation.", "Finish that installation, then try this update again."],
    "installer-cancelled": ["The update installation was cancelled.", "Start the app again and retry when you are ready."],
    "installer-failed": ["The operating system could not finish the installation.", "Start the previous app and retry. Ask your administrator if the problem continues."],
    "restart-required": ["The update needs an operating-system restart to finish.", "Save your other work and restart the computer when you are ready."],
    "unsupported-installation": ["This copy cannot install updates automatically.", "Install the updating edition from the project's GitHub release page."],
    "update-failed": ["The app could not finish this update operation.", "Try again. Ask your administrator if the problem continues."],
  };
  const [message, nextAction] = messages[code];
  return { message, nextAction };
}
