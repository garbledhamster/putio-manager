/** Controlled public error vocabulary. Raw diagnostics must never reach this result.
 * Uses short sentences and direct instructions informed by STE-100 principles.
 * This is not a claim of certified STE-100 compliance.
 */
export interface UserMessageContext {
  host?: "local" | "remote";
  status?: string;
  cleanupStatus?: string;
  verification?: string;
  cleanupPending?: boolean;
  phase?: string;
  job?: Omit<UserMessageContext, "host" | "job">;
}

export interface UserErrorMessage {
  code: UserErrorCode;
  title: string;
  explanation: string;
  nextAction: string;
  message: string;
}

export type UserErrorCode =
  | "unknown" | "storage-full" | "storage-limit" | "storage-check" | "storage-access" | "storage-io"
  | "filesystem-unsupported" | "destination-exists" | "destination-unverified" | "content-mismatch"
  | "temporary-cleanup" | "file-close-unconfirmed" | "file-check-required" | "partial-missing"
  | "recovery-check" | "source-changed" | "source-unavailable" | "source-cleanup-unknown"
  | "source-cleanup-failed" | "source-cleanup-not-started" | "state-save" | "state-read"
  | "already-running" | "putio-authorization" | "server-authorization" | "credential-storage"
  | "putio-network" | "server-network" | "server-version" | "server-response" | "putio-response"
  | "putio-request" | "move-rejected" | "account-link" | "account-link-expired" | "canceled"
  | "parallel-range" | "interval-range" | "speed-range" | "staging-budget" | "staging-reserve"
  | "folder-choice" | "folder-name" | "staging-settings" | "settings-invalid" | "rule-invalid"
  | "server-settings" | "action-unavailable" | "paused" | "interrupted" | "scan-failed"
  | "magnet-invalid" | "zip-required" | "folder-changed" | "startup-setting" | "folder-open"
  | "speed-value" | "minimum-size" | "schedule-time" | "rule-folder-choice" | "magnet-destination" | "move-refresh"
  | "temporary-folder-changed";

// Read only known scalar fields. Never stringify an unknown object or inspect its contents.
function diagnostic(error: unknown): { text: string; code: string; kind: string } {
  if (typeof error === "string") return { text: error.slice(0, 8192).toLowerCase(), code: "", kind: "" };
  try {
    if (error && typeof error === "object") {
      const value = error as { message?: unknown; code?: unknown; kind?: unknown };
      return {
        text: typeof value.message === "string" ? value.message.slice(0, 8192).toLowerCase() : "",
        code: typeof value.code === "string" ? value.code.toUpperCase() : "",
        kind: typeof value.kind === "string" ? value.kind : "",
      };
    }
  } catch { /* An error object can have throwing accessors. Use the unknown message. */ }
  return { text: "", code: "", kind: "" };
}

