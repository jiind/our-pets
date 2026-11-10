import type { Design, Gathering, GatheringActivity, PetEvent, Session } from './types';

const sessionKey = 'ourpets.session';

// 저장된 로컬 세션을 읽고 손상된 값은 로그인 전 상태로 취급한다.
export function session(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(sessionKey) || 'null');
  } catch {
    return null;
  }
}

// 현재 설치의 서버 주소를 읽는다.
export function serverURL(): string {
  return localStorage.getItem('ourpets.server') || 'http://127.0.0.1:9377';
}

// 사용자 입력을 경로·자격증명이 없는 서버 주소로 정규화한다.
export function normalizeServerURL(value: string): string {
  // 1. 잘못된 입력에는 주소 원문을 포함하지 않는 안내를 반환한다.
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('http(s)://주소:포트 형식으로 입력하세요.');
  }

  // 2. 인증정보·쿼리·경로가 섞인 입력을 저장 전에 거절한다.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('http(s)://주소:포트 형식으로 입력하세요.');
  }
  return url.origin;
}

// 계정 정보를 보내지 않고 선택한 우리 펫 서버의 응답을 확인한다.
export async function checkServer(value: string, signal: AbortSignal): Promise<string> {
  // 1. 새 주소 확인에는 기존 서버의 토큰·쿠키를 전송하지 않는다.
  const origin = normalizeServerURL(value);
  const response = await fetch(`${origin}/healthz`, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal });

  // 2. 연결 실패나 다른 서비스의 응답을 저장하지 않는다.
  const health = response.ok ? await response.json().catch(() => null) : null;
  if (health?.status !== 'ok' || (health.service !== undefined && health.service !== 'our-pets')) {
    throw new Error('우리 펫 서버에 연결할 수 없어요. 주소와 서버 상태를 확인해 주세요.');
  }
  return origin;
}

// 확인한 주소를 저장하고 서버가 바뀌면 이전 서버의 세션을 지운다.
export function saveServer(value: string): void {
  // 1. 유효한 주소만 기존 서버와 비교한다.
  const origin = normalizeServerURL(value);
  if (origin !== serverURL()) {
    localStorage.removeItem(sessionKey);
  }

  // 2. 최초 연결을 마쳤다는 표시도 같은 주소 키로 유지한다.
  localStorage.setItem('ourpets.server', origin);
}

