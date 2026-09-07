import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { inject } from "@vercel/analytics";
import { NETWORK } from "./config";

// Vercel Web Analytics: page views only, no cookies, nothing about accounts or amounts.
if (import.meta.env.PROD && NETWORK === "mainnet") inject();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
