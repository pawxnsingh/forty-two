import type { Metadata } from "next";
import { Google_Sans_Flex } from "next/font/google";
import { cookies } from "next/headers";
import { FortyTwoApplicationShell } from "./application-shell";
import "./globals.css";

const chatSans = Google_Sans_Flex({
  axes: ["opsz"],
  display: "swap",
  fallback: ["system-ui", "arial"],
  subsets: ["latin"],
  variable: "--font-forty-two-chat",
});

export const metadata: Metadata = {
  title: {
    default: "Forty Two",
    template: "%s | Forty Two",
  },
  description: "AI-native workspace for research, analysis, and visualization.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const defaultSidebarOpen =
    (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <html lang="en">
      <body className={chatSans.variable}>
        <FortyTwoApplicationShell defaultSidebarOpen={defaultSidebarOpen}>
          {children}
        </FortyTwoApplicationShell>
      </body>
    </html>
  );
}
