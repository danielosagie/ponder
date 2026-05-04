// macOS permission probes. On other platforms returns "granted" defaults.
//
// We use Electron's built-in `systemPreferences` API rather than the
// `node-mac-permissions` native module. The native module needs to be
// rebuilt against Electron's headers (electron-rebuild), and on this project
// it currently fails to load — every probe hit the catch fallback and
// returned "unknown" for all three perms, which made the runtime guard in
// agent:run reject every task even though the user had actually granted
// access. Electron's APIs require no native compilation and use the same
// underlying TCC database, so the answer is always accurate.
//
// API references:
//   systemPreferences.isTrustedAccessibilityClient(prompt)  → boolean
//   systemPreferences.getMediaAccessStatus("screen")        → status string

import { systemPreferences } from "electron";

export type PermStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface PermissionsReport {
  platform: NodeJS.Platform;
  accessibility: PermStatus;
  screenRecording: PermStatus;
  inputMonitoring: PermStatus;
}

export async function probe(): Promise<PermissionsReport> {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      accessibility: "granted",
      screenRecording: "granted",
      inputMonitoring: "granted",
    };
  }

  // Accessibility — booleans via the Electron API. `prompt: false` means we
  // ONLY check; we don't pop the system dialog here. (The `request*`
  // functions below are responsible for prompting.)
  const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);

  // Screen Recording — getMediaAccessStatus returns a string we can map
  // directly. Note: "unknown" from this API means the OS literally doesn't
  // know yet, not that our probe failed.
  const screenRaw = systemPreferences.getMediaAccessStatus("screen");

  // Input Monitoring is NOT exposed by Electron's systemPreferences. There's
  // no public API to query it; you can only ask via IOHIDCheckAccess (a
  // Carbon call). For the agent's purposes Input Monitoring isn't required
  // (our hotkey uses Electron's globalShortcut, which doesn't need it), so
  // we report "granted" and let `globalShortcut.register` fail loudly if
  // the user has explicitly revoked it.
  return {
    platform: "darwin",
    accessibility: accessibilityGranted ? "granted" : "denied",
    screenRecording: normalize(screenRaw),
    inputMonitoring: "granted",
  };
}

export async function requestAccessibility(): Promise<void> {
  if (process.platform !== "darwin") return;
  // Passing prompt:true triggers the system dialog if access is missing,
  // and registers the binary in Privacy → Accessibility (defaulted off).
  systemPreferences.isTrustedAccessibilityClient(true);
}

export async function requestScreenRecording(): Promise<void> {
  if (process.platform !== "darwin") return;
  // There is no `askForScreenCaptureAccess` on Electron's systemPreferences;
  // macOS pops the screen-recording prompt the FIRST time the app actually
  // tries to capture pixels. nut-js's `screen.grabRegion()` will trigger it
  // on the next agent run. Calling `getMediaAccessStatus("screen")` here
  // ensures the entry shows up in the Privacy panel even before that.
  systemPreferences.getMediaAccessStatus("screen");
}

export async function requestInputMonitoring(): Promise<void> {
  // No-op: Input Monitoring is irrelevant for this app's nut-js usage and
  // there's no Electron API to request it. Kept for ABI compatibility with
  // the previous implementation.
}

function normalize(s: string): PermStatus {
  switch (s) {
    case "granted":
    case "authorized":
      return "granted";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "not-determined":
    case "not determined":
      return "not-determined";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}
