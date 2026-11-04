import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
export const metadata: Metadata = {
  title: 'Crypto Intelligence · Research Console',
  description:
    'Auditable simulated crypto research. Virtual capital, immutable evidence, honest evaluation.',
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
