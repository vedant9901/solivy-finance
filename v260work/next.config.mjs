/** @type {import('next').NextConfig} */
const isOnlineBuild = process.env.DEPLOYMENT_MODE === 'online';

const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    resolveAlias: isOnlineBuild
      ? {
          './db-sqlite': './db-sqlite-online-stub.ts',
        }
      : {},
  },
};

export default nextConfig;
