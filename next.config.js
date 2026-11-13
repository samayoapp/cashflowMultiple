/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Mitigación de seguridad: Next 14.2 ya no recibe parches para el Image Optimizer.
  // No usamos next/image con optimización; se sirve la imagen original.
  images: { unoptimized: true },
  experimental: {
    // Tarea diaria del tipo de cambio (src/instrumentation.ts)
    instrumentationHook: true,
    // Prisma y bcrypt solo en servidor
    serverComponentsExternalPackages: ['@prisma/client', 'bcryptjs', 'pg'],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Hot reload estable dentro de Docker (igual que CRM Publimatec)
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
        ignored: ['**/node_modules/**', '**/.git/**', '**/.next/**'],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
