import "./globals.css";
import AppShellClient from "./components/AppShellClient";

export const metadata = {
  title: "AI Auditor & Insights Platform",
  description: "Internal audit system",
  other: {
    google: "notranslate",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="notranslate" translate="no">
      <body className="notranslate" translate="no">
        <AppShellClient>{children}</AppShellClient>
      </body>
    </html>
  );
}
