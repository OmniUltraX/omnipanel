#!/usr/bin/env node
/** Unsigned local/CI Linux packages. Official updater signing stays in build.yml. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseOptions(args) {
  const options = { debug: false, bundles: 'deb,appimage' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--debug') options.debug = true;
    else if (args[i] === '--bundles') options.bundles = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!options.bundles || !options.bundles.split(',').every(b => ['deb', 'appimage', 'rpm'].includes(b))) {
    throw new Error('--bundles must be a comma-separated list of deb,appimage,rpm');
  }
  return options;
}

export function unsignedConfig(config) {
  return { ...config, bundle: { ...config.bundle, createUpdaterArtifacts: false } };
}

export function build(root, options) {
  if (process.platform !== 'linux') throw new Error('Run build:linux on Linux (not Windows cross-compilation).');
  const cli = path.join(root, 'frontend/node_modules/@tauri-apps/cli/tauri.js');
  if (!fs.existsSync(cli)) throw new Error('Install the frontend first: npm ci --prefix frontend');
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  };
  // Check native dependencies early, before spending time compiling Rust.
  run('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1', 'ayatana-appindicator3-0.1', 'libudev', 'openssl']);
  if (options.bundles.split(',').includes('appimage')) {
    run('dpkg-architecture', ['--version']);
    run('file', ['--version']);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnipanel-linux-'));
  const config = path.join(temp, 'tauri.json');
  try {
    run(process.execPath, ['scripts/stage-db-engines.mjs', ...(options.debug ? [] : ['--release']), '--conf-out', config]);
    fs.writeFileSync(config, `${JSON.stringify(unsignedConfig(JSON.parse(fs.readFileSync(config, 'utf8'))), null, 2)}\n`);
    run(process.execPath, [cli, 'build', '--config', config, '--bundles', options.bundles, ...(options.debug ? ['--debug'] : [])]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`build:linux: ${error.message}`);
    process.exitCode = 1;
  }
}
