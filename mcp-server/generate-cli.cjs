const fs = require('fs');
const path = require('path');

const baseDir = __dirname;

// Embedded source files. This list MUST mirror the live `src/` tree (minus the
// two CLI-bundle artifacts cli.ts + cli-template.ts, which are never embedded
// in themselves). The init() path no longer reads this snapshot — it copies the
// live tree via copyLiveSource (D3 fix) — but the embedded copy is retained as a
// diff reference, so it must stay current. If you add a source file, add it here.
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
  'src/tools/summaries.ts',
  'src/tools/contradictions.ts',
  'src/tools/health.ts',
  'src/tools/coordination.ts',
  'src/scripts/seed.ts',
  'src/scripts/bootstrap.ts',
  'src/scripts/init-project.ts',
  'src/scripts/process-pair-log.ts',
  'src/scripts/write-and-sync.ts',
  'src/scripts/consolidate-memory.ts',
];

// Fail loudly if the embed list drifts from the live tree — a missing file here
// means the bundle would ship an incomplete diff reference (the original staleness bug).
const liveTsFiles = [];
(function walk(dir, rel) {
  for (const entry of fs.readdirSync(path.join(baseDir, dir))) {
    const relPath = rel ? rel + '/' + entry : entry;
    const abs = path.join(baseDir, dir, entry);
    if (fs.statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(path.join(dir, entry), relPath);
    } else if (entry.endsWith('.ts') && entry !== 'cli.ts' && entry !== 'cli-template.ts') {
      liveTsFiles.push('src/' + relPath);
    }
  }
})('src', '');
const missing = liveTsFiles.filter((f) => !sourceFiles.includes(f));
if (missing.length > 0) {
  console.error('ERROR: live source files missing from generate-cli.cjs sourceFiles list:\n  ' + missing.join('\n  '));
  console.error('Add them to the sourceFiles array (the embedded snapshot must mirror the live tree).');
  process.exit(1);
}

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
