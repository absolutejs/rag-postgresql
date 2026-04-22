import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (packageJson.name !== '@absolutejs/absolute-rag-postgresql') {
  throw new Error(`Unexpected package name: ${packageJson.name}`);
}

if (packageJson.version !== '0.0.1') {
  throw new Error(`Unexpected package version: ${packageJson.version}`);
}

console.log('absolute-rag-postgresql scaffold looks consistent');
