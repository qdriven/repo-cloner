// isolated test of the registry parser in server/core.mjs
// usage: node tools/test-parser.mjs [path/to/registry_references.yaml]
import fs from 'node:fs';
import path from 'node:path';
import { parseRegistry } from '../server/core.mjs';

const file = process.argv[2] || path.join(process.cwd(), 'registry_references.yaml');
if (!fs.existsSync(file)) {
  console.error(`usage: node tools/test-parser.mjs <registry_references.yaml>\n  not found: ${file}`);
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const projects = parseRegistry(text);
console.log('parsed:', projects.length);
console.log(JSON.stringify(projects.slice(0, 3), null, 1));
console.log('categories:', [...new Set(projects.map((p) => p.category))].join(', '));
const bad = projects.filter((p) => !p.name || !p.repo || !p.path);
console.log('bad entries:', bad.length);
