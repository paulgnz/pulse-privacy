import { track } from "@vercel/analytics";

/** Funnel events for Vercel Web Analytics: step names and a token code, never an account or an amount. */
export type StatEvent = "connected" | "registered" | "deposited" | "sent" | "withdrew" | "folded";
export function event(name: StatEvent, props?: { token?: string }): void {
  if (!import.meta.env.PROD) return;
  try {
    track(name, props);
  } catch {
    /* analytics must never break the app */
  }
}
