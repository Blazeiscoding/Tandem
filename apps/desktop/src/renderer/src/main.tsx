import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, webPlatform } from "@slackoss/ui";
import { electronPlatform, followPlace } from "./platform.js";
import "./index.css";

// window.slackoss is absent when this page is opened in a plain browser.
const platform = window.slackoss ? electronPlatform() : webPlatform();

// After a crash, the page comes back where it was before the app reads it.
void (window.slackoss ? followPlace(window.slackoss) : Promise.resolve()).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App platform={platform} />
    </StrictMode>,
  ),
);
