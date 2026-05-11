// ax_bridge — macOS Accessibility tree walker as an N-API addon.
//
// Loaded by Electron's main process (electron/main.ts). Because the
// addon's native code runs inside the Electron bundle's process, the
// user's existing "Accessibility" permission grant on the Electron app
// covers AX calls made here — no separate prompt for a sidecar binary.
//
// Exports (called from JS):
//   dump({ pid?: number, maxDepth?: number }) → {
//     app: string, window: string, pid: number, tree: Node[]
//   }
//     Reset the handle store and walk the AX tree of the frontmost
//     window (or of the given PID's frontmost window). Each emitted
//     node carries a "handle" string ("h1", "h2", …) that resolves to
//     the AXUIElementRef in subsequent calls.
//
//   perform({ handle, action }) → { ok: true }
//     Invoke an AX action on the element ("AXPress", "AXShowMenu", etc.)
//
//   setValue({ handle, value }) → { ok: true }
//     Set AXValue on an editable element. Faster + more reliable than
//     focusing the field and synthesizing keystrokes.
//
//   resolve({ handle }) → { x, y, w, h, focused, enabled }
//
//   isTrusted() → boolean
//     Wraps AXIsProcessTrusted — true once the user has ticked the
//     Accessibility checkbox for the calling app.
//
// Handle lifecycle: every dump() resets the singleton store. Handles
// returned by one dump() are invalidated by the next dump() call. This
// matches the staleness model of the TS-side RefStore.
//
// Retention: we keep a C++ unordered_map<string, AXUIElementRef> and
// manage retains manually via CFRetain/CFRelease — bypasses any ARC↔CF
// bridging subtleties around non-toll-free-bridged CFType objects.

#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <string>
#include <unordered_map>

// ── Handle store ────────────────────────────────────────────────────

static std::unordered_map<std::string, AXUIElementRef> gHandleStore;
static int gNextHandleId = 1;

static void HandleStoreReset() {
    for (auto &kv : gHandleStore) {
        if (kv.second) CFRelease(kv.second);
    }
    gHandleStore.clear();
    gNextHandleId = 1;
}

static std::string HandleStoreRegister(AXUIElementRef el) {
    char buf[32];
    snprintf(buf, sizeof(buf), "h%d", gNextHandleId++);
    std::string h(buf);
    CFRetain(el);  // our store owns +1
    gHandleStore[h] = el;
    return h;
}

static AXUIElementRef HandleStoreLookup(const std::string &h) {
    auto it = gHandleStore.find(h);
    if (it == gHandleStore.end()) return NULL;
    return it->second;
}

// ── AX attribute helpers ────────────────────────────────────────────

static NSString *AXStringAttr(AXUIElementRef el, CFStringRef attr) {
    CFTypeRef val = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &val) != kAXErrorSuccess) return nil;
    if (val == NULL) return nil;
    NSString *result = nil;
    if (CFGetTypeID(val) == CFStringGetTypeID()) {
        result = (__bridge_transfer NSString *)val;  // toll-free bridged
    } else {
        CFRelease(val);
    }
    return result;
}

static NSNumber *AXBoolAttr(AXUIElementRef el, CFStringRef attr) {
    CFTypeRef val = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &val) != kAXErrorSuccess) return nil;
    if (val == NULL) return nil;
    NSNumber *result = nil;
    if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
        result = @(CFBooleanGetValue((CFBooleanRef)val) ? YES : NO);
    }
    CFRelease(val);
    return result;
}

// Returns a +1 CFArrayRef the caller must CFRelease, or NULL.
static CFArrayRef AXArrayAttr(AXUIElementRef el, CFStringRef attr) {
    CFTypeRef val = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &val) != kAXErrorSuccess) return NULL;
    if (val == NULL) return NULL;
    if (CFGetTypeID(val) != CFArrayGetTypeID()) {
        CFRelease(val);
        return NULL;
    }
    return (CFArrayRef)val;
}

static bool AXFrame(AXUIElementRef el, CGRect *out) {
    CFTypeRef posVal = NULL;
    CFTypeRef sizeVal = NULL;
    if (AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &posVal) != kAXErrorSuccess) {
        return false;
    }
    if (AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &sizeVal) != kAXErrorSuccess) {
        if (posVal) CFRelease(posVal);
        return false;
    }
    CGPoint pos = CGPointZero;
    CGSize sz = CGSizeZero;
    if (posVal && CFGetTypeID(posVal) == AXValueGetTypeID()) {
        AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &pos);
    }
    if (sizeVal && CFGetTypeID(sizeVal) == AXValueGetTypeID()) {
        AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &sz);
    }
    if (posVal) CFRelease(posVal);
    if (sizeVal) CFRelease(sizeVal);
    out->origin = pos;
    out->size = sz;
    return true;
}

