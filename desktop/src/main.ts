import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { api, checkServer, removeLegacyHistory, saveServer, saveSession, serverURL, session } from './api';
import { mountPet } from './pet';
import { icon } from './icons';
import { viewMotion } from './motion';
import { drawPet } from './render';
import type { RegisteredPet, Session } from './types';
import './style.css';
import './workspace.css';
import './ui.css';
import { mountPetRegistration } from './pet-registration';
import { mountLocalConnectors } from './local-connectors';
import { mountSidebar } from './sidebar';
import { mountAccountSettings } from './account-settings';
import { mountSystemNotificationToggle } from './system-notifications';
import { connectedAlertsMuted, setConnectedAlertsMuted } from './notification-preferences';

const app = document.querySelector<HTMLElement>('#app')!;
let view = 'studio';
let connectionState = '';
let viewGeneration = 0;
let disposeViewMotion: (() => void) | undefined;
let registrationCleanup: (() => void) | undefined;
let connectionCleanup: (() => void) | undefined;
let accountCleanup: (() => void) | undefined;
let ownPet: RegisteredPet | undefined;
let sidebarCleanup: (() => void) | undefined;
let serverAttempt: AbortController | undefined;

// 사용자 입력을 HTML로 해석하지 않고 텍스트로 삽입할 수 있게 변환한다.
function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

// 작업 상태를 접근 가능한 공통 안내 영역에 표시한다.
function notice(message: string, error = false): void {
  const target = document.querySelector<HTMLElement>('#notice');
  if (target) {
    target.textContent = message;
    target.classList.toggle('error', error);
  }
}

// 비동기 폼 동작의 오류를 화면에서 확인할 수 있게 처리한다.
function run(task: () => Promise<void>): void {
  const pending = task();
  const generation = viewGeneration;
  void pending.catch(error => {
    if (generation === viewGeneration) {
      notice(error instanceof Error ? error.message : '작업에 실패했습니다.', true);
    }
  });
}

// 실제 수신 연결 상태를 서버 표시등과 필요한 복구 안내에 함께 반영한다.
function showConnectionProblem(state: string): void {
  // 1. 표시등은 항상 갱신하고 복구 안내는 로그인한 화면에서만 처리한다.
  connectionState = state;
  showServerStatus(state);
  const target = document.querySelector<HTMLElement>('#connection-problem');
  if (!target) {
    return;
  }
  if (ownPet?.registered === false) {
    target.hidden = true;
    return;
  }
  if (target.dataset.state === state) {
    return;
  }
  target.dataset.state = state;
  target.hidden = !state || state === '연결됨' || state === '연결 확인 중';
  target.replaceChildren();
  if (target.hidden) {
    return;
  }

  // 2. 실시간으로만 표시되는 정책과 현재 상태에 맞는 복구 방법을 안내한다.
  const expired = state.includes('세션') || state.includes('로그인');
  const message = document.createElement('p');
  message.textContent = expired ? '기기 연결을 다시 확인해야 해요. 로그인하면 실시간 소식을 다시 받을 수 있어요.' : '실시간 소식이 잠시 연결되지 않았어요. 자동으로 다시 연결하며, 연결이 끊긴 동안의 소식은 나중에 표시하지 않아요.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = expired ? '다시 로그인' : '다시 연결';
  button.onclick = () => run(async () => {
    button.disabled = true;
    try {
      if (expired) {
        saveSession(null);
        await changed();
        showLogin();
      } else if (isTauri()) {
        await emit('retry-pet-connection');
      } else {
        window.dispatchEvent(new CustomEvent('retry-pet-connection'));
      }
    } finally {
      button.disabled = false;
    }
  });
  target.append(message, button);
}

// 대표 펫의 실제 실시간 연결 상태를 색과 접근성 설명으로 표시한다.
function showServerStatus(state = connectionState): void {
  // 1. 설정 화면에만 표시하고 등록 전에는 연결 성공으로 표시하지 않는다.
  const led = document.querySelector<HTMLElement>('.sidebar-server-led');
  if (!led) {
    return;
  }
  const status = ownPet?.registered === false ? 'idle' : state === '연결됨' ? 'connected' : !state || state.includes('확인 중') || state === '재연결 중' ? 'connecting' : 'disconnected';
  const description = status === 'idle' ? '펫 등록 후 실시간 연결' : status === 'connected' ? '실시간 연결됨' : state || '실시간 연결 확인 중';

  // 2. 색만으로 상태를 구분하지 않도록 같은 설명을 도움말과 접근성 이름에 넣는다.
  led.dataset.state = status;
  led.title = description;
  led.setAttribute('aria-label', description);
}

