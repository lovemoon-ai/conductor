/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the workspace SDK so its dist/ ESM modules are picked up by
  // Next's bundler without surprises.
  transpilePackages: ['@love-moon/app-sdk'],
};

export default nextConfig;
