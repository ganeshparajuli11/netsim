// Builds dist/opennetsim.html: one self-contained file you can open from disk or host anywhere.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const js = await build({
  entryPoints: ['src/ui/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
});
const css = await readFile('src/ui/styles.css', 'utf8');
let html = await readFile('index.html', 'utf8');
html = html.replace('<link rel="stylesheet" href="src/ui/styles.css">', () => `<style>\n${css}</style>`);
html = html.replace('<script type="module" src="src/ui/app.js"></script>', () => `<script>\n${js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
await mkdir('dist', { recursive: true });
await writeFile('dist/opennetsim.html', html);
console.log(`dist/opennetsim.html  ${(html.length / 1024).toFixed(0)} KB`);

// Fragment for hosts that supply their own document skeleton (e.g. an embedded preview).
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const links = (html.match(/<link [^>]*>/g) || []).join('\n');
const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const fragment = `${title}\n<meta name="description" content="Open-source network simulator for learning.">\n${links}\n${styleBlock}\n${body}`;
await writeFile('dist/opennetsim.fragment.html', fragment);
console.log(`dist/opennetsim.fragment.html  ${(fragment.length / 1024).toFixed(0)} KB`);
