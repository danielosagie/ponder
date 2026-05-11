// ax-bridge — tiny macOS Accessibility CLI used by src/agent/os/providers/mac.ts
//
// Subcommands (each takes JSON args on argv[2..] or stdin and prints JSON
// to stdout, one line per response, exit code 0 on success):
//
//   ax-bridge dump            { pid?: number, max-depth?: number }
//     Dump the AX tree of the frontmost window (or the frontmost window of
//     the given PID). Returns { app, window, tree: AxNode[] }.
//
//   ax-bridge perform         { handle: string, action: string }
//     Perform an AX action ("AXPress", "AXShowMenu", etc.) on the element
//     identified by the opaque handle returned in dump.
//
//   ax-bridge set-value       { handle: string, value: string }
//     Set AXValue on the element (used for fast text-field input that
//     skips keystrokes).
//
//   ax-bridge resolve         { handle: string }
//     Return { x, y, w, h, focused, enabled } for the element. Used as a
//     stale-check before clicking on a resolved coord.
//
// Build:
//   swiftc -O -o ax-bridge ax-bridge.swift
// (or use build.sh in this directory)
//
// Permissions: the user must grant Accessibility permission to the
// process that invokes ax-bridge (NOT to ax-bridge itself). On first
// invocation under a fresh terminal/IDE, AXIsProcessTrusted() returns
// false; we print { error: "permission-denied" } and exit 2 so the TS
// layer can surface the System Settings → Privacy → Accessibility prompt.

import Foundation
import ApplicationServices
import AppKit

// MARK: - Handle encoding
//
// We can't send raw AXUIElement pointers over JSON, so each element gets
// a process-local handle string. The handles map back to AXUIElement
// references kept alive by a singleton store for the duration of the
// process. Since ax-bridge is spawned per-snapshot from the TS layer,
// "process lifetime" == "one snapshot", which is exactly the same
// staleness window as the TS-side RefStore.

final class HandleStore {
    static let shared = HandleStore()
    private var elements: [String: AXUIElement] = [:]
    private var nextId = 1
    func register(_ el: AXUIElement) -> String {
        let h = "h\(nextId)"; nextId += 1
        elements[h] = el
        return h
    }
    func lookup(_ h: String) -> AXUIElement? { elements[h] }
}

// MARK: - AX helpers

func axCopyAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    return err == .success ? value : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    return axCopyAttr(el, attr) as? String
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    return axCopyAttr(el, attr) as? Bool
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    return (axCopyAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let posRef = axCopyAttr(el, kAXPositionAttribute as String),
          let sizeRef = axCopyAttr(el, kAXSizeAttribute as String) else { return nil }
    var pos = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}

// MARK: - JSON output

struct JSON {
    static func emit(_ obj: Any) {
        let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    static func error(_ kind: String, _ message: String) -> Never {
        emit(["error": kind, "message": message])
        exit(2)
    }
}

func nodeToDict(_ el: AXUIElement, depth: Int, maxDepth: Int) -> [String: Any] {
    let handle = HandleStore.shared.register(el)
    var node: [String: Any] = ["handle": handle]

    if let role = axString(el, kAXRoleAttribute as String) { node["role"] = role }
    if let name = axString(el, kAXTitleAttribute as String), !name.isEmpty { node["name"] = name }
    else if let lbl = axString(el, "AXValueDescription"), !lbl.isEmpty { node["name"] = lbl }
    if let val = axString(el, kAXValueAttribute as String), !val.isEmpty { node["value"] = val }
    if let desc = axString(el, kAXDescriptionAttribute as String), !desc.isEmpty { node["description"] = desc }
    if let enabled = axBool(el, kAXEnabledAttribute as String) { node["enabled"] = enabled }
    if let focused = axBool(el, kAXFocusedAttribute as String) { node["focused"] = focused }
    if let frame = axFrame(el) {
        node["bounds"] = [
            "x": frame.origin.x,
            "y": frame.origin.y,
            "w": frame.size.width,
            "h": frame.size.height,
        ]
    }
    if depth < maxDepth {
        let kids = axChildren(el).map { nodeToDict($0, depth: depth + 1, maxDepth: maxDepth) }
        if !kids.isEmpty { node["children"] = kids }
    }
    return node
}

func frontmostApp() -> NSRunningApplication? {
    return NSWorkspace.shared.frontmostApplication
}

func mainWindow(of app: NSRunningApplication) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    if let win = axCopyAttr(axApp, kAXFocusedWindowAttribute as String) {
        return (win as! AXUIElement)
    }
    if let wins = axCopyAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement],
       let first = wins.first {
        return first
    }
    return nil
}

