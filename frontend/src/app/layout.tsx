import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claude Office Visualizer",
  description:
    "Real-time pixel art visualization of Claude Code operations in a virtual office",
  // (로컬 커스텀) 아이폰 홈 화면 앱(PWA). manifest 에 start_url 을 두지 않는다 —
  // 홈 화면에 추가할 때 보던 주소(?token= 포함)가 시작 주소가 되어야
  // Safari 와 쿠키를 따로 쓰는 홈 화면 앱도 LAN 토큰을 받는다.
  manifest: "/manifest.webmanifest",
  icons: { apple: "/apple-touch-icon.png" },
  appleWebApp: {
    capable: true,
    title: "Pixel Office",
    statusBarStyle: "black",
  },
  // Next 16 은 mobile-web-app-capable 만 넣어서, 예전 iOS 용 이름도 같이 둔다.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
