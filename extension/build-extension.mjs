import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const name of ['background', 'content']) {
  await build({ entryPoints: [`src/${name}.ts`], outfile: `dist/${name}.js`,
    bundle: true, format: 'iife', target: 'chrome116', minify: false });
}
await copyFile('manifest.json', 'dist/manifest.json');
