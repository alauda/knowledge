import { defineConfig } from "@alauda/doom/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blogPostResolver } from "./plugins/plugin-post-resolver/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  title: "Alauda Knowledge",
  base: "/knowledge/",
  description:
    "Welcome to Alauda's Knowledgebase information center. Find resources for resolving problems and troubleshooting.",
  logo: "/logo.svg",
  logoText: "Alauda Knowledge",
  globalStyles: join(__dirname, "styles/index.css"),
  plugins: [
    blogPostResolver({
      postsDir: join(__dirname, "docs"),
    }),
  ],
  themeConfig: {
    darkMode: false,
    lastUpdated: true,
    footer: {
      message: "© 2025 Alauda Inc. All Rights Reserved.",
    },
  },
});
