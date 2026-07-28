import './globals.css';
import AppShell from '@/components/AppShell';
import ToastProvider from '@/components/ToastProvider';

export const metadata = {
  title: 'Marketing Agency OS',
  description: 'CRM + Email Outreach + Social Content Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
