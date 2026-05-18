/**
 * Minimal type shim for `ink-gradient` v2 — it ships without bundled
 * typings, but we use a tiny subset (one component, two props). Keeps
 * `npx tsc --noEmit` clean without an extra @types dep.
 */
declare module "ink-gradient" {
  import * as React from "react";

  interface GradientProps {
    /** Built-in gradient name or an array of hex stops. */
    name?: string;
    /** Array of color stops (hex strings). Takes precedence over `name`. */
    colors?: string[];
    children?: React.ReactNode;
  }

  const Gradient: React.FC<GradientProps>;
  export default Gradient;
}
