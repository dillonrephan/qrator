import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { parseDiscoveryInput, parseLength, readJson } from '../src/server.js';

test('parses track seeds and source URLs without mixing them', () => {
  const result = parseDiscoveryInput([
    'Sister Nancy - Bam Bam',
    'Freddie Gibbs - Andrea',
    'https://example.com/tracklist',
  ].join('\n'));

  assert.equal(result.seedType, '--tracks');
  assert.deepEqual(result.seeds, ['Sister Nancy - Bam Bam', 'Freddie Gibbs - Andrea']);
  assert.deepEqual(result.urls, ['https://example.com/tracklist']);
});

test('parses artist seeds', () => {
  const result = parseDiscoveryInput('Igorrr + Freddie Gibbs');
  assert.equal(result.seedType, '--artists');
  assert.deepEqual(result.seeds, ['Igorrr', 'Freddie Gibbs']);
});

test('accepts only whole playlist lengths in range', () => {
  assert.equal(parseLength(5), 5);
  assert.equal(parseLength('30'), 30);
  assert.equal(parseLength(60), 60);
  for (const value of [4, 61, 'nope', 10.5]) {
    assert.throws(() => parseLength(value), { message: /whole number from 5 to 60/ });
  }
});

test('reads valid JSON request bodies', async () => {
  const request = Readable.from([Buffer.from('{"query":"test"}')]);
  assert.deepEqual(await readJson(request), { query: 'test' });
});

test('rejects malformed and oversized JSON request bodies', async () => {
  await assert.rejects(readJson(Readable.from(['{'])), (error) => error.status === 400);
  await assert.rejects(readJson(Readable.from([Buffer.alloc(257 * 1024)])), (error) => error.status === 413);
});
