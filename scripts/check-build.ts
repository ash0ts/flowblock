import { access, cp, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = '.next/standalone';
// Weave loads configuration and instrumentation modules dynamically. Next's file
// tracer misses dependencies of those modules; include the installed runtime
// dependency closure without copying development dependencies or private files.
const copied = new Set<string>();
async function copyRuntimePackage(name: string, from: string, optional = false) {
  const require = createRequire(path.join(from, 'package.json'));
  let source: string | undefined;
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = path.join(search, name);
    try { await access(path.join(candidate, 'package.json')); source = candidate; break; } catch { /* Try the next resolution directory. */ }
  }
  if (!source) {
    if (optional) return;
    throw new Error(`Missing runtime dependency: ${name}`);
  }
  if (copied.has(source)) return;
  const relative = path.relative(process.cwd(), source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Runtime dependency is outside this repository: ${name}`);
  copied.add(source);
  await cp(source, path.join(root, relative), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyRuntimePackage(dependency, source, dependency in (manifest.optionalDependencies ?? {}));
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await copyRuntimePackage(dependency, source, true);
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) await copyRuntimePackage(dependency, source, true);
}
await copyRuntimePackage('weave', process.cwd());
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const forbidden = entries.filter(entry => {
  const relative = path.relative(root, path.join(entry.parentPath, entry.name));
  return /^\.env(?:\.|$)/.test(entry.name) || ['.data', '.venv', '.art', 'wandb'].includes(relative.split(path.sep)[0]) || /^worker\/(?:models|vendor)\//.test(relative);
});
if (forbidden.length) throw new Error(`Private runtime files entered the standalone build: ${forbidden.map(e => path.relative(root, path.join(e.parentPath, e.name))).slice(0, 20).join(', ')}`);
await cp('public', path.join(root, 'public'), { recursive: true });
await cp('.next/static', path.join(root, '.next/static'), { recursive: true });
console.log('Standalone bundle excludes environment files, private media, model weights, and local training artifacts.');
