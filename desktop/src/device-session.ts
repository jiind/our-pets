import { ApiError, api } from './api';
import { t } from './i18n';
import type { Session } from './types';

const keyPrefix = 'ourpets.device-key.';
const pendingPrefix = 'pending:';

// 서버마다 별도로 저장한 기기 키만 다시 사용한다.
export function deviceKey(origin: string): string | undefined {
  const stored = localStorage.getItem(keyPrefix + origin);
  const saved = stored?.startsWith(pendingPrefix) ? stored.slice(pendingPrefix.length) : stored;
  return saved && /^[a-f0-9]{64}$/u.test(saved) ? saved : undefined;
}

// 새 가입의 응답을 받지 못해도 같은 키로 재시도할 수 있게 먼저 저장한다.
function createKey(origin: string): string {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(keyPrefix + origin, pendingPrefix + key);
  return key;
}

function confirmKey(origin: string, key: string): void {
  if (localStorage.getItem(keyPrefix + origin) === pendingPrefix + key) {
    localStorage.setItem(keyPrefix + origin, key);
  }
}

// 계정 삭제 뒤 이전 기기의 키를 제거한다.
export function forgetDevice(origin: string): void {
  localStorage.removeItem(keyPrefix + origin);
}

// 키와 가입 코드는 확인한 원래 서버에만 전송한다.
async function access(origin: string, key: string, displayName = '', invite = '', signal?: AbortSignal): Promise<Session> {
  try {
    const login = await api<Session>('/device/session', {
      method: 'POST', redirect: 'error', signal,
      body: JSON.stringify({ key, displayName, invite, deviceName: navigator.platform }),
    }, origin);
    confirmKey(origin, key);
    return login;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      throw new Error(t('기기 인증을 사용하려면 연결할 우리 펫 서버를 업데이트해 주세요.'));
    }
    throw error;
  }
}

// 처음 참여한 닉네임과 기기를 기존 펫 등록 흐름에 연결한다.
export function joinDevice(origin: string, displayName: string, invite: string): Promise<Session> {
  return access(origin, deviceKey(origin) || createKey(origin), displayName, invite);
}

// 초대 코드 없이 이미 등록한 기기의 같은 계정에 세션을 다시 발급받는다.
export async function restoreDevice(origin: string, signal?: AbortSignal): Promise<Session | undefined> {
  const key = deviceKey(origin);
  if (!key) {
    return undefined;
  }
  try {
    return await access(origin, key, '', '', signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return undefined;
    }
    throw error;
  }
}

// 아직 만료되지 않은 기존 세션을 같은 계정의 기기 키에 연결한다.
export async function rememberDevice(origin: string): Promise<string> {
  const key = deviceKey(origin) || createKey(origin);
  if (localStorage.getItem(keyPrefix + origin) === pendingPrefix + key) {
    // 응답이 유실돼도 서버가 등록한 키를 그대로 재시도한다.
    await api('/me/device-key', { method: 'PUT', redirect: 'error', body: JSON.stringify({ key }) }, origin);
    confirmKey(origin, key);
  }
  return key;
}