// 같은 서버와 기기가 방금 남긴 연결 상태만 복원한다.
function storedConnectionState(): string {
  try {
    // 1. 비밀값이 없는 마지막 연결 상태만 읽는다.
    const value = JSON.parse(localStorage.getItem('ourpets.connection') || 'null');

    // 2. 서버·기기와 짧은 유효시간이 맞는 상태만 사용한다.
    return value && value.server === serverURL() && value.deviceId === session()?.principal.deviceId && Date.now() - value.at >= 0 && Date.now() - value.at < 30000 ? String(value.state) : '';
  } catch {
    return '';
  }
}

// 로컬 창들에 로그인·디자인 변경을 알린다.
async function changed(): Promise<void> {
  if (isTauri()) {
    await emit('session-changed');
  }
}

// 로컬망 서버와 로컬 계정으로 접속하는 화면을 표시한다.
function showLogin(register = false, chooseServer = false): void {
  // 1. 현재 화면의 연결과 미리보기 리소스를 해제한다.
  serverAttempt?.abort();
  serverAttempt = undefined;
  viewGeneration += 1;
  ownPet = undefined;
  if (isTauri()) {
    void invoke('set_pet_registered', { registered: false }).catch(console.error);
  }
  view = 'studio';
  connectionState = '';
  sidebarCleanup?.();
  sidebarCleanup = undefined;
  disposeViewMotion?.();
  disposeViewMotion = undefined;
  registrationCleanup?.();
  registrationCleanup = undefined;
  connectionCleanup?.();
  connectionCleanup = undefined;
  accountCleanup?.();
  accountCleanup = undefined;
  app.className = 'login-shell';
  const needsServer = chooseServer || !localStorage.getItem('ourpets.server');
  const title = needsServer ? '함께할 서버에 연결하기' : register ? '우리 펫에 합류하기' : '오늘도 만나서 반가워요';
  const description = needsServer ? '먼저 사용할 서버를 연결해 주세요.' : register ? '사용할 계정을 만들어 주세요.' : '';
  const serverFields = `<label>서버 주소<input name="server" type="url" value="${escape(serverURL())}" placeholder="http://192.168.0.10:9377" required></label><button type="submit" class="primary">서버 연결</button>`;
  const accountFields = `${register ? '<label>닉네임<input name="displayName" maxlength="80" autocomplete="nickname" required></label>' : ''}<label>아이디<input name="username" autocomplete="username" minlength="3" maxlength="32" required></label><div class="auth-password-field"><label for="auth-password">비밀번호</label><div class="auth-password-input"><input id="auth-password" name="password" type="password" minlength="10" maxlength="256" autocomplete="${register ? 'new-password' : 'current-password'}" spellcheck="false" autocapitalize="off" required><button type="button" class="password-visibility" aria-label="비밀번호 보기" title="비밀번호 보기" aria-controls="auth-password" aria-pressed="false">${icon('eye')}</button></div></div>${register ? '<label>서버 가입 코드<input name="invite" type="password" autocomplete="off" required></label>' : ''}<button type="submit" class="primary">${register ? '계정 만들고 펫 등록하기' : '접속하기'} <span>↗</span></button>`;
  app.innerHTML = `<section class="login-art"><span class="brand"><img src="/favicon.svg" alt="">우리 펫</span><div class="login-copy"><h1>각자의 화면에서,<br>함께 노는 우리 펫.</h1><p>내 데스크톱에 작은 친구를 데려오세요.<br>친구에게 보내는 메시지도, 반가운 인사도 펫과 함께.</p><div id="login-pet"></div></div><small>같은 네트워크에서 친구와 실시간으로 만나요.</small></section>
  <section class="login-form"><h2>${title}</h2>${description ? `<p class="muted">${description}</p>` : ''}
  ${needsServer ? '' : `<div class="auth-server"><span title="${escape(serverURL())}">${escape(serverURL())}</span><a class="auth-server-change" href="#server">서버 변경</a></div>`}
  <form id="auth">${needsServer ? serverFields : accountFields}</form><p id="notice" role="status" aria-live="polite"></p>
  ${needsServer ? (localStorage.getItem('ourpets.server') ? '<a id="back-to-auth" class="auth-switch" href="#login">돌아가기</a>' : '') : `<a id="switch-auth" class="auth-switch" href="${register ? '#login' : '#create-account'}">${register ? '로그인' : '계정 만들기'}</a>`}</section>`;
  const loginCanvas = document.createElement('canvas');
  loginCanvas.width = loginCanvas.height = 180;
  document.querySelector('#login-pet')!.append(loginCanvas);
  drawPet(loginCanvas, null, null, 'idle', 0);
  const switchAuth = document.querySelector<HTMLAnchorElement>('#switch-auth');
  if (switchAuth) {
    switchAuth.onclick = event => {
      event.preventDefault();
      showLogin(!register);
    };
  }
  const changeServer = document.querySelector<HTMLAnchorElement>('.auth-server-change');
  if (changeServer) {
    changeServer.onclick = event => {
      event.preventDefault();
      showLogin(register, true);
    };
  }
  const back = document.querySelector<HTMLAnchorElement>('#back-to-auth');
  if (back) {
    back.onclick = event => {
      event.preventDefault();
      showLogin(register);
    };
  }

  // 2. 서버 확인이 끝난 뒤에만 계정 정보를 입력하고 전송한다.
  const form = document.querySelector<HTMLFormElement>('#auth')!;
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const password = form.querySelector<HTMLInputElement>('[name=password]');
  const visibility = form.querySelector<HTMLButtonElement>('.password-visibility');
  if (password && visibility) {
    visibility.onclick = () => {
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      visibility.innerHTML = icon(visible ? 'eye-off' : 'eye');
      visibility.setAttribute('aria-pressed', String(visible));
      const description = visible ? '비밀번호 숨기기' : '비밀번호 보기';
      visibility.setAttribute('aria-label', description);
      visibility.title = description;
    };
  }
  if (register && !needsServer) {
    form.querySelector<HTMLInputElement>('[name=displayName]')!.focus({ preventScroll: true });
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) {
      return;
    }
    const generation = viewGeneration;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    notice('');
    run(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (needsServer) {
          // 1. 인증 없는 연결 확인이 성공하기 전에는 저장한 서버를 바꾸지 않는다.
          const attempt = new AbortController();
          serverAttempt = attempt;
          timeout = setTimeout(() => attempt.abort(), 8000);
          submit.textContent = '연결 확인 중…';
          let origin: string;
          try {
            origin = await checkServer(String(new FormData(form).get('server')), attempt.signal);
          } catch (error) {
            if (generation !== viewGeneration) {
              return;
            }
            throw new Error(error instanceof Error && /형식/.test(error.message) ? error.message : '서버에 연결할 수 없어요. 주소·서버 실행 상태·접속 허용 범위를 확인해 주세요.');
          }
          if (generation !== viewGeneration || !form.isConnected) {
            return;
          }
          saveServer(origin);
          await changed();
          if (generation === viewGeneration && form.isConnected) {
            showLogin(register);
            document.querySelector<HTMLInputElement>(register ? '[name=displayName]' : '[name=username]')?.focus();
          }
          return;
        }

        // 2. 계정 요청 도중 화면이나 서버가 바뀌면 늦은 응답으로 로그인하지 않는다.
        const origin = serverURL();
        const body = Object.fromEntries(new FormData(form).entries());
        const login = await api<Session>(register ? '/register' : '/login', {
          method: 'POST', body: JSON.stringify({ ...body, deviceId: localStorage.getItem(`ourpets.device.${origin}`) || '', deviceName: navigator.platform }),
        });
        if (generation !== viewGeneration || !form.isConnected || origin !== serverURL()) {
          return;
        }
        saveSession(login);
        await changed();
        if (isTauri()) {
          await invoke('pet_control', { action: 'restore' });
        }
        await showHome();
      } finally {
        clearTimeout(timeout);
        if (generation === viewGeneration && form.isConnected) {
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          if (needsServer) {
            submit.textContent = '서버 연결';
          }
        }
      }
    });
  };
}

