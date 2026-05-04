import { createRoot } from "react-dom/client";
import { ConvexShell } from "../shared/convex";
import { Overlay } from "./Overlay";

createRoot(document.getElementById("root")!).render(
  <ConvexShell>
    <Overlay />
  </ConvexShell>,
);
