import { createRoot } from "react-dom/client";
import { ConvexShell } from "../shared/convex";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <ConvexShell>
    <App />
  </ConvexShell>,
);
