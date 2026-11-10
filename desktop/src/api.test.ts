import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkServer, connect, normalizeServerURL, persistEvent, saveServer, savedEvents } from './api';
import type { PetEvent } from './types';

const values = new Map<string, string>();
const event: PetEvent = { id: 'message-1', type: 'message', kind: 'text', body: '커피?', createdAt: Date.now(), expiresAt: Date.now() + 60000 };
const sent: string[] = [];
let active: FakeSocket;

class FakeSocket {
  onopen?: () => void;
  onmessage?: (value: { data: string }) => void;
  onclose?: (event: { code: number }) => void;

  // 소켓 생성을 기록해 실제 프레임 처리 경계를 검증한다.
  constructor() {
    active = this;
  }

  // 클라이언트가 보낸 수신 확인 프레임을 수집한다.
  send(value: string): void {
    sent.push(value);
  }

  // 명시적인 테스트 연결 해제는 외부 자원을 사용하지 않는다.
  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

beforeEach(() => {
  values.clear();
  sent.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('WebSocket', FakeSocket);
  values.set('ourpets.session', JSON.stringify({ token: 'local-test-token', principal: { deviceId: 'device-a' } }));
});
afterEach(() => vi.unstubAllGlobals());

describe('기기별 중복 방지와 수신 확인', () => {
  it('중복 재전송은 다시 표시하지 않고 만료된 이벤트는 기록하지 않는다', () => {
    expect(persistEvent(event)).toBe(true);
    expect(persistEvent(event)).toBe(false);
    expect(persistEvent({ ...event, id: 'expired', expiresAt: Date.now() - 1 })).toBe(false);
    expect(savedEvents()).toEqual([]);
    expect([...values.values()].join('')).not.toContain(event.body);
  });
  it('동일 메시지도 다른 기기에는 독립적으로 중복을 판별한다', () => {
    persistEvent(event);
    values.set('ourpets.session', JSON.stringify({ token: 'local-test-token', principal: { deviceId: 'device-b' } }));
    expect(persistEvent(event)).toBe(true);
  });
  it('중복 색인 저장이 실패하면 표시와 ACK를 보내지 않는다', () => {
    const display = vi.fn();
    const stop = connect(display, vi.fn());
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('저장 공간 부족');
    });
    active.onmessage?.({ data: JSON.stringify(event) });
    expect(sent).toHaveLength(0);
    expect(display).not.toHaveBeenCalled();
    stop();
  });
  it('ID 기록 후 한 번만 표시하고 본문 보관함은 만들지 않는다', () => {
    const display = vi.fn();
    const stop = connect(display, vi.fn());
    active.onmessage?.({ data: JSON.stringify(event) });
    active.onmessage?.({ data: JSON.stringify(event) });
    expect(display).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(savedEvents()).toEqual([]);
    expect([...values.values()].join('')).not.toContain(event.body);
    stop();
  });
});


describe('최초 서버 연결 경계', () => {
  it('정상 주소를 정규화하고 인증정보·경로·쿼리가 섞인 주소를 거부한다', () => {
    expect(normalizeServerURL(' http://127.0.0.1:19377/ ')).toBe('http://127.0.0.1:19377');
    for (const value of ['잘못된 주소', 'file:///tmp/server', 'http://user:password@localhost:9377', 'http://localhost:9377/private', 'http://localhost:9377/?token=value']) {
      expect(() => normalizeServerURL(value)).toThrow();
    }
  });
  it('서버 확인에는 기존 토큰과 쿠키를 보내거나 저장한 주소를 바꾸지 않는다', async () => {
    values.set('ourpets.server', 'http://127.0.0.1:9377');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', service: 'our-pets' }) });
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await expect(checkServer('http://127.0.0.1:19377', signal)).resolves.toBe('http://127.0.0.1:19377');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19377/healthz', {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    });
    expect(values.get('ourpets.server')).toBe('http://127.0.0.1:9377');
    expect(values.get('ourpets.session')).toContain('local-test-token');
    saveServer('http://127.0.0.1:19377');
    expect(values.has('ourpets.session')).toBe(false);
  });
  it('다른 서비스나 실패 응답을 새 서버로 저장하지 않는다', async () => {
    values.set('ourpets.server', 'http://127.0.0.1:9377');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', service: 'another-service' }) }));
    await expect(checkServer('http://127.0.0.1:19377', new AbortController().signal)).rejects.toThrow('우리 펫 서버');
    expect(values.get('ourpets.server')).toBe('http://127.0.0.1:9377');
    expect(values.get('ourpets.session')).toContain('local-test-token');
  });
});
