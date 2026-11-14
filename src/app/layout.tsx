import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cashflow Publimatec',
  description: 'Tesorería operativa y flujo de efectivo proyectado con varias unidades de negocio',
  icons: { icon: '/icon.svg' },
};

// Aplica el tema antes de pintar para evitar parpadeo
const themeScript = `(function(){try{var t=localStorage.getItem('cf_theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
