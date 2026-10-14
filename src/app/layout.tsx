import React from 'react';
import type { Metadata, Viewport } from 'next';
import '../styles/tailwind.css';
import { BUSINESS_NAME } from '@/lib/businessConfig';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: `${BUSINESS_NAME} - Jewellery Inventory & POS`,
  description: 'Custom jewellery inventory, barcode, billing and customer management for Jaishri Gold Palace Pvt Ltd.',
  icons: {
    icon: [{ url: '/favicon.ico', type: 'image/x-icon' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
