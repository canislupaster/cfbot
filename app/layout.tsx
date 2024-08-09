import '@mantine/core/styles.css';
import { ColorSchemeScript, createTheme, MantineProvider } from '@mantine/core';

import type { Metadata } from "next";
import { Montserrat, Red_Hat_Mono } from "next/font/google";
import icon from "./circuiticon.png";

const mont = Montserrat({ subsets: ["latin"] });
const redhat = Red_Hat_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CFBot",
  description: "sneak a hint from CF editorials with mr LLM!"
};

const theme = createTheme({
  black: "#f8f7f5",
  white: "#21201f",
  autoContrast: true,
  luminanceThreshold: 0.1,
  primaryColor: "blue",
  colors: {
    gray: [
      "#f4f2f0",
      "#eae5e1",
      "#d4cac4",
      "#bfb0a6",
      "#a99689",
      "#947b6b",
      "#766356",
      "#594a40",
      "#3b312b",
      "#1e1915"
    ].reverse() as any,
    blue: [
      "#fcebe9",
      "#f9d7d2",
      "#f3aea5",
      "#ed8678",
      "#e75e4b",
      "#e0351f",
      "#b42b18",
      "#872012",
      "#5a150c",
      "#2d0b06"
    ]
  },
  fontFamily: redhat.style.fontFamily,
  headings: {
    fontFamily: mont.style.fontFamily,
    fontWeight: "800"
  }
});

export default function RootLayout({ children }: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <ColorSchemeScript />
        <link rel="icon" href={icon.src} />
      </head>
      <body>
        <MantineProvider theme={theme} >
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
