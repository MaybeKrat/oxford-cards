import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/golos-text";
import "./styles.css";
import { readState } from "./lib/storage";
import { applyTheme } from "./lib/theme";

// Apply the saved preference before React's first paint. Storage recovery stays in App.
try {
  applyTheme(readState().settings.theme);
} catch {
  applyTheme("system");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
