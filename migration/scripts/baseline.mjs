import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = ['server/testdata/routes.golden', 'server/pkg/response.go', 'server/ws/event.go', 'client/src/crypto/types.ts', 'client/src/audio/README.md', 'package.json'];
const hashes = {};
for (const file of files) {
  hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
const baseline = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  sourceStatus: 'committed reference only; shared checkout changes excluded; release acceptance unverified',
  routes: (await readFile(path.join(root, files[0]), 'utf8')).trim().split(/\r?\n/).filter(Boolean),
  sha256: hashes,
};
const target = path.join(root, 'migration/baseline.json');
if (process.argv.includes('--check')) {
  const saved = JSON.parse(await readFile(target, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(saved.sourceCommit)) throw new Error('Invalid reference commit');
  execFileSync('git', ['merge-base', '--is-ancestor', saved.sourceCommit, 'HEAD'], {cwd: root});
  baseline.sourceCommit = saved.sourceCommit;
  if (JSON.stringify(saved) !== JSON.stringify(baseline)) throw new Error('Reference drift: review baseline before updating');
  console.log(`Reference matches: ${baseline.routes.length} routes, ${files.length} source hashes`);
} else {
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Recorded ${baseline.routes.length} routes from ${baseline.sourceCommit}`);
}
