import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";

export const metadata: Metadata = {
  title: "QQ Bot Admin",
  description: "Admin WebUI for qq-bot-v2",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex min-h-screen bg-slate-50">
          <Sidebar />
          {/* Main content — offset by sidebar width; default 224px (w-56), collapsed 64px (w-16) */}
          <main className="flex-1 ml-56 min-w-0 transition-[margin] duration-200">
            <div className="max-w-6xl mx-auto px-6 py-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
