import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/lib/i18n";

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(
  <React.StrictMode>
    <I18nProvider>
      <ToastProvider position="bottom-right">
        <AnchoredToastProvider>
          <TooltipProvider delay={300}>
            <App />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    </I18nProvider>
  </React.StrictMode>,
);
