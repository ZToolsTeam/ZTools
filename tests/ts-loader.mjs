import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const dir = path.dirname(parentPath);
    const candidates = [
      specifier,
      specifier + '.ts',
      specifier + '.js',
      specifier + '/index.ts',
      specifier + '/index.js'
    ];
    for (const c of candidates) {
      const candidatePath = path.resolve(dir, c);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return nextResolve(pathToFileURL(candidatePath).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
