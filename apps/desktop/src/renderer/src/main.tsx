import { IconContext } from "@phosphor-icons/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/app";
import { appearance } from "./lib/appearance";
import "./styles.css";

appearance.init(); // data-grain / data-motion on <html> before the first render

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <IconContext.Provider value={{ size: 20 }}>
          <App />
        </IconContext.Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
