import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, webPlatform } from "@slackoss/ui";
import { electronPlatform } from "./platform.js";
import "./index.css";

// window.slackoss is absent when this page is opened in a plain browser.
const platform = window.slackoss ? electronPlatform() : webPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
