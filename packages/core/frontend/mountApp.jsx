// Generic mount helper. Each app's main.jsx imports this and supplies its own
// <AppShell config={...} renderForm={...} />. This file owns the shared
// providers (Toast, Confirm) + StrictMode + CSS import, so an app's main.jsx
// stays a few lines.
import "./index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./toast.jsx";
import { ConfirmProvider } from "./confirm.jsx";

export function mountApp(node, element) {
  createRoot(node).render(
    <React.StrictMode>
      <ToastProvider>
        <ConfirmProvider>
          {element}
        </ConfirmProvider>
      </ToastProvider>
    </React.StrictMode>
  );
}
