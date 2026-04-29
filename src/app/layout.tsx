import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "奶龙志的妙妙画室",
  description: "单人使用的 AI 生图妙妙画室"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
