import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, webPlatform } from "@slackoss/ui";
import "./index.css";

// Ask for notification permission once the user interacts.
if (typeof Notification !== "undefined" && Notification.permission === "default") {
  window.addEventListener("click", () => void Notification.requestPermission(), { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App platform={webPlatform()} />
  </StrictMode>,
);
