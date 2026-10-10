import { useEffect } from "react";
import { session } from "./lib/app";
import { AuthScreen } from "./screens/AuthScreen";
import { Shell } from "./screens/Shell";
import { Splash } from "./screens/Splash";

export function App() {
  const status = session.useSession((s) => s.status);
  useEffect(() => void session.start(), []);

  if (status === "signedIn") return <Shell />;
  if (status === "signedOut") return <AuthScreen />;
  return <Splash offline={status === "offline"} onRetry={() => void session.start()} />;
}
