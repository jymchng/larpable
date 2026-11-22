import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App";
import { AppProviders } from "./ui/providers";
import "./ui/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Larpable could not start: #root is missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
