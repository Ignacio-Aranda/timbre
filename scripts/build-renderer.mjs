// Bundles the renderer entry points (which import npm libraries like
// mediasoup-client and socket.io-client) into plain IIFE scripts that the
// Electron renderer loads directly. Output sits next to the HTML files.

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const entries = [
  { in: path.join(rendererDir, 'flyout.js'), out: path.join(rendererDir, 'flyout.bundle.js') },
  { in: path.join(rendererDir, 'home.js'), out: path.join(rendererDir, 'home.bundle.js') },
];

async function run() {
  for (const e of entries) {
    const opts = { ...common, entryPoints: [e.in], outfile: e.out };
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
    } else {
      await esbuild.build(opts);
    }
  }
  if (!watch) console.log('Renderer bundles listos.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
