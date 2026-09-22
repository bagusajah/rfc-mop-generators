// App context: lets each app (RFC, MOP, …) inject its domain-specific
// helpers into the shared core UI components (components.jsx) without core
// hard-importing the app's schema. The app's main.jsx provides a value at
// mount; core components read it via useApp().
//
// Required shape:
//   { REVIEW_SECTIONS, govCheck, scopeWarnings }
// (mirrors what apps/rfc/rfc-schema.js and apps/mop/mop-schema.js export).
import React from "react";

const Ctx = React.createContext(null);

export const AppProvider = Ctx.Provider;
export function useApp() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useApp() used outside <AppProvider> — wire it in main.jsx");
  return v;
}
