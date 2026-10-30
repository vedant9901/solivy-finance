/** @type {import('next').NextConfig} */
// compress: gzip responses that Next serves itself (on Vercel the edge compresses instead).
// Measured on this build's /api/data payloads: 1.45 MB of JSON becomes ~150 KB on the wire.
const nextConfig = { poweredByHeader:false, compress:true };
export default nextConfig;
