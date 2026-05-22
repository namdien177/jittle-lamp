import { getWorkspaceVersion } from "../../../scripts/release/workspace-version";

export const extensionManifest = {
  manifest_version: 3,
  name: "jittle-lamp",
  version: getWorkspaceVersion(),
  description: "Local-first active-tab recorder for Chromium browser sessions.",
  minimum_chrome_version: "123",
  action: {
    default_title: "jittle-lamp",
    default_popup: "popup.html",
    default_icon: {
      "16": "icon.jpeg",
      "32": "icon.jpeg",
      "48": "icon.jpeg",
      "128": "icon.jpeg"
    }
  },
  icons: {
    "16": "icon.jpeg",
    "32": "icon.jpeg",
    "48": "icon.jpeg",
    "128": "icon.jpeg"
  },
  background: {
    service_worker: "background.js",
    type: "module"
  },
  permissions: [
    "activeTab",
    "scripting",
    "storage",
    "alarms",
    "downloads",
    "tabCapture",
    "debugger",
    "offscreen",
    "webRequest"
  ],
  host_permissions: [
    "http://127.0.0.1/*",
    "http://127.0.0.1:3001/*",
    "https://jl-api.monthlyparty.com/*"
  ],
  optional_host_permissions: ["<all_urls>"]
} satisfies chrome.runtime.ManifestV3;