export function classifyUserError(error: unknown, context: UserMessageContext = {}): UserErrorCode {
  const { text: t, code, kind } = diagnostic(error);
  const c = { ...context.job, ...context };
  if (/concurrency must be between 1 and 20/.test(t)) return "parallel-range";
  if (/interval must be between 10 and 86400|interval must be a positive whole number of seconds/.test(t)) return "interval-range";
  if (/speed limit must be/.test(t)) return "speed-range";
  if (/speed must be zero or a positive number/.test(t)) return "speed-value";
  if (/minimum size must be a non-negative number/.test(t)) return "minimum-size";
  if (/choose a valid schedule time/.test(t)) return "schedule-time";
  if (/select a put.io folder in files before adding a rule/.test(t)) return "rule-folder-choice";
  if (/could not confirm the magnet destination/.test(t)) return "magnet-destination";
  if (/item moved. refresh files to update the folder listing/.test(t)) return "move-refresh";
  if (/invalid staging budget/.test(t)) return "staging-budget";
  if (/invalid staging reserve/.test(t)) return "staging-reserve";
  if (/server staging directory changed/.test(t)) return "temporary-folder-changed";
  if (/source.*cleanup|remote cleanup outcome|source retained because/.test(t)) {
    if (c.cleanupStatus === "unknown" || c.cleanupPending || /unknown|not resumed/.test(t)) return "source-cleanup-unknown";
    if (c.cleanupStatus === "failed" || /cleanup failed/.test(t)) return "source-cleanup-failed";
    return "source-cleanup-not-started";
  }
  if (/could not be safely closed|could not safely close|close is unresolved|close.*uncertain|shutdown timed out/.test(t)) return "file-close-unconfirmed";
  if (/destination already exists/.test(t) || code === "EEXIST" && !/staging|partial|ownership/.test(t)) return "destination-exists";
  if (/published destination could not be verified|staged destination could not be verified/.test(t)) return "destination-unverified";
  if (/destination copy did not verify|bytes.*(not match|not be verified)|staging content changed|reserved source length/.test(t)) return "content-mismatch";
  if (/previous download.*partial.*unavailable|owned staging artifact is missing|partial.*(missing|unavailable)/.test(t)) return "partial-missing";
  if (/anchor.*(cleanup|release|inspection)|staged copy could not be removed|canceled.*(safely removed|inspection)|staging check could not be safely removed/.test(t)) return "temporary-cleanup";
  if (/cannot (publish safely|create a safe)|filesystem support/.test(t) || ["ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code)) return "filesystem-unsupported";
  if (/ownership|unsafe (partial|staging|download)|not private/.test(t)) return "file-check-required";
  if (/recovery.*(attention|inspection)|staging.*(check.*inspection|evidence.*attention|finalization.*attention)|saved staging root was replaced|staged destination is unavailable|invalid stage evidence/.test(t)) return "recovery-check";
  if (/source (identity )?changed|source folder moved/.test(t)) return "source-changed";
  if (/source identity unavailable/.test(t)) return "source-unavailable";
  if (code === "ENOSPC" || /\bis full\b|no space left|disk full/.test(t)) return "storage-full";
  if (/could not (determine available storage|account for staging storage|check free space)/.test(t)) return "storage-check";
  if (/insufficient.*(capacity|space)|free-space reserve/.test(t)) return "storage-limit";
  if (["EACCES", "EPERM", "EROFS"].includes(code) || /permissions|not.*writable|permission denied|download folder access was denied/.test(t)) return "storage-access";
  if (code === "EIO" || /i\/o failed|could not write (download|destination copy)|download disk could not read or write data/.test(t)) return "storage-io";
  if (/could not save (job state|engine state|settings|rule|the account connection)/.test(t)) return "state-save";
  if (/could not read (engine state|saved settings)|invalid saved (job|settings|rules)/.test(t)) return "state-read";
  if (/state directory is already owned/.test(t)) return "already-running";
  if (/remote authorization|invalid client credential|invalid credential key|invalid protected credential/.test(t)) return "server-authorization";
  if (/secure storage|unlock.*credential|credential file must/.test(t)) return "credential-storage";
  if (kind === "authorization" || /token.*(invalid|rejected)|invalid token|enter a put.io token|account needs authorization|use connect with put.io/.test(t)) return "putio-authorization";
  if (/version is incompatible|protocol version/.test(t)) return "server-version";
  if (/invalid remote (response|snapshot|event)|event stream exceeded/.test(t)) return "server-response";
  if (/remote.*(connect|stream|reconnecting)|connect to remote|selected engine is unavailable/.test(t)) return "server-network";
  if (/invalid remote (endpoint|configuration)|invalid server configuration|config path|state directory must/.test(t)) return "server-settings";
  if (/could not (connect to|contact) put.io|server could not contact put.io|zip creation timed out/.test(t) || kind === "transient") return "putio-network";
  if (/put.io.*invalid.*response|zip is incomplete|zip creation failed/.test(t) || kind === "invalid-response") return "putio-response";
  if (/put.io could not move/.test(t)) return "move-rejected";
  if (/put.io (request failed|rejected the request)/.test(t)) return "putio-request";
  if (/connection (timed out|expired)|account connection expired/.test(t)) return "account-link-expired";
  if (/could not.*(account|account link)|put.io.*(connection|registration)|connection code/.test(t)) return "account-link";
  if (/^(request |connection )?canceled\.?$/.test(t)) return "canceled";
  if (/scan failed|calculate rule schedule/.test(t)) return "scan-failed";
  if (/engine is paused/.test(t)) return "paused";
  if (/interrupted by engine restart|download file needs an explicit retry/.test(t)) return "interrupted";
  if (/use zip download/.test(t)) return "zip-required";
  if (/magnet link|magnet registration choice/.test(t)) return "magnet-invalid";
  if (/folder cycle|ambiguous folder contents|invalid source folder/.test(t)) return "folder-changed";
  if (/folder.*cannot be opened|could not open the download directory/.test(t)) return "folder-open";
  if (/startup|magnet registration is not supported|did not confirm magnet/.test(t)) return "startup-setting";
  if (/invalid name|valid folder name|relative folder name|safe local filename/.test(t)) return "folder-name";
  if (/staging.*(setting|directory|policy|reservation|storage policy)|staging must use engine-local storage|invalid destination storage policy/.test(t)) return "staging-settings";
  if (/download (directory|root)|destination root|saved job destination|directory picker|choose.*(directory|destination|put.io folder)|invalid relative directory/.test(t)) return "folder-choice";
  if (/invalid rule|rule not found/.test(t)) return "rule-invalid";
  if (/invalid (setting|download option)|unknown setting|remote engine rejected the command or its settings/.test(t)) return "settings-invalid";
  if (/cannot be retried|engine is closed|selection changed|folder picker has closed|already in progress|remote engine is busy|current state|invalid (command|request|job|remote id)|unknown command|request (receipt|id)|directory selection is unavailable/.test(t)) return "action-unavailable";
  return "unknown";
}

/** The returned text and identifier contain only application-controlled words. */
export function presentUserError(error: unknown, context: UserMessageContext = {}): UserErrorMessage {
  const code = classifyUserError(error, context);
  const c = { ...context.job, ...context };
  const host = context.host === "remote" ? "the download server" : "this computer";
  const inspect = `Check the download folder on ${host}. Contact support before you select Retry.`;
  const repair = c.status === "needs-attention" ? inspect : "Correct the problem before you select Retry.";
  const verified = c.status === "completed" && c.verification === "verified";
  const complete = verified ? "The downloaded file passed verification." : "The app has not confirmed a complete, verified download.";
  const vocabulary: Record<UserErrorCode, [string, string, string]> = {
    "unknown": ["The action stopped.", "The app cannot identify a safe automatic solution.", `Check Settings and the download folder on ${host}. Contact support if the problem continues.`],
    "storage-full": ["The disk is full.", `The app cannot write more data on ${host}.`, `Free disk space on ${host}. ${repair}`],
    "storage-limit": ["There is not enough download space.", `The download needs more space or a higher storage limit on ${host}.`, `Check free space and storage limits in Settings on ${host}. ${repair}`],
    "storage-check": ["The app cannot check disk space.", `The available storage on ${host} could not be confirmed.`, `Check the disk connection and free space on ${host}. ${repair}`],
    "storage-access": ["The app cannot access the download folder.", `The disk or folder on ${host} does not permit this action.`, `Check folder permissions and whether the disk permits changes on ${host}. ${repair}`],
    "storage-io": ["The app could not write the file.", `A disk operation failed on ${host}.`, `Check the disk connection and disk health on ${host}. ${repair}`],
    "filesystem-unsupported": ["The disk cannot complete this download safely.", "The disk does not support a required file operation.", `Choose a supported disk in Settings on ${host}. Ask support before you change existing download files.`],
    "destination-exists": ["A file already exists in the download folder.", "The app has not verified its contents.", `Inspect that file on ${host}. Keep it or choose another download folder before you download again.`],
    "destination-unverified": ["The app could not verify the downloaded file.", "A file can exist in the download folder without being complete or correct.", inspect],
    "content-mismatch": ["The downloaded data did not pass verification.", "The app cannot confirm that the data matches the expected download.", inspect],
    "temporary-cleanup": ["The app could not finish temporary file cleanup.", `${complete} Temporary download files can remain.`, inspect],
    "file-close-unconfirmed": ["The app could not confirm that a download file closed.", "Further file changes need inspection.", `Exit the app on ${host}. Contact support before you change files or select Retry.`],
    "file-check-required": ["The app cannot confirm which download files it can change.", "The app stopped to avoid changing an unrelated file.", inspect],
    "partial-missing": ["The previous incomplete download is unavailable.", "The app cannot resume that saved download.", `Check the download folder on ${host}. Contact support before you restart this download.`],
    "recovery-check": ["The saved download needs inspection.", "The app cannot safely continue from the saved download information.", inspect],
    "source-changed": ["The item on put.io changed.", "The saved download refers to an earlier version.", "Check the current item on put.io. Select Retry only if you want to download the current version."],
    "source-unavailable": ["The app cannot confirm the item on put.io.", "The app cannot check whether the item still matches this download.", "Check the item and your account connection on put.io. Contact support before you change or delete files."],
    "source-cleanup-unknown": ["The app cannot confirm whether put.io deleted the source.", `${complete} The source can still exist on put.io.`, "Check the source on put.io before you request another deletion."],
    "source-cleanup-failed": ["The app could not delete the source on put.io.", complete, "Check the source on put.io. Delete it only after you confirm that the downloaded file is complete."],
    "source-cleanup-not-started": ["The app did not finish source deletion on put.io.", `${complete} The app has not confirmed source deletion.`, "Check the source on put.io. Confirm the downloaded file before you request deletion."],
    "state-save": ["The app could not save the change.", `The app could not save its download information on ${host}.`, `Check disk space and folder permissions on ${host}. Check the current download status before you repeat the action.`],
    "state-read": ["The app could not read saved information.", "The saved settings or download information needs inspection.", `Contact support to check saved information on ${host}. Do not delete it to restart the app.`],
    "already-running": ["Another copy of the app is using these downloads.", `The download information on ${host} is already in use.`, `Use the running app on ${host}, or close it before you start another copy.`],
    "putio-authorization": ["The put.io account needs authorization.", "The app cannot use the current put.io account connection.", "Open Settings. Use Connect with put.io to authorize the account again."],
    "server-authorization": ["The download server rejected the connection credential.", "The app cannot authorize its connection to the download server.", "Check the download server credential in Settings. Ask the server administrator for a valid credential."],
    "credential-storage": ["The app cannot use protected account information.", `Secure credential storage is unavailable or cannot be read on ${host}.`, `Unlock secure storage on ${host}. Check Settings, or ask the server administrator to check credential permissions.`],
    "putio-network": ["The app could not contact put.io.", "The connection or put.io service is unavailable.", c.status === "waiting" ? "Check the internet connection. The app will try again at the displayed time." : "Check the internet connection and put.io availability before you try again."],
    "server-network": ["The app cannot contact the download server.", "After a restart, the server can need time to start and check saved downloads.", "If the server restarted, wait for startup to finish. If this continues, check the server service and private network connection."],
    "server-version": ["The download server version is incompatible.", "The app and download server cannot exchange supported information.", "Update the app and download server to compatible versions. Ask the server administrator for help."],
    "server-response": ["The download server returned information the app cannot use.", "The app cannot confirm the current download status.", "Check that the app and download server use compatible versions. Contact the server administrator if this continues."],
    "putio-response": ["put.io returned information the app cannot use.", "The app cannot confirm the requested result.", "Check the item on put.io. Try again later, or contact support if this continues."],
    "putio-request": ["put.io did not complete the request.", "The app cannot confirm the requested change.", "Check your account and the item on put.io before you repeat the request."],
    "move-rejected": ["put.io could not move the item.", "The requested folder change did not complete.", "Refresh the folder list. Choose a different put.io folder and try again."],
    "account-link": ["The app could not connect the put.io account.", "The account connection did not complete.", "Open Settings and use Connect with put.io again. Contact support if the connection continues to fail."],
    "account-link-expired": ["The account connection expired.", "The account was not connected within the available time.", "Open Settings and use Connect with put.io again. Complete the connection before it expires."],
    "canceled": ["The action was canceled.", "The app stopped this action.", "Check the current status before you start another action."],
    "parallel-range": ["The download count is outside the allowed range.", "Parallel downloads must be a whole number from 1 to 20.", "Enter a number from 1 to 20 in Settings."],
    "interval-range": ["The check interval is outside the allowed range.", "The interval must be a whole number from 10 to 86400 seconds.", "Enter an interval from 10 to 86400 seconds in Settings."],
    "speed-range": ["The speed limit is invalid.", "The speed limit must be zero or a positive whole number of bytes per second.", "Enter zero for no limit, or enter a positive whole number."],
    "speed-value": ["The speed limit is invalid.", "The speed limit in KB/s must be zero or a positive number.", "Enter zero for no limit, or enter a positive number in KB/s."],
    "minimum-size": ["The minimum file size is invalid.", "The minimum file size in MB must be zero or a positive number.", "Enter zero to include all file sizes, or enter a positive size in MB."],
    "schedule-time": ["The schedule time is invalid.", "The time must use hours and minutes from 00:00 to 23:59.", "Choose a valid time for the daily or weekly schedule."],
    "rule-folder-choice": ["The rule needs a put.io folder.", "Select the folder that this rule will check for downloads.", "Open Files and select a put.io folder. Then add the download rule."],
    "magnet-destination": ["The app could not confirm the magnet destination.", "The app cannot confirm that this transfer request completed.", "Check Transfers on put.io before you add the magnet link again."],
    "move-refresh": ["The item moved, but the folder list did not refresh.", "The folder list can still show the previous location.", "Refresh Files to show the current folder contents. Do not repeat the move."],
    "temporary-folder-changed": ["The temporary download folder on the download server changed.", "New downloads will not use temporary storage until you enable it again.", "Review the temporary download folder in Settings. Enable temporary downloads again only after you confirm the folder."],
    "staging-budget": ["The temporary storage limit is invalid.", "The limit must be a positive whole number of bytes.", "Enter a positive temporary storage limit in Settings."],
    "staging-reserve": ["The free space reserve is invalid.", "The reserve must be zero or a positive whole number of bytes.", "Enter zero or a positive free space reserve in Settings."],
    "folder-choice": ["The download folder is unavailable or not allowed.", `The app cannot use the selected folder on ${host}.`, "Open Settings and select an allowed download folder. For a download server, use a configured server folder."],
    "folder-name": ["The folder or file name is invalid.", "The name contains unsupported characters or an invalid folder location.", "Enter a valid name. Use a folder name within the selected download folder."],
    "staging-settings": ["The temporary download folder settings need attention.", `The app cannot use the configured temporary storage on ${host}.`, c.status === "needs-attention" ? inspect : "Check temporary download settings and select a separate, allowed disk folder. Ask the server administrator about server folders."],
    "settings-invalid": ["The settings are invalid.", "The app could not apply one or more selected values.", "Check the fields in Settings and correct invalid values. Save the settings again."],
    "rule-invalid": ["The download rule is invalid or unavailable.", "The app cannot apply this rule.", "Refresh the rules list. Check the folder, file filters, and schedule before you save the rule."],
    "server-settings": ["The download server settings are invalid.", "The app cannot use the configured server connection.", "Check the server address in Settings. Ask the server administrator to check the server configuration."],
    "action-unavailable": ["This action is unavailable in the current state.", "The selected item or connection changed, or the app cannot perform this action now.", "Refresh the current view and check the selected item. Contact support if this continues."],
    "paused": ["Automatic downloads are paused.", "The app cannot check download rules while paused.", "Select Resume before you check download rules."],
    "interrupted": ["The download stopped when the app restarted.", "The download needs an explicit request to continue.", "Check the download status. Select Retry to continue this download."],
    "scan-failed": ["The app could not check download rules.", "The account connection or rule settings need attention.", "Check the put.io connection and download rules. Run the rule check again after you correct the problem."],
    "magnet-invalid": ["The magnet link is invalid.", "The app needs a supported magnet link to add the transfer.", "Paste a complete magnet link and try again."],
    "zip-required": ["This folder needs a ZIP download.", "The selected action cannot download a folder as one ordinary file.", "Use Download ZIP for this folder."],
    "folder-changed": ["The put.io folder contents could not be confirmed.", "The folder changed or contains an unsupported folder structure.", "Check and refresh the folder on put.io. Contact support before you request source deletion."],
    "startup-setting": ["The system could not apply this integration setting.", "The installed app or operating system does not support or confirm the requested change.", "Check the installed app and system settings. Contact support if this continues."],
    "folder-open": ["The app could not open the download folder.", context.host === "remote" ? "The folder is on the download server." : "The folder is unavailable on this computer.", context.host === "remote" ? "Open the folder on the download server." : "Check the folder in Settings and confirm that its disk is connected."],
  };
  const [title, explanation, nextAction] = vocabulary[code];
  return { code, title, explanation, nextAction, message: `${title} ${explanation} ${nextAction}` };
}
