// Active report notification: the collector calls this the moment a report is
// filed, so the user is told without waiting for the next main-session turn.
// Deliveries are best-effort only - never throw, never block the collector.
// Channel selection (first match wins):
//   1. explicit config.notify_command (template with {title} / {body})
//   2. platform default (win32: PowerShell toast; darwin: osascript; else: notify-send)
// Any failure degrades to a debug log line.

import { execFile } from "node:child_process";
import { logDebug } from "./util.mjs";

const TOAST_SCRIPT = (title, body) => `$reg = 'HKCU:\\Software\\Classes\\AppUserModelId\\ShadowMind.Notifications'
if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
$t = '${title}'
$b = '${body}'
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$text = [System.String]::Join('', @('<toast><visual><binding template="ToastGeneric"><text>', (& $esc $t), '</text><text>', (& $esc $b), '</text></binding></visual></toast>'))
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($text)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ShadowMind.Notifications').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;

/** Escape a string for safe embedding inside a PowerShell single-quoted literal. */
export function psSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

/** Build the platform-default command (array form). Null when unknown. */
export function defaultNotifyCommand(platform = process.platform) {
  if (platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${TOAST_SCRIPT(psSingleQuote("{title}"), psSingleQuote("{body}"))}"`] };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", `display notification "{body}" with title "{title}"`] };
  }
  if (platform === "linux") {
    return { command: "notify-send", args: ["{title}", "{body}"] };
  }
  return null;
}

/** Resolve the full notify command (array form with placeholders replaced). */
export function resolveNotifyCommand(customCommand, platform = process.platform) {
  if (customCommand && typeof customCommand === "string" && customCommand.trim()) {
    // Template string may contain {title} / {body} placeholders.
    return {
      command: customCommand.split(/\s+/)[0],
      args: customCommand.split(/\s+/).slice(1),
    };
  }
  return defaultNotifyCommand(platform);
}

function fill(parts, title, body) {
  return parts.map((part) => part.replaceAll("{title}", title).replaceAll("{body}", body));
}

/**
 * Fire a report notification. Never rejects.
 *
 * @param {{ title: string, body: string, command?: string, agentDir?: string, spawn?: typeof execFile }} options
 * @returns {Promise<boolean>} true when the notification process spawned ok
 */
export function notify({ title, body, command, agentDir = process.cwd(), exec = execFile, platform = process.platform }) {
  const resolved = resolveNotifyCommand(command, platform);
  if (!resolved) return Promise.resolve(false);
  const args = fill(resolved.args, title, body);
  return new Promise((resolve) => {
    exec(resolved.command, args, { windowsHide: true, timeout: 10_000 }, (error) => {
      if (error) {
        logDebug(agentDir, `[notify] ${resolved.command} failed: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}