// Returns a +1 AXUIElementRef the caller must CFRelease, or NULL.
static AXUIElementRef AXFocusedWindow(AXUIElementRef app) {
    CFTypeRef win = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &win) == kAXErrorSuccess && win != NULL) {
        return (AXUIElementRef)win;
    }
    CFArrayRef wins = AXArrayAttr(app, kAXWindowsAttribute);
    if (wins == NULL) return NULL;
    AXUIElementRef first = NULL;
    if (CFArrayGetCount(wins) > 0) {
        AXUIElementRef borrowed = (AXUIElementRef)CFArrayGetValueAtIndex(wins, 0);
        if (borrowed) {
            CFRetain(borrowed);
            first = borrowed;
        }
    }
    CFRelease(wins);
    return first;
}

// ── Tree → JS object ────────────────────────────────────────────────

static Napi::Object NodeToJs(Napi::Env env, AXUIElementRef el, int depth, int maxDepth) {
    Napi::Object obj = Napi::Object::New(env);
    std::string handle = HandleStoreRegister(el);
    obj.Set("handle", handle);

    NSString *role = AXStringAttr(el, kAXRoleAttribute);
    if (role != nil) obj.Set("role", std::string([role UTF8String]));

    NSString *name = AXStringAttr(el, kAXTitleAttribute);
    if (name == nil || name.length == 0) {
        name = AXStringAttr(el, (CFStringRef)@"AXValueDescription");
    }
    if (name != nil && name.length > 0) obj.Set("name", std::string([name UTF8String]));

    NSString *value = AXStringAttr(el, kAXValueAttribute);
    if (value != nil && value.length > 0) obj.Set("value", std::string([value UTF8String]));

    NSString *desc = AXStringAttr(el, kAXDescriptionAttribute);
    if (desc != nil && desc.length > 0) obj.Set("description", std::string([desc UTF8String]));

    NSNumber *enabled = AXBoolAttr(el, kAXEnabledAttribute);
    if (enabled != nil) obj.Set("enabled", enabled.boolValue);
    NSNumber *focused = AXBoolAttr(el, kAXFocusedAttribute);
    if (focused != nil) obj.Set("focused", focused.boolValue);

    CGRect frame;
    if (AXFrame(el, &frame)) {
        Napi::Object bounds = Napi::Object::New(env);
        bounds.Set("x", frame.origin.x);
        bounds.Set("y", frame.origin.y);
        bounds.Set("w", frame.size.width);
        bounds.Set("h", frame.size.height);
        obj.Set("bounds", bounds);
    }

    if (depth < maxDepth) {
        CFArrayRef kids = AXArrayAttr(el, kAXChildrenAttribute);
        if (kids != NULL) {
            CFIndex n = CFArrayGetCount(kids);
            if (n > 0) {
                Napi::Array arr = Napi::Array::New(env, (size_t)n);
                for (CFIndex i = 0; i < n; i++) {
                    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(kids, i);
                    if (child != NULL) {
                        arr.Set((uint32_t)i, NodeToJs(env, child, depth + 1, maxDepth));
                    }
                }
                obj.Set("children", arr);
            }
            CFRelease(kids);
        }
    }
    return obj;
}

// ── Exported JS functions ───────────────────────────────────────────

