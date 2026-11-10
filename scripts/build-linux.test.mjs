import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions, unsignedConfig } from './build-linux.mjs';

test('default builds deb and AppImage in release mode', () => {
  assert.deepEqual(parseOptions([]), { debug: false, bundles: 'deb,appimage' });
});
test('debug and individual bundle selection', () => {
  assert.deepEqual(parseOptions(['--debug', '--bundles', 'deb']), { debug: true, bundles: 'deb' });
});
test('reject unsupported arguments and missing/invalid bundle values', () => {
  for (const args of [['--unknown'], ['--bundles'], ['--bundles', 'msi'], ['--bundles', 'deb,']]) {
    assert.throws(() => parseOptions(args));
  }
});
test('unsigned override preserves sidecars, product and updater configuration without mutation', () => {
  const config = { productName: 'OmniPanel', bundle: { createUpdaterArtifacts: true, externalBin: ['binaries/engine'] }, plugins: { updater: { pubkey: 'public' } } };
  const unsigned = unsignedConfig(config);
  assert.equal(unsigned.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(unsigned.bundle.externalBin, config.bundle.externalBin);
  assert.deepEqual(unsigned.plugins, config.plugins);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
});
