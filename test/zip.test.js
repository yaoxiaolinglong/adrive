'use strict';
const assert = require('node:assert');
const { createZip, readZip } = require('../lib/zip');

const entries = [
  { name: 'a.txt', data: Buffer.from('hello '.repeat(100)) },
  { name: '嵌套/路径/b.bin', data: Buffer.from([0, 1, 2, 3, 255, 254]) },
  { name: 'empty.txt', data: Buffer.alloc(0) },
];

const zip = createZip(entries);
const back = readZip(zip);
assert.strictEqual(back.length, entries.length);
for (const e of entries) {
  const got = back.find((x) => x.name === e.name);
  assert.ok(got, `missing ${e.name}`);
  assert.ok(got.data.equals(e.data), `content mismatch ${e.name}`);
}
console.log('zip roundtrip ok:', entries.length, 'entries,', zip.length, 'bytes');
