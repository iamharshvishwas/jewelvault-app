import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `next build` writes plain HTML, CSS and JS into out/.
  // No Node server is needed to host it. Server-only features (rewrites, redirects,
  // custom headers, proxy, Server Actions, the default image optimiser) do not exist here.
  // Docs: node_modules/next/dist/docs/01-app/02-guides/static-exports.md
  output: 'export',

  // The built-in image optimiser needs a server, so images are served exactly as stored.
  // `qualities` stays because AppImage defaults to quality 85 and `next dev` warns when a
  // quality is not listed, even for unoptimised images.
  images: {
    unoptimized: true,
    qualities: [75, 85, 100],
  },

  // Never ship browser source maps with the production build.
  productionBrowserSourceMaps: false,

  // Pin the project root so the build never guesses it from a lockfile in a parent folder.
  outputFileTracingRoot: projectRoot,

  devIndicators: false,
};

export default nextConfig;
