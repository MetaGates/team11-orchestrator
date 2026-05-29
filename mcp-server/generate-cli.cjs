const fs = require('fs');
const path = require('path');

const baseDir = __dirname;

// Source-file MANIFEST. This list MUST mirror the live `src/` tree (minus the
// two CLI-bundle artifacts cli.ts + cli-template.ts, which never list
// themselves). init() copies the live tree via copyLiveSource (D3 fix) — the
// old embedded snapshot (writeSourceFiles) has been removed from cli-template.ts
// to drop ~177KB of bloat from the generated cli.ts. This manifest is no longer
// injected anywhere; it survives only as a drift INVARIANT — the guards below
// fail the build if the manifest and the live src/ tree disagree in EITHER
// direction. If you add or remove a source file, update this list to match.
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

// Fail loudly if the manifest drifts from the live tree in EITHER direction —
// this is the whole reason the file still keeps a sourceFiles list.
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

// Forward: a live .ts file that the manifest forgot to list.
const missing = liveTsFiles.filter((f) => !sourceFiles.includes(f));
if (missing.length > 0) {
  console.error('ERROR: live source files missing from generate-cli.cjs sourceFiles list:\n  ' + missing.join('\n  '));
  console.error('Add them to the sourceFiles array (the manifest must mirror the live tree).');
  process.exit(1);
}

// Reverse: a manifest entry that no longer exists on disk (renamed/deleted file
// the list still references). The forward guard alone would miss this.
const stale = sourceFiles.filter((f) => !fs.existsSync(path.join(baseDir, f)));
if (stale.length > 0) {
  console.error('ERROR: generate-cli.cjs sourceFiles entries not found on disk:\n  ' + stale.join('\n  '));
  console.error('Remove or rename them in the sourceFiles array (the manifest must mirror the live tree).');
  process.exit(1);
}

// The embedded snapshot is gone — cli.ts is now just the built copy of the
// template (init copies the live src/ tree via copyLiveSource). Generate by
// straight copy. Guard against the old placeholder reappearing: if it's back,
// a stale writeSourceFiles/embedded-snapshot has been reintroduced — fail
// rather than silently ship an un-injected (or re-bloated) cli.ts.
const template = fs.readFileSync(path.join(baseDir, 'src', 'cli-template.ts'), 'utf8');
if (template.includes('__EMBEDDED_SOURCE_FILES__')) {
  console.error('ERROR: cli-template.ts still contains the __EMBEDDED_SOURCE_FILES__ placeholder.');
  console.error('The embedded snapshot was removed (init uses copyLiveSource). Remove the dead');
  console.error('writeSourceFiles function + placeholder from cli-template.ts before regenerating.');
  process.exit(1);
}

fs.writeFileSync(path.join(baseDir, 'src', 'cli.ts'), template);
console.log('Generated src/cli.ts (template copy; manifest validated against ' + sourceFiles.length + ' source files)');
console.log('File size: ' + template.length + ' bytes');