func readArgs() -> [String: Any] {
    if CommandLine.arguments.count >= 3 {
        let payload = CommandLine.arguments[2]
        if let data = payload.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return obj
        }
    }
    return [:]
}

// MARK: - Subcommands

func cmdDump() {
    if !AXIsProcessTrusted() {
        JSON.error("permission-denied",
                   "Grant Accessibility permission to this process in System Settings → Privacy & Security → Accessibility.")
    }
    let args = readArgs()
    let maxDepth = args["max-depth"] as? Int ?? 25
    var app: NSRunningApplication?
    if let pid = args["pid"] as? Int {
        app = NSRunningApplication(processIdentifier: pid_t(pid))
    } else {
        app = frontmostApp()
    }
    guard let runningApp = app else {
        JSON.error("no-app", "Could not resolve target application.")
    }
    guard let window = mainWindow(of: runningApp) else {
        JSON.error("no-window", "Application \(runningApp.localizedName ?? "?") has no focused window.")
    }
    let tree = nodeToDict(window, depth: 0, maxDepth: maxDepth)
    let appName = runningApp.localizedName ?? "Unknown"
    let windowTitle = axString(window, kAXTitleAttribute as String) ?? ""
    JSON.emit([
        "app": appName,
        "window": windowTitle,
        "pid": runningApp.processIdentifier,
        "tree": [tree],
    ])
}

func cmdPerform() {
    let args = readArgs()
    guard let handle = args["handle"] as? String,
          let action = args["action"] as? String else {
        JSON.error("bad-args", "Expected { handle, action }.")
    }
    guard let el = HandleStore.shared.lookup(handle) else {
        JSON.error("stale-handle", "Handle \(handle) not in store; call dump first.")
    }
    let err = AXUIElementPerformAction(el, action as CFString)
    if err == .success {
        JSON.emit(["ok": true])
    } else {
        JSON.error("perform-failed", "AXError \(err.rawValue) performing \(action).")
    }
}

func cmdSetValue() {
    let args = readArgs()
    guard let handle = args["handle"] as? String,
          let value = args["value"] as? String else {
        JSON.error("bad-args", "Expected { handle, value }.")
    }
    guard let el = HandleStore.shared.lookup(handle) else {
        JSON.error("stale-handle", "Handle \(handle) not in store; call dump first.")
    }
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
    if err == .success {
        JSON.emit(["ok": true])
    } else {
        JSON.error("set-value-failed", "AXError \(err.rawValue) setting value.")
    }
}

func cmdResolve() {
    let args = readArgs()
    guard let handle = args["handle"] as? String else {
        JSON.error("bad-args", "Expected { handle }.")
    }
    guard let el = HandleStore.shared.lookup(handle) else {
        JSON.error("stale-handle", "Handle \(handle) not in store; call dump first.")
    }
    var out: [String: Any] = [:]
    if let frame = axFrame(el) {
        out["x"] = frame.origin.x
        out["y"] = frame.origin.y
        out["w"] = frame.size.width
        out["h"] = frame.size.height
    }
    if let enabled = axBool(el, kAXEnabledAttribute as String) { out["enabled"] = enabled }
    if let focused = axBool(el, kAXFocusedAttribute as String) { out["focused"] = focused }
    JSON.emit(out)
}

// MARK: - Entry

let cmd = CommandLine.arguments.count >= 2 ? CommandLine.arguments[1] : ""
switch cmd {
case "dump":      cmdDump()
case "perform":   cmdPerform()
case "set-value": cmdSetValue()
case "resolve":   cmdResolve()
default:
    JSON.error("unknown-command", "Usage: ax-bridge {dump|perform|set-value|resolve} '<json-args>'")
}
