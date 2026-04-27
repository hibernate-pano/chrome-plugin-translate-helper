import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir(new globalThis.URL('../apps/chrome-extension/dist', import.meta.url), { recursive: true });

for (const fileName of ['popup.html', 'options.html']) {
  await cp(new globalThis.URL(`../apps/chrome-extension/${fileName}`, import.meta.url), new globalThis.URL(`../apps/chrome-extension/dist/${fileName}`, import.meta.url));
}

const manifestUrl = new globalThis.URL('../apps/chrome-extension/manifest.json', import.meta.url);
const distManifestUrl = new globalThis.URL('../apps/chrome-extension/dist/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

if (manifest.background?.service_worker) {
  manifest.background.service_worker = manifest.background.service_worker.replace(/^dist\//, '');
}

if (Array.isArray(manifest.content_scripts)) {
  for (const contentScript of manifest.content_scripts) {
    if (Array.isArray(contentScript.js)) {
      contentScript.js = contentScript.js.map((scriptPath) => scriptPath.replace(/^dist\//, ''));
    }
  }
}

await writeFile(distManifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
