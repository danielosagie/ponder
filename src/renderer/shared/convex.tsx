import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode, useEffect, useState } from "react";

export function ConvexShell({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<ConvexReactClient | null>(null);

  useEffect(() => {
    void window.agent.getEnv().then(({ convexUrl }) => {
      if (!convexUrl) {
        console.warn("Convex URL missing — history will not persist.");
        return;
      }
      setClient(new ConvexReactClient(convexUrl));
    });
  }, []);

  if (!client) {
    return (
      <div style={{ color: "#888", padding: 16, fontSize: 13 }}>
        Connecting to Convex…
      </div>
    );
  }
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
