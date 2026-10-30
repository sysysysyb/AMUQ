import "./globals.css";

import { ToastProvider } from "@frontend/components/ui/toast-provider";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AMUQ",
  description: "아무 자료나 Question으로 바꾸는 개인 학습 서비스",
};

const RootLayout = ({ children }: Readonly<{ children: ReactNode }>) => {
  return (
    <html lang="ko">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
};

export default RootLayout;