static Napi::Value Dump(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!AXIsProcessTrusted()) {
        Napi::Error::New(env,
            "permission-denied: enable Accessibility for this app in "
            "System Settings → Privacy & Security → Accessibility")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    pid_t targetPid = 0;
    int maxDepth = 25;
    if (info.Length() > 0 && info[0].IsObject()) {
        Napi::Object opts = info[0].As<Napi::Object>();
        if (opts.Has("pid") && opts.Get("pid").IsNumber()) {
            targetPid = (pid_t)opts.Get("pid").As<Napi::Number>().Int32Value();
        }
        if (opts.Has("maxDepth") && opts.Get("maxDepth").IsNumber()) {
            maxDepth = opts.Get("maxDepth").As<Napi::Number>().Int32Value();
        }
    }

    NSRunningApplication *runningApp = nil;
    if (targetPid != 0) {
        runningApp = [NSRunningApplication runningApplicationWithProcessIdentifier:targetPid];
    } else {
        runningApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    }
    if (runningApp == nil) {
        Napi::Error::New(env, "no-app: could not resolve target application")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    AXUIElementRef axApp = AXUIElementCreateApplication(runningApp.processIdentifier);
    if (axApp == NULL) {
        Napi::Error::New(env, "ax-app-failed: AXUIElementCreateApplication returned NULL")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    AXUIElementRef window = AXFocusedWindow(axApp);
    CFRelease(axApp);
    if (window == NULL) {
        NSString *msg = [NSString stringWithFormat:@"no-window: %@ has no focused window",
                         runningApp.localizedName ?: @"?"];
        Napi::Error::New(env, [msg UTF8String]).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    HandleStoreReset();

    Napi::Object result = Napi::Object::New(env);
    NSString *appName = runningApp.localizedName ?: @"Unknown";
    result.Set("app", std::string([appName UTF8String]));
    NSString *winTitle = AXStringAttr(window, kAXTitleAttribute) ?: @"";
    result.Set("window", std::string([winTitle UTF8String]));
    result.Set("pid", (int32_t)runningApp.processIdentifier);

    Napi::Array tree = Napi::Array::New(env, 1);
    tree.Set((uint32_t)0, NodeToJs(env, window, 0, maxDepth));
    result.Set("tree", tree);

    CFRelease(window);
    return result;
}

static Napi::Value Perform(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "expected { handle, action }").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object opts = info[0].As<Napi::Object>();
    if (!opts.Has("handle") || !opts.Has("action")) {
        Napi::TypeError::New(env, "expected { handle, action }").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string handle = opts.Get("handle").As<Napi::String>();
    std::string action = opts.Get("action").As<Napi::String>();
    AXUIElementRef el = HandleStoreLookup(handle);
    if (el == NULL) {
        Napi::Error::New(env, "stale-handle: call dump first").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NSString *actStr = [NSString stringWithUTF8String:action.c_str()];
    AXError err = AXUIElementPerformAction(el, (__bridge CFStringRef)actStr);
    if (err != kAXErrorSuccess) {
        NSString *msg = [NSString stringWithFormat:@"perform-failed: AXError %d performing %@",
                         err, actStr];
        Napi::Error::New(env, [msg UTF8String]).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("ok", true);
    return out;
}

static Napi::Value SetValue(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "expected { handle, value }").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object opts = info[0].As<Napi::Object>();
    std::string handle = opts.Get("handle").As<Napi::String>();
    std::string value = opts.Get("value").As<Napi::String>();
    AXUIElementRef el = HandleStoreLookup(handle);
    if (el == NULL) {
        Napi::Error::New(env, "stale-handle: call dump first").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    NSString *valStr = [NSString stringWithUTF8String:value.c_str()];
    AXError err = AXUIElementSetAttributeValue(el, kAXValueAttribute, (__bridge CFStringRef)valStr);
    if (err != kAXErrorSuccess) {
        NSString *msg = [NSString stringWithFormat:@"set-value-failed: AXError %d", err];
        Napi::Error::New(env, [msg UTF8String]).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("ok", true);
    return out;
}

static Napi::Value Resolve(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "expected { handle }").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object opts = info[0].As<Napi::Object>();
    std::string handle = opts.Get("handle").As<Napi::String>();
    AXUIElementRef el = HandleStoreLookup(handle);
    if (el == NULL) {
        Napi::Error::New(env, "stale-handle: call dump first").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    CGRect frame;
    if (AXFrame(el, &frame)) {
        out.Set("x", frame.origin.x);
        out.Set("y", frame.origin.y);
        out.Set("w", frame.size.width);
        out.Set("h", frame.size.height);
    }
    NSNumber *enabled = AXBoolAttr(el, kAXEnabledAttribute);
    if (enabled != nil) out.Set("enabled", enabled.boolValue);
    NSNumber *focused = AXBoolAttr(el, kAXFocusedAttribute);
    if (focused != nil) out.Set("focused", focused.boolValue);
    return out;
}

static Napi::Value IsTrusted(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(), AXIsProcessTrusted() ? true : false);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("dump", Napi::Function::New(env, Dump));
    exports.Set("perform", Napi::Function::New(env, Perform));
    exports.Set("setValue", Napi::Function::New(env, SetValue));
    exports.Set("resolve", Napi::Function::New(env, Resolve));
    exports.Set("isTrusted", Napi::Function::New(env, IsTrusted));
    return exports;
}

NODE_API_MODULE(ax_bridge, Init)
