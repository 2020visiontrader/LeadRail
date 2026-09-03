import './globals.css';
import AppShell from '@/components/AppShell';
import ToastProvider from '@/components/ToastProvider';
import VentureScopeProvider from '@/components/VentureScopeProvider';

export const metadata = {
  title: 'LeadRail',
  description: 'Multi-brand lead CRM — pipeline, outreach & campaigns command center',
};

// Apply saved theme before paint to avoid a flash of the wrong mode.
const themeInit = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <ToastProvider>
          <VentureScopeProvider>
            <AppShell>{children}</AppShell>
          </VentureScopeProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
