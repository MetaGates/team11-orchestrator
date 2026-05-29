const fs = require('fs');
const path = require('path');

const baseDir = __dirname;

// Read all source files
const sourceFiles = [
  'src/index.ts',
  'src/db.ts',
  'src/tokenize.ts',
  'src/scoring.ts',
  'src/embeddings.ts',
  'src/decay.ts',
  'src/sync.ts',
  'src/tools/index.ts',
  'src/tools/recall.ts',
  'src/tools/store.ts',
  'src/tools/search.ts',
  'src/tools/pheromones.ts',
  'src/tools/sync.ts',
  'src/scripts/seed.ts',
];

const fileEntries = [];
for (const f of sourceFiles) {
  const content = fs.readFileSync(path.join(baseDir, f), 'utf8');
  fileEntries.push('  files.push({ path: ' + JSON.stringify(f) + ', content: ' + JSON.stringify(content) + ' });\n');
}

const writeSourceFnBody = fileEntries.join('\n');

// Read the CLI template file and inject the writeSourceFiles body
const template = fs.readFileSync(path.join(baseDir, 'src', 'cli-template.ts'), 'utf8');
const fullCli = template.replace('/* __EMBEDDED_SOURCE_FILES__ */', writeSourceFnBody);

fs.writeFileSync(path.join(baseDir, 'src', 'cli.ts'), fullCli);
console.log('Generated src/cli.ts with ' + sourceFiles.length + ' embedded source files');
console.log('File size: ' + fullCli.length + ' bytes');
