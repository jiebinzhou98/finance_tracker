import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Morrow · 每日收支",
    short_name: "Morrow",
    description: "本地优先、离线可用的个人收支记录工具。",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f6fb",
    theme_color: "#0b1220",
    orientation: "portrait",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
