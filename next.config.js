/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    tsconfigPath: './tsconfig.json'
  },
  // Deck parsers are heavy Node-only libs (pdfjs, mammoth, jszip, xlsx). Keep
  // them external so webpack doesn't try to bundle native/worker code into the
  // server chunks — they're only ever imported in the deck route at runtime.
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'mammoth', 'jszip', 'xlsx']
  }
};

module.exports = nextConfig;
