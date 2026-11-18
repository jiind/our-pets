import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'desktop', 'src-tauri', 'binaries');
const platforms = {
  'x86_64-unknown-linux-gnu': ['linux', 'amd64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
  'x86_64-pc-windows-msvc': ['windows', 'amd64'],
  'aarch64-pc-windows-msvc': ['windows', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'amd64'],
  'aarch64-apple-darwin': ['darwin', 'arm64'],
};
const hostTarget = {
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
};
const target = process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget[process.platform]?.[process.arch];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function build(triple) {
  const platform = platforms[triple];
  if (!platform) throw new Error(`Unsupported desktop host target: ${triple}`);
  const [GOOS, GOARCH] = platform;
  const binary = join(output, `our-pets-host-${triple}${GOOS === 'windows' ? '.exe' : ''}`);
  run('go', ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', binary, './cmd/our-pets'], {
    ...process.env, GOOS, GOARCH, CGO_ENABLED: '0',
  });
  return binary;
}

mkdirSync(output, { recursive: true });
if (target === 'universal-apple-darwin') {
  const intel = build('x86_64-apple-darwin');
  const apple = build('aarch64-apple-darwin');
  run('lipo', ['-create', intel, apple, '-output', join(output, `our-pets-host-${target}`)]);
} else {
  build(target);
}
