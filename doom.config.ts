import { defineConfig } from "@alauda/doom/config";
import { join } from "node:path";
import { blogPostResolver } from "./plugins/plugin-post-resolver";

export default defineConfig({
  title: "Alauda Knowledge",
  base: "/knowledge/",
  description:
    "Welcome back to Alauda's Knowledgebase information center. Find resources for resolving problems and troubleshooting.",
  logo: "/logo.svg",
  logoText: "Alauda Knowledge",
  globalStyles: join(__dirname, "styles/index.css"),
  plugins: [
    blogPostResolver({
      postsDir: join(__dirname, "docs"),
    }),
  ],
  themeConfig: {
    lastUpdated: true,
    footer: {
      message: "© 2025 Alauda Inc. All Rights Reserved.",
    },
  },
  builderConfig: {
    output: {
      assetPrefix: "/knowledge/",
    },
  },
});
