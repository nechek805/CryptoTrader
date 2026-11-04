import type { NextConfig } from 'next';
const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ['@crypto/contracts'],
  webpack(cfg: { resolve?: { extensionAlias?: Record<string, string[]> } }) {
    cfg.resolve ??= {};
    cfg.resolve.extensionAlias = { ...cfg.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return cfg;
  },
  // Next's configuration contract requires promises even for fixed local routes.
  // eslint-disable-next-line @typescript-eslint/require-await
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:3101/:path*' }];
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
          },
        ],
      },
    ];
  },
};
export default config;
