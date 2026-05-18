#!/usr/bin/env node
/**
 * Copy / compile src/react/styles.css → dist/react/styles.css.
 *
 * M0: straight copy (the placeholder CSS doesn't use Tailwind yet).
 * M2: swap this for a `@tailwindcss/cli` invocation that compiles
 *     Tailwind utilities used by the extracted chat components.
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const src = resolve(root, 'src/react/styles.css');
const destDir = resolve(root, 'dist/react');
const dest = resolve(destDir, 'styles.css');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);

console.log(`[build-styles] ${src} -> ${dest}`);
