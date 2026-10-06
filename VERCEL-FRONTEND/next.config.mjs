/** @type {import('next').NextConfig} */
const backend = process.env.SOLIVY_BACKEND_URL;
if (!backend && process.env.NODE_ENV === 'production') {
  console.warn('SOLIVY_BACKEND_URL is not configured; /api requests will not be proxied.');
}
const nextConfig = {
  poweredByHeader: false,
  async rewrites() {
    if (!backend) return [];
    return [{ source: '/api/:path*', destination: `${backend.replace(/\/$/, '')}/api/:path*` }];
  }
};
export default nextConfig;
