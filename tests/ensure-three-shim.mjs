// The browser app imports the bare specifier 'three' (resolved by the import map in
// index.html). For the Node test suite the same modules need 'three' resolvable from
// node_modules, so this script mirrors vendor/three.module.js into a minimal package.
// Runs automatically via the npm "pretest" hook.
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'node_modules', 'three');
if (!existsSync(join(dir, 'three.module.js'))) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'vendor', 'three.module.js'), join(dir, 'three.module.js'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'three', version: '0.169.0', type: 'module',
    main: 'three.module.js', exports: { '.': './three.module.js' },
  }, null, 2));
  console.log('created node_modules/three shim from vendor/');
}
