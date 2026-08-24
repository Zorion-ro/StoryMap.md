#!/usr/bin/env node
/**
 * Copies the browser's own assets next to the compiled JavaScript.
 *
 * `tsc` emits only TypeScript output, and the server resolves `static/`
 * relative to its own module directory so a globally installed copy can find
 * them. Without this step the published package serves 500s for its own CSS.
 */
import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(packageRoot, 'src', 'static');
const to = join(packageRoot, 'dist', 'static');

if (!existsSync(from)) {
  console.error(`copy-static: nothing at ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });

// npm restores the executable bit from the tarball, but a local `npm link` or a
// direct `node dist/cli.js` should work straight after a build too.
const cli = join(packageRoot, 'dist', 'cli.js');
if (existsSync(cli)) {
  const head = readFileSync(cli, 'utf8');
  if (!head.startsWith('#!')) {
    writeFileSync(cli, `#!/usr/bin/env node\n${head}`, 'utf8');
  }
  chmodSync(cli, 0o755);
}
console.log(`copy-static: ${from} -> ${to}`);
