{
  "targets": [
    {
      "target_name": "ax_bridge",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/ax_bridge.mm"],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "dependencies": [
            "<!(node -p \"require('node-addon-api').gyp\")"
          ],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
          },
          "link_settings": {
            "libraries": [
              "-framework ApplicationServices",
              "-framework AppKit",
              "-framework Foundation",
              "-framework CoreFoundation"
            ]
          }
        }]
      ]
    }
  ]
}
