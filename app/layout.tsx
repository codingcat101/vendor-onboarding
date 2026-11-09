import type { Metadata } from "next";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { StoreProvider } from "@/lib/client/store";
import Shell from "@/components/Shell";

export const metadata: Metadata = {
  title: "Vendor Onboarding",
  description: "Vendor onboarding that checks submissions, chases vendors for fixes, and learns from reviewers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>
          <Shell>{children}</Shell>
        </StoreProvider>
      </body>
    </html>
  );
}