// 인증 토큰을 URL에 노출하지 않고 API를 호출한다.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 1. 등록된 서버와 현재 세션으로 요청을 구성한다.
  const headers = new Headers(init.headers);
  const current = session();
  if (current) {
    headers.set('Authorization', `Bearer ${current.token}`);
  }
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const result = await fetch(`${serverURL()}/api/v1${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });

  // 2. 서버 오류는 사용자용 설명으로 변환한다.
  if (!result.ok) {
    const error = await result.json().catch(() => ({ error: '서버에 연결할 수 없습니다.' }));
    throw new Error(error.error || `요청 실패 (${result.status})`);
  }
  return result.json() as Promise<T>;
}

// 계정과 기기 세션을 두 로컬 창이 공유하도록 보관한다.
export function saveSession(value: Session | null): void {
  if (value) {
    localStorage.setItem(sessionKey, JSON.stringify(value));
    localStorage.setItem(`ourpets.device.${serverURL()}`, value.principal.deviceId);
  } else {
    localStorage.removeItem(sessionKey);
  }
}

// 계정·서버·기기별 받은 이벤트의 저장 키를 만든다.
function inboxKey(): string {
  return `ourpets.inbox.${serverURL()}.${session()?.principal.deviceId || 'none'}`;
}

// 과거 본문 보관함은 제공하지 않는다.
export function savedEvents(): PetEvent[] {
  return [];
}

// 본문 없이 짧은 중복 ID 색인만 기록하고 지난 보관함 데이터를 제거한다.
export function persistEvent(event: PetEvent): boolean {
  // 1. 실시간 이벤트 ID만 남기고 기존 버전의 본문 보관함을 지운다.
  localStorage.removeItem(inboxKey());
  const now = Date.now();
  const seenKey = `${inboxKey()}.seen`;
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(localStorage.getItem(seenKey) || '{}');
  } catch {
    // 이전 색인이 손상됐으면 새로운 연결의 중복 방지를 다시 시작한다.
  }
  const duplicate = seen[event.id] !== undefined;
  if (duplicate || event.expiresAt <= now) {
    return false;
  }

  // 2. 만료된 메타데이터는 지우고 저장 실패 시 ACK를 보내지 않게 한다.
  for (const [id, expires] of Object.entries(seen)) {
    if (expires <= now) {
      delete seen[id];
    }
  }
  seen[event.id] = event.expiresAt;
  localStorage.setItem(seenKey, JSON.stringify(seen));
  return true;
}

// 기존 버전의 본문 보관함만 제거하고 토큰·디자인 캐시·중복 ID는 유지한다.
export function removeLegacyHistory(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('ourpets.inbox.') && !key.endsWith('.seen')) {
      localStorage.removeItem(key);
    }
  }
}

// IndexedDB에 PNG를 버전 ID별로 보관해 서버 재접속 때 같은 이미지를 다시 받지 않는다.
function imageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ourpets-designs', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('images');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 불변 디자인 버전의 PNG를 캐시에서 읽거나 인증하여 내려받는다.
export async function designImage(design: Design): Promise<string> {
  // 1. 서버·버전·내용 지문으로 캐시를 분리한다.
  const db = await imageDB();
  const key = `${serverURL()}/${design.id}/${design.imageHash}`;
  try {
    const cached = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (cached) {
      return URL.createObjectURL(cached);
    }

    // 2. 토큰을 헤더로 전달하고 성공한 PNG만 영속 캐시에 넣는다.
    const result = await fetch(`${serverURL()}/api/v1/designs/${design.id}/image`, {
      headers: { Authorization: `Bearer ${session()?.token || ''}` }, signal: AbortSignal.timeout(15000),
    });
    if (!result.ok) {
      throw new Error('펫 이미지를 내려받지 못했습니다.');
    }
    const blob = await result.blob();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return URL.createObjectURL(blob);
  } finally {
    db.close();
  }
}

// 단일 기기 연결을 재시도하며 수신 저장 후에만 앱 수신 확인을 보낸다.
export function connect(onEvent: (event: PetEvent) => void, onState: (state: string) => void, onGatherings: (groups: Gathering[]) => void = () => {}, onActivity: (event: GatheringActivity) => void = () => {}): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let readyTimer: ReturnType<typeof setTimeout>;
  let delay = 1000;

  // 현재 기기 세션으로 인증하고 연결 종료 시 제한된 간격으로 다시 연결한다.
  function open(): void {
    const current = session();
    if (!current || stopped) {
      return;
    }
    onState('연결 확인 중');
    const connection = new WebSocket(`${serverURL().replace(/^http/, 'ws')}/api/v1/ws`);
    socket = connection;
    readyTimer = setTimeout(() => connection.close(), 10000);
    connection.onopen = () => {
      if (!stopped && socket === connection) {
        connection.send(JSON.stringify({ type: 'auth', token: current.token }));
      }
    };
    connection.onmessage = message => {
      if (stopped || socket !== connection) {
        return;
      }
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'ready') {
          clearTimeout(readyTimer);
          delay = 1000;
          onState('연결됨');
          return;
        }
        if (event.type === 'gatherings') {
          onGatherings(event.gatherings);
          return;
        }
        if (event.type === 'gathering_activity') {
          onActivity(event);
          return;
        }
        if (!event.id || !['message', 'notification'].includes(event.type)) {
          return;
        }
        if (persistEvent(event)) {
          onEvent(event);
        }
        connection.send(JSON.stringify({ type: 'ack', id: event.id }));
      } catch {
        onState('실시간 수신을 확인해 주세요');
      }
    };
    connection.onclose = event => {
      if (stopped || socket !== connection) {
        return;
      }
      clearTimeout(readyTimer);
      if (event.code === 1008) {
        onState('세션이 만료되었거나 같은 기기에서 연결했습니다. 다시 로그인하세요.');
        return;
      }
      onState('재연결 중');
      timer = setTimeout(open, delay + Math.random() * 300);
      delay = Math.min(delay * 2, 30000);
    };
    connection.onerror = () => {
      if (!stopped && socket === connection) {
        onState('서버 연결 확인 중');
      }
    };
  }
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(readyTimer);
    socket?.close();
  };
}
