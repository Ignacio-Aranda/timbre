'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStores, JsonFile } = require('../../src/main/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timbre-store-'));
}

test('JsonFile persists and reloads values', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  const a = new JsonFile(file, { count: 0 });
  a.set('count', 5);
  a.merge({ name: 'hi' });
  const b = new JsonFile(file, { count: 0 });
  assert.strictEqual(b.get('count'), 5);
  assert.strictEqual(b.get('name'), 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonFile falls back to defaults on a corrupt file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ not valid json');
  const a = new JsonFile(file, { ok: true });
  assert.strictEqual(a.get('ok'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createStores exposes settings defaults and empty credentials', () => {
  const dir = tmpDir();
  const { settings, credentials } = createStores(dir);
  assert.strictEqual(settings.get('ringForcesSound'), true);
  assert.strictEqual(credentials.get('firebase'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
