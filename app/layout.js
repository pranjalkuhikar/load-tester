import "./globals.css";

export const metadata = {
  title: "LoadLab — local load testing",
  description: "Send 500 to 1,000,000 requests to your local APIs and see how they hold up.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
