import type { ReactNode } from 'react';

export const metadata = {
  title: 'Conductor App SDK demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          background: '#fafafa',
          color: '#111',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
