// Thin loader for the ax_bridge native addon. Only loads on darwin —
// returns null on any other platform so the Electron main process can
// gracefully skip OS-route registration without try/catch noise.

"use strict";

if (process.platform !== "darwin") {
  module.exports = null;
} else {
  try {
    // Built by node-gyp into build/Release/ax_bridge.node.
    module.exports = require("./build/Release/ax_bridge.node");
  } catch (e) {
    // Most common cause: the addon wasn't rebuilt for Electron's ABI.
    // Surface a clear hint rather than the raw node-gyp error.
    const hint =
      "[@ponder/mac-ax] failed to load native addon. Run: " +
      "`npm run build:native` (which invokes electron-rebuild against " +
      "this package). Underlying error: " +
      (e && e.message ? e.message : String(e));
    console.error(hint);
    module.exports = null;
  }
}
