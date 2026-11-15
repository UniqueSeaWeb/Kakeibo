// public/ の画面ファイルを Worker に同梱するためのモジュール（src/static.generated.js）を生成する
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
const OUT = new URL('../src/static.generated.js', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

async function walk(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

const files = {};
for (const file of (await walk(ROOT)).sort()) {
  const type = TYPES[extname(file)];
  if (!type) continue; // 対象外のファイルは配信しない
  const buf = await readFile(file);
  files[`/${relative(ROOT, file)}`] = {
    type,
    etag: `"${createHash('sha256').update(buf).digest('base64url').slice(0, 22)}"`,
    b64: buf.toString('base64')
  };
}
await writeFile(OUT, `// 自動生成ファイル（scripts/build-static.mjs）。直接編集しないでください\nexport default ${JSON.stringify(files)};\n`);
console.log(`static: ${Object.keys(files).length} files`);