// 로그인한 사용자의 펫과 로컬망 친구를 보여주는 기본 화면을 구성한다.
async function showHome(): Promise<void> {
  // 1. 공통 탐색과 펫 제어를 준비한다.
  if (!session()) {
    showLogin();
    return;
  }
  sidebarCleanup?.();
  sidebarCleanup = undefined;
  registrationCleanup?.();
  registrationCleanup = undefined;
  connectionCleanup?.();
  connectionCleanup = undefined;
  accountCleanup?.();
  accountCleanup = undefined;
  app.className = 'workspace';
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="#" aria-label="우리 펫"><img src="/favicon.svg" alt=""><span>우리 펫</span></a><nav aria-label="주 메뉴"><div class="sidebar-server" role="group" aria-label="서버 정보"><span class="sidebar-server-led" role="img" data-state="connecting" aria-label="실시간 연결 확인 중" title="실시간 연결 확인 중"></span><span class="sidebar-server-address fine" title="${escape(serverURL())}">${escape(serverURL())}</span></div><button data-view="studio" title="펫" aria-label="펫">${icon('paw')} <span>펫</span></button><button data-view="connections" title="알림" aria-label="알림">${icon('bell')} <span>알림</span></button><button data-view="account" title="계정" aria-label="계정">${icon('account')} <span>계정</span></button></nav><div class="sidebar-bottom"><button id="logout" class="quiet" title="로그아웃" aria-label="로그아웃">${icon('logout')}<span>로그아웃</span></button><small class="sidebar-copyright">© ${new Date().getFullYear()} 우리 펫</small></div></aside>
  <main class="content" id="main-content" tabindex="-1"><header><div><h1 id="page-title">펫</h1></div><div class="page-actions" id="page-actions"></div></header><p id="notice" role="status"></p><section id="connection-problem" class="connection-problem" role="status" hidden></section><div id="view"></div></main>`;
  sidebarCleanup = mountSidebar(app);
  showServerStatus();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
    button.onclick = () => {
      view = button.dataset.view!;
      run(async () => {
        await renderView();
        const heading = document.querySelector<HTMLElement>('#page-title')!;
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      });
    };
  });
  document.querySelector<HTMLButtonElement>('#logout')!.onclick = () => run(async () => {
    try {
      await api('/logout', { method: 'POST' });
    } catch {
      // 만료되거나 서버가 끊긴 세션도 로컬에서 종료할 수 있게 한다.
    }
    saveSession(null);
    await changed();
    if (isTauri()) {
      // 로그아웃은 등록 상태만 해제하고 사용자가 고른 표시 설정은 보존한다.
      await invoke('set_pet_registered', { registered: false });
    }
    showLogin();
  });
  await refreshOwnPet();
  showConnectionProblem(storedConnectionState() || connectionState);

  // 2. 실제 펫 창이 실시간 연결을 담당하고 설정에는 선택한 본문만 표시한다.
  await renderView();
}

// 내 펫의 등록 상태와 이름을 최신 상태로 갱신한다.
async function refreshOwnPet(): Promise<void> {
  // 1. 같은 계정의 대표 펫 등록 상태를 읽는다.
  const current = session();
  if (!current) {
    return;
  }
  const account = `${serverURL()}/${current.token}`;
  const own = await api<RegisteredPet>('/me/pet');
  if (account !== `${serverURL()}/${session()?.token}`) {
    return;
  }
  ownPet = own;
  showServerStatus();
  saveSession({ ...current, principal: { ...current.principal, petRegistered: own.registered } });

  // 2. 등록 전에는 실제 펫 창을 숨기되 기존 표시 설정은 유지한다.
  if (isTauri()) {
    await invoke('set_pet_registered', { registered: own.registered });
  }
  document.querySelectorAll<HTMLButtonElement>('#connected-alerts-toggle').forEach(button => {
    button.disabled = !own.registered;
  });
}

// 선택한 기능 화면을 표시하고 이동 전 미리보기 타이머를 해제한다.
async function renderView(): Promise<void> {
  // 1. 이전 화면의 효과를 정리하고 최신 전환만 새 효과를 시작할 수 있게 한다.
  const generation = ++viewGeneration;
  notice('');
  document.querySelector('#page-actions')!.replaceChildren();
  document.querySelector<HTMLElement>('#main-content')!.scrollTop = 0;
  disposeViewMotion?.();
  disposeViewMotion = undefined;
  registrationCleanup?.();
  registrationCleanup = undefined;
  connectionCleanup?.();
  connectionCleanup = undefined;
  accountCleanup?.();
  accountCleanup = undefined;
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => {
    if (button.dataset.view === view) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  const titles: Record<string, string> = { studio: '펫', connections: '알림', account: '계정' };
  document.querySelector('#page-title')!.textContent = titles[view];
  if (view === 'studio') {
    await renderStudio();

  } else if (view === 'account') {
    const target = document.querySelector<HTMLElement>('#view')!;
    const cleanup = await mountAccountSettings(target, async () => {
      await changed();
      await refreshOwnPet();
    }, async pendingFileCleanup => {
      localStorage.removeItem(`ourpets.device.${serverURL()}`);
      saveSession(null);
      try {
        await changed();
        if (isTauri()) {
          await invoke('set_pet_registered', { registered: false });
        }
      } finally {
        showLogin();
        notice(pendingFileCleanup ? '계정은 삭제됐어요. 일부 PNG 파일 정리가 지연되어 서버 운영자 확인이 필요합니다.' : '계정을 삭제했어요.');
      }
    });
    if (generation !== viewGeneration || view !== 'account') {
      cleanup();
    } else {
      accountCleanup = cleanup;
    }
  } else {
    await renderConnections();
  }

  // 2. 콘텐츠와 키보드 입력은 즉시 사용 가능하며 표시 효과만 짧게 재생한다.
  const target = document.querySelector<HTMLElement>('#view');
  if (generation === viewGeneration && target) {
    disposeViewMotion = viewMotion(target);
  }
}

// 실제 등록 단계와 등록된 대표 펫의 관리를 같은 화면에서 분리한다.
async function renderStudio(): Promise<void> {
  // 1. 현재 화면에 등록 폼을 연결하고 등록 완료 상태를 창 사이에 공유한다.
  const target = document.querySelector<HTMLElement>('#view')!;
  const generation = viewGeneration;
  const cleanup = await mountPetRegistration(target, {
    onRegistered: async () => {
      await changed();
      await refreshOwnPet();
    },
  });

  // 2. 기다리는 동안 화면이 바뀌면 새 화면에 이전 미리보기를 남기지 않는다.
  if (generation !== viewGeneration || !target.isConnected || view !== 'studio') {
    cleanup();
  } else {
    registrationCleanup = cleanup;
  }
}

// 알림 표시 제어와 개인 PC의 외부 연결을 같은 화면에서 관리한다.
async function renderConnections(): Promise<void> {
  // 1. 연결된 외부 알림만 끄는 버튼을 OS 전체 알림 설정과 구분해 제공한다.
  const controls = document.createElement('div');
  controls.className = 'notification-controls';
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.id = 'connected-alerts-toggle';
  pause.disabled = !ownPet?.registered;
  const paused = connectedAlertsMuted();
  pause.textContent = paused ? '연결된 알람 켜기' : '연결된 알람 끄기';
  pause.title = 'Docker·Slack 등 연결한 알림의 말풍선과 OS 알림을 켜거나 꺼요.';
  pause.setAttribute('aria-pressed', String(!paused));
  pause.onclick = () => {
    const next = !connectedAlertsMuted();
    setConnectedAlertsMuted(next);
    pause.textContent = next ? '연결된 알람 켜기' : '연결된 알람 끄기';
    pause.setAttribute('aria-pressed', String(!next));
    notice(next ? '연결된 알람을 껐어요. 사용자 메시지와 모집 소식은 계속 받아요.' : '연결된 알람을 켰어요. 새로 도착하는 알림부터 표시해요.');
  };
  controls.append(pause);
  mountSystemNotificationToggle(controls, message => notice(message, true));
  document.querySelector('#page-actions')!.replaceChildren(controls);
  const personal = document.createElement('section');
  document.querySelector('#view')!.replaceChildren(personal);

  // 2. 개인 연결만 읽고 화면이 바뀌면 이전 화면의 수신기를 정리한다.
  const generation = viewGeneration;
  const cleanup = await mountLocalConnectors(personal);
  if (view !== 'connections' || !personal.isConnected || generation !== viewGeneration) {
    cleanup();
    return;
  }
  connectionCleanup = cleanup;
}

// 창 역할에 따라 실제 투명 펫 또는 설정 UI를 시작한다.
async function main(): Promise<void> {
  // 1. 과거 본문 기록을 지우고 펫 창은 설정 UI와 키보드 포커스를 공유하지 않는다.
  removeLegacyHistory();
  if (location.search.includes('pet')) {
    document.body.classList.add('native-pet');
    document.documentElement.classList.add('pet-root');
    await mountPet(app, false, new URLSearchParams(location.search).get('target') || undefined);
    return;
  }

  // 2. 사용자 동작과 수신 상태를 창 사이에서 전달한다.
  connectionState = storedConnectionState();
  window.addEventListener('connection-state', event => showConnectionProblem(String((event as CustomEvent).detail)));
  if (isTauri()) {
    await listen<string>('connection-state', event => showConnectionProblem(event.payload));
    await listen('request-sign-in', () => run(async () => {
      saveSession(null);
      await changed();
      showLogin();
      document.querySelector<HTMLInputElement>('[name=username]')?.focus();
    }));
  }
  if (session() && session()!.principal.expiresAt > Date.now()) {
    await showHome();
    if (isTauri()) {
      await invoke('pet_control', { action: 'restore' });
    }
  } else {
    saveSession(null);
    showLogin();
  }
}
void main().catch(error => notice(error.message, true));
