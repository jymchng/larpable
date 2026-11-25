import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isOrphanPreviewVisit, renderOrphanPreviewVisit } from "./preview/orphan-url";
import { App } from "./ui/App";
import { AppProviders } from "./ui/providers";
import "./ui/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Larpable could not start: #root is missing from index.html");
}

/**
 * A preview URL opened on its own is not a page: the worker that answers it lives in the app
 * that made the session, and the id changes on every reload (see `preview/orphan-url.ts`).
 * Without this check the visitor got the app booting a Linux machine on an address that
 * promised a preview — and, inside a stale frame, a second machine booting inside itself.
 */
const controlled =
  typeof navigator !== "undefined" &&
  navigator.serviceWorker != null &&
  navigator.serviceWorker.controller !== null;

if (isOrphanPreviewVisit(window.location.pathname, controlled)) {
  renderOrphanPreviewVisit(rootElement, window.location.pathname);
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </StrictMode>,
  );
}
