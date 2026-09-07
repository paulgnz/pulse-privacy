import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/** the shield site (VITE_APP=shield) gets its own title and share text; index.html carries the confidential ones */
const SHIELD_HEAD: [RegExp, string][] = [
  [/<title>[^<]*<\/title>/, "<title>Shielded XPR</title>"],
  [/(<meta name="description" content=")[^"]*/, "$1Shielded payments on XPR Network. Pay someone with the receiver and the amount sealed from everyone except you, them and the auditor."],
  [/(<meta property="og:site_name" content=")[^"]*/, "$1Shielded XPR"],
  [/(<meta property="og:title" content=")[^"]*/, "$1Shielded payments on XPR Network"],
  [/(<meta name="twitter:title" content=")[^"]*/, "$1Shielded payments on XPR Network"],
  [/(<meta property="og:description" content=")[^"]*/, "$1Pay someone with the receiver and the amount sealed from everyone except you, them and the auditor. Your wallet signs, as always."],
  [/(<meta name="twitter:description" content=")[^"]*/, "$1Pay someone with the receiver and the amount sealed from everyone except you, them and the auditor."],
  [/https:\/\/private\.protonnz\.com\//g, "https://shield.protonnz.com/"],
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const shield = env.VITE_APP === "shield" || process.env.VITE_APP === "shield";
  return {
    plugins: [react(), { name: "site-head", transformIndexHtml: (html) => (shield ? SHIELD_HEAD.reduce((h, [re, to]) => h.replace(re, to), html) : html) }],
    server: { port: 5175 },
    define: { global: "globalThis" },
  };
});
