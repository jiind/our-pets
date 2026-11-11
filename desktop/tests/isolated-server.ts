import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

// 많은 계정·기기 시나리오는 보호 정책을 완화하지 않고 테스트마다 서버와 요청 한도를 분리한다.
export const test = base.extend<{ isolatedServer: string }>({
  isolatedServer: async ({}, use) => {
    // 1. 지정한 테스트 임시 경로에만 실행 파일과 데이터를 준비한다.
    const directory = await mkdtemp(path.join(tmpdir(), 'our-pets-devices-'));
    const binary = path.join(directory, process.platform === 'win32' ? 'our-pets.exe' : 'our-pets');
    const env = { ...process.env, GOCACHE: process.env.GOCACHE || path.join(tmpdir(), 'our-pets-go-cache') };
    const build = spawn('go', ['build', '-o', binary, './cmd/our-pets'], { cwd: repository, env, stdio: 'pipe' });
    let buildError = '';
    build.stderr.on('data', chunk => buildError += chunk.toString());
    await new Promise<void>((resolve, reject) => {
      build.once('error', reject);
      build.once('exit', code => code === 0 ? resolve() : reject(new Error(`테스트 서버 빌드 실패: ${buildError}`)));
    });
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

    // 2. 실제 인증·SQLite·WebSocket 서버를 사용하고 현재 테스트의 프로세스만 종료한다.
    const url = `http://127.0.0.1:${port}`;
    const server = spawn(binary, [], { cwd: repository, env: { ...env, OURPETS_BIND: `127.0.0.1:${port}`, OURPETS_DATA: path.join(directory, 'data'), OURPETS_INVITE: 'test-only-invite', OURPETS_SAMPLE_ENABLED: 'false' }, stdio: 'ignore' });
    try {
      await expect.poll(async () => fetch(`${url}/healthz`).then(response => response.ok).catch(() => false)).toBe(true);
      await use(url);
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
        server.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});
