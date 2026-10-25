'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { buildBasicAuth, extractCredentials } = require('../../src/main/apk/extract');

test('buildBasicAuth URL-encodes and base64s client id:secret', () => {
  // Known vector: "a b":"c/d" -> "a%20b:c%2Fd" -> base64
  const header = buildBasicAuth('a b', 'c/d');
  const expected = 'Basic ' + Buffer.from('a%20b:c%2Fd', 'utf8').toString('base64');
  assert.strictEqual(header, expected);
});

test('buildBasicAuth is stable for simple ascii', () => {
  const header = buildBasicAuth('client', 'secret');
  assert.strictEqual(header, 'Basic ' + Buffer.from('client:secret').toString('base64'));
});

test('extractCredentials rejects an empty input list', async () => {
  await assert.rejects(() => extractCredentials([]), /ning[úu]n APK/i);
});

test('extractCredentials fails clearly on a non-APK file', async () => {
  const tmp = require('node:os').tmpdir() + '/timbre-not-an-apk.bin';
  fs.writeFileSync(tmp, Buffer.from('not a zip'));
  await assert.rejects(() => extractCredentials([tmp]));
  fs.unlinkSync(tmp);
});

// Full integration against a real APK, only when one is provided. Set
// TIMBRE_TEST_APK to a base.apk path (optionally TIMBRE_TEST_SPLIT) to run it.
test('extractCredentials reads a real APK when TIMBRE_TEST_APK is set', async (t) => {
  const apk = process.env.TIMBRE_TEST_APK;
  if (!apk || !fs.existsSync(apk)) {
    t.skip('TIMBRE_TEST_APK no está definido');
    return;
  }
  const paths = [apk];
  if (process.env.TIMBRE_TEST_SPLIT && fs.existsSync(process.env.TIMBRE_TEST_SPLIT)) {
    paths.push(process.env.TIMBRE_TEST_SPLIT);
  }
  const creds = await extractCredentials(paths);
  assert.match(creds.firebase.apiKey, /^AIza[\w-]+$/);
  assert.match(creds.firebase.appId, /^1:\d+:android:[0-9a-f]+$/);
  assert.ok(creds.firebase.projectId.length > 0);
  assert.strictEqual(creds.firebase.messagingSenderId, creds.firebase.appId.split(':')[1]);
  assert.match(creds.fermax.authBasic, /^Basic [A-Za-z0-9+/=]+$/);
  assert.match(creds.fermax.authUrl, /^https:\/\/oauth-pro-duoxme\.fermax\.io/);
});
