import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, webPlatform } from "@slackoss/ui";
import "./index.css";

// Notification permission is asked from a banner after signing in, not here:
// asking on the first click anywhere usually meant asking on Sign in.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App platform={webPlatform()} />
  </StrictMode>,
);
