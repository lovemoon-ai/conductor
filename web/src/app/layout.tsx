import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { FeedbackProvider } from "@/components/common/FeedbackProvider";
import { ServiceWorkerRegister } from "@/components/common/ServiceWorkerRegister";
import "./globals.css";

const SITE_ICON_URL = "/icon.svg?v=20260309b";

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: "Conductor",
  description: "Chat to your AI workers, like conducting a symphony.",
  manifest: "/manifest.json?v=20260309b",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Conductor",
  },
  icons: {
    icon: [{ url: SITE_ICON_URL, type: "image/svg+xml" }],
    apple: [{ url: SITE_ICON_URL, type: "image/svg+xml" }],
    shortcut: [{ url: SITE_ICON_URL, type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <FeedbackProvider>{children}</FeedbackProvider>
        </ThemeProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
