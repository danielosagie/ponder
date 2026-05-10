import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "agent/index": "src/agent/index.ts",
    react: "src/react.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  target: "node18",
  // CLI binary needs a shebang. Our `bin` field points at dist/cli/index.js
  // (the ESM build); tsup writes both .js and .cjs but only the ESM one is
  // executed via npm bin since package.json type=module.
  banner: ({ format }) => ({
    js: format === "esm" ? "#!/usr/bin/env node" : "",
  }),
  // The agent loop, providers, and screen modules pull in optional native
  // deps (nut-js, node-mac-permissions, ollama, playwright-core). Don't
  // bundle them — let consumers' Node resolver find them.
  external: [
    "@nut-tree-fork/nut-js",
    "node-mac-permissions",
    "ollama",
    "playwriter",
    "playwright-core",
    "convex",
    "convex/browser",
    "convex/react",
    "react",
    "react-dom",
  ],
});
