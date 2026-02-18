import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QQ Bot Admin",
  description: "Admin WebUI for qq-bot-v2"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
