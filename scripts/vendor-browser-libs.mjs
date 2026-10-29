/**
 * Vendors the browser-side libraries into `public/vendor/`.
 *
 * Run after installing dependencies: `npm run vendor`
 *
 *   public/vendor/noble/     @noble/curves + @noble/hashes, ESM, with the bare
 *                            `@noble/hashes/…` specifiers inside curves
 *                            rewritten to relative paths so a browser can load
 *                            them with no import map (and therefore no inline
 *                            script, which the CSP forbids).
 *   public/vendor/jsqr.js    jsQR decoder (UMD global `jsQR`) — the fallback
 *                            for browsers without BarcodeDetector.
 *   public/vendor/qrcode.mjs qrcode-generator ESM — draws the QR stream.
 *
 * Only the import closure of Ed25519 + SHA-256 is copied, so the vendor
 * directory stays small. Licenses are copied beside the code.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = join(root, 'node_modules');
const vendorDir = join(root, 'public', 'vendor');

/** Follows relative ESM imports and returns the reachable set of files. */
function closure(packageDir, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = join(packageDir, rel);
    if (!existsSync(abs)) throw new Error(`vendored file missing: ${packageDir}/${rel}`);
    seen.add(rel);
    const source = readFileSync(abs, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(normalize(join(dirname(rel), match[1])));
    }
  }
  return seen;
}

// --- noble ------------------------------------------------------------------------

const curvesDir = join(nodeModules, '@noble', 'curves');
const hashesDir = join(nodeModules, '@noble', 'hashes');

// Seed from the Ed25519 entry point plus every bare @noble/hashes import it uses.
const curvesFiles = closure(curvesDir, ['ed25519.js']);
const hashesSeeds = new Set();
for (const rel of curvesFiles) {
  const source = readFileSync(join(curvesDir, rel), 'utf8');
  for (const match of source.matchAll(/from\s*['"]@noble\/hashes\/([^'"]+)['"]/g)) hashesSeeds.add(match[1]);
}
const hashesFiles = closure(hashesDir, [...hashesSeeds]);

rmSync(join(vendorDir, 'noble'), { recursive: true, force: true });

/**
 * The relative prefix that reaches `targetDir` from the directory of `rel`
 * inside the vendored package (a file in `abstract/` needs one more `../`
 * than a file at the package root).
 */
function prefixFor(rel, targetDir) {
  const from = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
  const relative = posix.relative(from, targetDir);
  if (!relative) return './';
  return relative.startsWith('.') ? `${relative}/` : `./${relative}/`;
}

for (const [packageName, files, destination] of [
  ['curves', curvesFiles, join(vendorDir, 'noble', 'curves')],
  ['hashes', hashesFiles, join(vendorDir, 'noble', 'hashes')],
]) {
  for (const rel of files) {
    const target = join(destination, rel);
    mkdirSync(dirname(target), { recursive: true });
    let source = readFileSync(join(nodeModules, '@noble', packageName, rel), 'utf8');
    // Bare @noble specifiers are meaningless to a browser; rewrite each one to
    // the path that file actually needs. Same-package imports resolve within
    // the package; curves -> hashes resolves up and over to ../hashes/.
    source = source
      .replace(/from(\s*['"])@noble\/hashes\/([^'"]+)/g,
        (_match, quote, path) => `from${quote}${packageName === 'curves' ? prefixFor(rel, '../hashes') : prefixFor(rel, '.')}${path}`)
      .replace(/from(\s*['"])@noble\/curves\/([^'"]+)/g,
        (_match, quote, path) => `from${quote}${prefixFor(rel, '.')}${path}`);
    writeFileSync(target, source);
  }
  copyFileSync(join(nodeModules, '@noble', packageName, 'LICENSE'), join(vendorDir, 'noble', packageName, 'LICENSE'));
}
// hashes files sit one level below noble/, so their own `./x.js` stays valid;
// curves files reference `../hashes/…`, which is also one level below noble/.

// --- QR encoder + decoder ----------------------------------------------------------

mkdirSync(vendorDir, { recursive: true });
copyFileSync(join(nodeModules, 'qrcode-generator', 'dist', 'qrcode.mjs'), join(vendorDir, 'qrcode.mjs'));
copyFileSync(join(nodeModules, 'jsqr', 'dist', 'jsQR.js'), join(vendorDir, 'jsqr.js'));
const jsqrLicense = join(nodeModules, 'jsqr', 'LICENSE');
if (existsSync(jsqrLicense)) copyFileSync(jsqrLicense, join(vendorDir, 'jsqr.LICENSE'));
const qrcodeLicense = join(nodeModules, 'qrcode-generator', 'LICENSE');
if (existsSync(qrcodeLicense)) copyFileSync(qrcodeLicense, join(vendorDir, 'qrcode.LICENSE'));

console.log(`vendored: noble curves ${curvesFiles.size} file(s), hashes ${hashesFiles.size} file(s), jsqr.js, qrcode.mjs`);
console.log(`  curves: ${[...curvesFiles].join(', ')}`);
console.log(`  hashes: ${[...hashesFiles].join(', ')}`);
