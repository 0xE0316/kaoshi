import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "智能多格式批量下单系统",
  description: "Next.js App Router + TypeScript + 规则引擎 + Moonshot Kimi 的物流智能导入项目",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
