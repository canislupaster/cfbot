import '@mantine/core/styles.css';
import '@mantine/code-highlight/styles.css';

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
  white: "#f8f7f5",
  black: "#21201f",
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
    ],
    dark: [
      "#f8f7f5", //0
      "#b5b0a5", //1
      "#9c8a7e", //2
      "#948378", //3
      "#947b6b", //4
      "#1e1915", //5
      "#2e2b28", //6
      "#21201f", //7
      "#1a1817", //8
      "#0d0c0c", //9
    ],
    blue: [
      "#5a150c",
      "#7e1e11",
      "#a22616",
      "#c52f1b",
      "#e23d28",
      "#e75e4b",
      "#eb7e6f",
      "#f09e93",
      "#f5beb7",
      "#fadfdb"
    ].reverse() as any
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
        <MantineProvider forceColorScheme="dark" theme={theme} >
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
