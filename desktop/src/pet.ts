import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, connect, designImage, serverURL, session } from './api';
import { drawPet, loadImage, petAnchors, petVisualWidth } from './render';
import { playPair, type PairReaction } from './pair';
import { icon } from './icons';
import { petMotion, type Gesture } from './motion';
import { watchDisplay } from './preferences';
import { mountPetComposer } from './pet-compose';
import { mountMenuMessage } from './pet-menu-message';
import { mountBubblePages } from './pet-bubble';
import { setPetInput } from './pet-input';
import { mountRecruitment } from './recruitment';
import { recruitmentOptions, type Design, type Gathering, type Pet, type PetEvent, type RegisteredPet } from './types';
import { externalNotificationTitle, notifyReceivedMessage, notifyGatheringActivity } from './system-notifications';
import { connectedAlertsMuted } from './notification-preferences';
import { animationKey, randomClickAnimation } from './pet-animations';

type Rect = { x: number; y: number; width: number; height: number };

// 투명 픽셀을 건너뛰는 입력 영역을 실제 Canvas와 현재 메뉴에서 계산한다.
export function hitRegions(canvas: HTMLCanvasElement, root: HTMLElement): Rect[] {
  // 1. 알파 채널의 연속된 구간을 논리 좌표 사각형으로 묶는다.
  const regions: Rect[] = [];
  const pixels = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  const bounds = canvas.getBoundingClientRect();
  const origin = root.getBoundingClientRect();
  const transform = getComputedStyle(canvas).transform;
  const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => matrix.transformPoint(new DOMPoint(x, y)));
  const minimumX = Math.min(...corners.map(point => point.x));
  const minimumY = Math.min(...corners.map(point => point.y));

  // 회전·확대된 Canvas의 불투명 구간을 실제 화면의 입력 사각형으로 변환한다.
  function pixelRegion(start: number, end: number, row: number, thickness: number): Rect {
    const points = [[start, row], [end, row], [end, row + thickness], [start, row + thickness]].map(([x, y]) => matrix.transformPoint(new DOMPoint(x * width / canvas.width, y * height / canvas.height)));
    const left = Math.floor(bounds.x - origin.x + Math.min(...points.map(point => point.x)) - minimumX);
    const top = Math.floor(bounds.y - origin.y + Math.min(...points.map(point => point.y)) - minimumY);
    const right = Math.ceil(bounds.x - origin.x + Math.max(...points.map(point => point.x)) - minimumX);
    const bottom = Math.ceil(bounds.y - origin.y + Math.max(...points.map(point => point.y)) - minimumY);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  const step = 3;
  for (let y = 0; y < canvas.height; y += step) {
    let start = -1;
    for (let x = 0; x <= canvas.width; x++) {
      const alpha = x < canvas.width && pixels[(y * canvas.width + x) * 4 + 3] > 20;
      if (alpha && start < 0) {
        start = x;
      }
      if (!alpha && start >= 0) {
        regions.push(pixelRegion(start, x, y, Math.min(step, canvas.height - y)));
        start = -1;
      }
    }
  }

  // 복잡한 사용자 픽셀 그림도 네이티브 입력 영역 개수 제한 안에 묶는다.
  if (regions.length > 4000) {
    regions.length = 0;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        let opaque = false;
        for (let dy = 0; dy < 4 && y + dy < canvas.height && !opaque; dy++) {
          for (let dx = 0; dx < 4 && x + dx < canvas.width; dx++) {
            if (pixels[((y + dy) * canvas.width + x + dx) * 4 + 3] > 20) {
              opaque = true;
              break;
            }
          }
        }
        if (opaque) {
          regions.push(pixelRegion(x, Math.min(x + 4, canvas.width), y, Math.min(4, canvas.height - y)));
        }
      }
    }
  }

  // 2. 보이는 메뉴와 말풍선만 추가해 빈 주변 공간은 계속 통과시킨다.
  root.querySelectorAll<HTMLElement>('[data-hit]').forEach(element => {
    if (element.hidden || !element.getClientRects().length) {
      return;
    }
    const r = element.getBoundingClientRect();
    regions.push({ x: Math.floor(r.x - origin.x), y: Math.floor(r.y - origin.y), width: Math.ceil(r.width), height: Math.ceil(r.height) });
  });
  return regions;
}

// 데스크톱 펫과 동일한 메뉴·수신 카드를 브라우저 검증에서도 구동한다.
export async function mountPet(root: HTMLElement, preview = false, targetID?: string): Promise<() => void> {
  // 1. 펫 위 메뉴와 공통 수신 카드를 구성한다.
  const ownWindow = isTauri() ? getCurrentWindow() : undefined;
  root.classList.add('pet-stage');
  root.hidden = !targetID;
  root.innerHTML = `<div class="pet-menu" data-hit hidden aria-label="펫 동작 메뉴">
    <div class="pet-menu-heading"><span class="pet-menu-title">무엇을 할까요?</span><button data-action="close" class="menu-close" aria-label="펫 메뉴 닫기">${icon('close')}</button></div>
    <div class="pet-menu-body">
    <p class="pet-menu-status" hidden></p>

    <div class="pet-menu-group" aria-label="함께하기"><button data-action="recruit" aria-label="모집 종류 선택"><span data-recruit-icon aria-hidden="true">🚩</span><span data-recruit-label>모집</span></button></div>
    <div class="pet-menu-row" aria-label="펫과 상호작용" hidden><button data-action="highfive" hidden>🙌 하이파이브</button><button data-action="wave" hidden>👋 인사하기</button></div>
    <button data-action="gathering" hidden>함께하기 상태 보기</button>
    <form class="pet-menu-message"><input name="body" type="text" maxlength="2000" required autocomplete="off" aria-label="전체 펫에게 보낼 메시지" placeholder="모두에게 메시지"><button type="submit" class="primary">전송</button><p class="pet-menu-message-feedback" role="status" aria-live="polite" hidden></p></form>
    </div>
  </div>
  <article class="pet-bubble" data-hit hidden tabindex="-1" aria-label="현재 도착한 소식" aria-live="polite">
    <div class="bubble-heading"><button class="bubble-close" aria-label="알림 닫기">${icon('close')}</button><div class="bubble-sender"></div></div>
    <div class="pet-bubble-content"><p></p><p class="bubble-state"></p><div class="bubble-actions"><button class="bubble-reply" hidden>답장하기</button><button class="bubble-accept" hidden>같이하기</button><button class="bubble-leave" hidden>함께하기 그만두기</button></div></div>
  </article>
  <section class="pet-connection" data-hit hidden role="status" aria-label="소식 수신 문제"><button class="menu-close" aria-label="연결 안내 닫기">${icon('close')}</button><strong>소식을 받을 수 없어요</strong><p></p><button class="connection-retry">다시 연결</button><button class="connection-login" hidden>다시 로그인</button></section>
  <div class="reaction" hidden aria-live="polite"></div>
  <span class="pet-floor-shadow" aria-hidden="true" hidden></span>
  <canvas class="pet-canvas" width="160" height="160" role="button" tabindex="0" aria-label="오른쪽 클릭으로 내 펫 동작 메뉴 열기" aria-keyshortcuts="Enter Space Shift+F10"></canvas>`;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const floorShadow = root.querySelector<HTMLElement>('.pet-floor-shadow')!;
  const menu = root.querySelector<HTMLElement>('.pet-menu')!;
  menu.id = `pet-actions-${crypto.randomUUID()}`;
  canvas.setAttribute('aria-controls', menu.id);
  canvas.setAttribute('aria-expanded', 'false');
  const bubble = root.querySelector<HTMLElement>('.pet-bubble')!;
  const bubblePages = mountBubblePages(bubble);
  const reaction = root.querySelector<HTMLElement>('.reaction')!;
  const connectionNotice = root.querySelector<HTMLElement>('.pet-connection')!;
  const label = document.createElement('span');
  label.className = 'pet-nameplate pet-label';
  label.hidden = true;
  root.append(label);
  if (targetID) {
    menu.querySelector('.pet-menu-title')!.textContent = '이 친구의 펫에게';
    canvas.setAttribute('aria-label', '오른쪽 클릭으로 친구 펫 동작 메뉴 열기');
    menu.querySelector<HTMLButtonElement>('[data-action=highfive]')!.hidden = false;
    menu.querySelector<HTMLElement>('.pet-menu-row')!.hidden = false;
    menu.querySelector<HTMLButtonElement>('[data-action=wave]')!.hidden = false;
    menu.querySelector<HTMLButtonElement>('[data-action=recruit]')!.hidden = true;
  }
  let design: Design | null = null;
  let builtin = 'cat';
  let image: HTMLImageElement | null = null;
  let imageURL: string | undefined;
  let stopped = false;
  let reactUntil = 0;
  let reactionStart = 0;
  let clickedAnimationId: string | undefined;
  let gesture: Gesture = 'wave';
  let mirroredGesture = false;
  let pairedReaction = false;
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let currentEvent: PetEvent | undefined;
  let activeProposal: PetEvent | undefined;
  const motion = petMotion(canvas, root);
  let previousReaction = '';
  let previousTick = Date.now();
  let suspended = false;
  let petSize = 160;
  let displayedSize = 160;
  let offline = false;
  let registered = !!targetID;
  let socketAccount = '';
  let refreshVersion = 0;
  let connectionState = '';
  let connectionStartedAt = Date.now();
  let connectionDismissed = false;
  let keyboardFocus = false;
  let topInset = 0;
  let walking = false;
  let direction = 1;
  let nativeDistance: number | undefined;
  let nativeSpeed = 0;
  let nativeHovered = false;
  let liftHeight = 0;
  let carried = false;
  let landing = 0;
  let elevationSequence = -1;
  const unlistenHover = isTauri() && !preview ? await ownWindow!.listen<boolean>('pet-hover', event => {
    nativeHovered = event.payload;
  }) : (): void => {};
  let groups: Gathering[] = [];
  let knownPets: Pet[] = [];
  let bubbleMessage = "";
  let groupFingerprint = "";
  let menuState = false;
  let reactionState = false;
  let bubbleUntil = 0;
  let disconnect = (): void => {};
  let account = '';
  let lastRegions = '';
  const queue: PetEvent[] = [];
  const receivedMessages = new Map<string, number>();
  const composer = mountPetComposer(root, preview, () => {
    releaseFocus();
    menu.hidden = true;
    bubble.hidden = true;
    connectionNotice.hidden = true;
    recruitment.close();
    canvas.setAttribute('aria-expanded', 'true');
  }, () => knownPets);
  const menuMessage = mountMenuMessage(menu, preview, targetID, (text, recipient) => composer.sendInline(text, recipient), () => {
    keyboardFocus = true;
    return setPetInput(true, preview);
  }, () => {
    menu.hidden = true;
    releaseFocus();
  });
  const recruitment = mountRecruitment(root, preview, targetID, () => knownPets, () => groups, next => updateGroups(next, true), () => {
    composer.close();
    releaseFocus();
    menu.hidden = true;
    bubble.hidden = true;
    connectionNotice.hidden = true;
  }, releaseFocus);

  // 내 펫에서는 모집을 시작하고 친구 펫에서는 그 친구의 모집에 참여하도록 메뉴를 맞춘다.
  function updateRecruitmentMenu(): void {
    // 1. 현재 선택한 펫의 모집과 내 참가 관계를 확인한다.
    const group = recruitment.current();
    const joined = group?.members.some(member => member.petId === session()?.principal.petId);
    const button = menu.querySelector<HTMLButtonElement>('[data-action=recruit]')!;
    const caption = group ? (targetID && !joined ? '모집 참여' : '모집 현황') : '모집';

    // 2. 친구의 모집이 있을 때만 참여 메뉴를 표시하고 모집 진입은 깃발로 통일한다.
    button.hidden = !!targetID && !group;
    button.querySelector('[data-recruit-label]')!.textContent = caption;
    button.querySelector('[data-recruit-icon]')!.textContent = '🚩';
    button.setAttribute('aria-label', group ? `${recruitmentOptions[group.kind].label} ${caption}` : '모집 종류 선택');
  }

  // 접속 중인 펫만 표시하며 내 모임의 제안자와 참여자부터 창 한도를 적용한다.
  function shownPeerIDs(): string[] {
    const ownID = session()?.principal.petId;
    const online = new Set(knownPets.filter(pet => pet.online).map(pet => pet.id));
    const active = groups.find(group => group.hostPetId === ownID || group.members.some(member => member.petId === ownID));
    const priority = active ? [active.hostPetId, ...active.members.map(member => member.petId)] : [];
    const recruiting = groups.filter(group => group.origin === 'recruitment').map(group => group.hostPetId);
    return Array.from(new Set([...priority, ...recruiting, ...knownPets.map(pet => pet.id)])).filter(id => id !== ownID && online.has(id)).slice(0, 32);
  }

  // 모든 공개 모집을 받아도 실제 표시 중인 창에 해당하는 모임만 네이티브에 연결한다.
  async function syncDesktopGroups(): Promise<void> {
    if (!isTauri() || preview || targetID || !session()) {
      return;
    }
    const peers = shownPeerIDs();
    const ownID = session()!.principal.petId;
    const visible = new Set([ownID, ...peers]);
    await invoke('sync_peers', { petIds: peers });
    const ownGroup = groups.find(group => group.hostPetId === ownID || group.members.some(member => member.petId === ownID));
    const ordered = ownGroup ? [ownGroup, ...groups.filter(group => group.id !== ownGroup.id)] : groups;
    const shownGroups = ordered.flatMap(group => {
      const members = group.members.filter(member => visible.has(member.petId));
      const hostPetId = visible.has(group.hostPetId) ? group.hostPetId : members[0]?.petId;
      if (!hostPetId) {
        return [];
      }
      return [{ ...group, hostPetId, members: members.filter(member => member.petId !== hostPetId) }];
    }).slice(0, 32);
    await invoke('sync_gatherings', { localPetId: ownID, groups: shownGroups });
  }

  // 트레이로 명시적으로 받은 키보드 포커스를 일반 상태로 돌린다.
  function releaseFocus(): void {
    if (keyboardFocus) {
      keyboardFocus = false;
      void setPetInput(false, preview).catch(console.error);
    }
  }

  // 실패할 때만 수신 상태를 공유하고 상시 연결 배지는 표시하지 않는다.
  function publishConnection(state = connectionState): void {
    if (state === '연결 확인 중' && connectionState && connectionState !== '연결됨' && Date.now() - connectionStartedAt > 3000) {
      state = '재연결 중';
    }
    connectionState = state;
    root.dataset.connection = state;
    if (state === '연결됨') {
      connectionDismissed = false;
    }
    const current = session();
    if (!targetID && current && state) {
      try {
        localStorage.setItem('ourpets.connection', JSON.stringify({ state, at: Date.now(), server: serverURL(), deviceId: current.principal.deviceId }));
      } catch {
        // 저장 공간이 부족해도 현재 창의 연결 안내와 재시도는 유지한다.
      }
      if (isTauri()) {
        void emit('connection-state', state).catch(console.error);
      } else {
        window.dispatchEvent(new CustomEvent('connection-state', { detail: state }));
      }
    }
  }

  // 연결을 명시적으로 다시 시작하되 끊긴 동안의 과거 이벤트를 복구하지 않는다.
  async function retryConnection(): Promise<void> {
    connectionDismissed = false;
    connectionStartedAt = Date.now();
    disconnect();
    account = '';
    publishConnection('재연결 중');
    await refresh();
  }
  connectionNotice.querySelector<HTMLButtonElement>('.menu-close')!.onclick = () => {
    connectionDismissed = true;
    connectionNotice.hidden = true;
    releaseFocus();
  };
  connectionNotice.querySelector<HTMLButtonElement>('.connection-retry')!.onclick = () => {
    void retryConnection().catch(error => publishConnection(error instanceof Error ? error.message : '다시 연결하지 못했어요. 잠시 뒤 재시도해 주세요.'));
  };
  connectionNotice.querySelector<HTMLButtonElement>('.connection-login')!.onclick = () => {
    if (isTauri()) {
      void emit('request-sign-in').then(() => invoke('pet_control', { action: 'settings' })).catch(console.error);
    } else {
      window.dispatchEvent(new CustomEvent('request-sign-in'));
    }
  };

  // OS 작업 영역과 실제 창에 맞춰 펫과 팝업 크기를 제한한다.
  async function fitContent(): Promise<void> {
    // 1. 작은 화면에서는 보이는 펫만 줄이고 저장한 공통 크기는 바꾸지 않는다.
    const height = root.clientHeight || 560;
    const width = root.clientWidth || 360;
    const nextSize = Math.max(32, Math.min(petSize, height - 96, width - 24));
    if (nextSize !== displayedSize || canvas.width !== nextSize) {
      displayedSize = nextSize;
      canvas.width = canvas.height = nextSize;
      canvas.style.width = canvas.style.height = `${nextSize}px`;
    }
    root.style.setProperty('--pet-size', `${displayedSize}px`);

    // 2. 작업 영역 위에 가려진 부분을 빼고 메뉴 전체의 스크롤 공간을 확보한다.
    if (isTauri() && !preview) {
      try {
        const area = await invoke<{ width: number; height: number; overlayTop: number }>('pet_work_area');
        topInset = Math.max(0, area.overlayTop || 0);
      } catch {
        topInset = 0;
      }
    }
    root.style.setProperty('--pet-top-inset', `${topInset}px`);
  }

  // 현재 표시한 카드나 메뉴만 트레이에서 키보드로 조작할 수 있게 한다.
  async function focusOverlay(kind: 'menu' | 'bubble'): Promise<void> {
    // 1. 숨긴 과거 메시지를 다시 표시하지 않고 현재 조작 대상을 확정한다.
    if (kind === 'bubble' && bubble.hidden) {
      if (composer.visible()) {
        await composer.focus();
        return;
      }
      if (recruitment.visible()) {
        await recruitment.focus();
        keyboardFocus = true;
        return;
      }
      keyboardFocus = false;
      await setPetInput(false, preview);
      return;
    }
    if (kind === 'menu') {
      composer.close();
      recruitment.close();
      menu.hidden = false;
      bubble.hidden = true;
      motion.reveal(menu);
    }

    // 2. 명시적 요청에만 입력을 허용하고 첫 유효 동작이나 본문을 선택한다.
    keyboardFocus = true;
    await setPetInput(true, preview);
    const overlay = kind === 'menu' ? menu : bubble;
    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.hidden && !button.disabled && button.getClientRects().length && !button.matches('.menu-close,.bubble-close'));
    (overlay.querySelector<HTMLInputElement>('.pet-menu-message input:not(:disabled)') || buttons[0] || overlay).focus();
  }

  // 펫 위 메뉴를 열고 알림 카드와 겹치지 않게 한다.
  function toggleMenu(): void {
    releaseFocus();
    composer.close();
    recruitment.close();
    menu.hidden = !menu.hidden;
    canvas.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      motion.reveal(menu);
      bubble.hidden = true;
    }
  }
  // 마우스 메뉴는 오른쪽 클릭에서만 열고 WebView 기본 메뉴와 중복되지 않게 한다.
  canvas.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    if (carried || liftHeight > 0) {
      return;
    }
    toggleMenu();
  };
  canvas.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      toggleMenu();
      if (!menu.hidden) {
        void focusOverlay('menu').catch(console.error);
      }
    } else if (event.key === 'Escape') {
      menu.hidden = true;
      bubble.hidden = true;
      composer.close();
      recruitment.close();
      releaseFocus();
    }
  };
  // 메뉴 안의 어떤 버튼에 포커스가 있어도 Escape로 닫고 펫으로 돌아간다.
  function escapeMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      menu.hidden = true;
      bubble.hidden = true;
      composer.close();
      recruitment.close();
      releaseFocus();
      canvas.setAttribute('aria-expanded', 'false');
      if (preview || !isTauri()) {
        canvas.focus();
      }
    }
  }
  root.addEventListener('keydown', escapeMenu);
  // 직접 클릭한 펫의 추가 동작을 한 번 뽑고 없으면 기존 쓰다듬기 표현을 사용한다.
  function patPet(): void {
    pairedReaction = false;
    const selected = design ? randomClickAnimation(design.manifest) : undefined;
    clickedAnimationId = selected?.id;
    reactionStart = Date.now();
    reactUntil = reactionStart + (selected ? selected.animation.frames.length / selected.animation.fps * 1000 : 3300);
    gesture = 'pat';
    reaction.textContent = '💕 기분 좋아요!';
    reaction.hidden = false;
  }
  let down: { x: number; y: number; pointerID: number } | undefined;
  let dragging = false;
  canvas.onpointerdown = event => {
    dragging = false;
    down = event.button === 0 && !event.ctrlKey ? { x: event.screenX, y: event.screenY, pointerID: event.pointerId } : undefined;
    if (down) {
      canvas.setPointerCapture(event.pointerId);
      menu.hidden = true;
      composer.close();
      recruitment.close();
      releaseFocus();
      canvas.setAttribute('aria-expanded', 'false');
    }
  };
  canvas.onpointermove = event => {
    if (down && event.buttons === 1 && !dragging && Math.hypot(event.screenX - down.x, event.screenY - down.y) > 6 && isTauri() && !preview) {
      dragging = true;
      reactUntil = 0;
      motion.stop();
      menu.hidden = true;
      composer.close();
      recruitment.close();
      releaseFocus();
      void invoke('drag_pet').catch(() => {
        dragging = false;
        down = undefined;
      });
    }
  };
  // 짧은 왼쪽 클릭만 쓰다듬고 드래그를 놓거나 취소하면 착지 명령만 보낸다.
  function finishPointer(event: PointerEvent): void {
    // 1. 시작한 포인터만 처리하고 이동 거리를 기준으로 클릭과 드래그를 구분한다.
    if (!down || down.pointerID !== event.pointerId) {
      return;
    }
    const dragged = dragging || Math.hypot(event.screenX - down.x, event.screenY - down.y) > 6;
    if (dragging && isTauri() && !preview) {
      void invoke('drop_pet').catch(console.error);
    }
    if (event.type === 'pointerup' && event.button === 0 && !dragged && !carried && liftHeight === 0) {
      patPet();
    }

    // 2. 캡처와 로컬 조작 상태를 정리해 다음 클릭에 이전 드래그를 남기지 않는다.
    down = undefined;
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }
  canvas.onpointerup = canvas.onpointercancel = finishPointer;
  // 창 전환 등으로 포인터 캡처가 사라져도 들고 있는 상태를 남기지 않는다.
  canvas.onlostpointercapture = event => {
    if (down?.pointerID === event.pointerId) {
      if (dragging && isTauri() && !preview) {
        void invoke('drop_pet').catch(console.error);
      }
      down = undefined;
      dragging = false;
    }
  };
  bubble.querySelector('button')!.onclick = () => {
    bubble.hidden = true;
    bubbleUntil = 0;
    releaseFocus();
  };

  // 선택한 펫 곁에서 메시지 작성·제안·상호작용을 직접 실행한다.
  async function act(action: string): Promise<void> {
    menu.hidden = true;
    releaseFocus();
    if (action === 'close' && (preview || !isTauri())) {
      canvas.focus();
    }
    if (action === 'highfive' || action === 'wave') {
      if (!targetID) {
        return;
      }
      if (targetID && groups.some(group => group.hostPetId === (session()?.principal.petId || '') || group.members.some(member => member.petId === session()?.principal.petId))) {
        throw new Error('함께하기를 마친 뒤 인사할 수 있어요.');
      }
      if (targetID) {
        const current = session();
        if (!current) {
          throw new Error('로그인 후 친구 펫과 상호작용할 수 있습니다.');
        }
        await api('/messages', { method: 'POST', body: JSON.stringify({ senderPetId: current.principal.petId, mode: 'selected', petIds: [targetID], kind: 'interaction', body: action, idempotencyKey: crypto.randomUUID() }) });
        if (isTauri() && !preview) {
          await setPetInput(false);
          const anchors = petAnchors(canvas, image, design);
          await invoke('set_regions', { regions: hitRegions(canvas, root), menuOpen: false, reacting: false, visualWidth: petVisualWidth(displayedSize, image, design, canvas), visualHeight: parseFloat(root.style.getPropertyValue('--pet-visual-height')) || displayedSize, handReach: anchors.handReach, handHeight: anchors.handHeight });
        }
        await playPair({ fromID: current.principal.petId, toID: targetID, body: action === 'highfive' ? 'highfive' : 'wave' });
      }
      reaction.textContent = action === 'highfive' ? '🙌 하이파이브를 보냈어요!' : '👋 함께 인사해요!';
      reaction.hidden = false;
    } else if (action === 'recruit') {
      if (targetID) {
        if (!recruitment.current()) {
          throw new Error('이 친구의 모집이 종료됐어요.');
        }
        recruitment.open();
      } else {
        recruitment.choose();
      }
    } else if (action === 'gathering' && activeProposal) {
      prioritize(activeProposal);
      bubble.hidden = true;
    }
  }
  menu.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    button.onclick = () => {
      button.disabled = true;
      void act(button.dataset.action!).catch(error => {
        reaction.textContent = error instanceof Error ? error.message : '다시 시도해 주세요.';
        reactionStart = Date.now();
        reactUntil = reactionStart + 3300;
        gesture = 'pat';
        clickedAnimationId = undefined;
      }).finally(() => {
        button.disabled = false;
        canvas.setAttribute('aria-expanded', String(!menu.hidden || composer.visible() || recruitment.visible()));
      });
    };
  });

  // 수신 권한을 확인한 대표 펫이 텍스트를 현재 PC의 발신자 펫에 표시한다.
  async function presentSenderMessage(event: PetEvent): Promise<void> {
    // 1. 현재 수신자의 본문은 준비된 발신자 창에만 표시한다.
    const current = session();
    try {
      await invoke<boolean>('route_message_bubble', { recipientPetId: current?.principal.petId, senderPetId: event.sender?.petId, message: event });
    } catch {
      // 2. 숨김·준비 전·전달 실패에서도 수신자 펫으로 옮기지 않고 기존 OS 알림만 유지한다.
    }
  }

  // 접속 중 받은 이벤트는 OS 알림 한 번과 현재 발신자 또는 내 펫 말풍선에 전달한다.
  function receive(event: PetEvent): void {
    if (!registered || event.expiresAt <= Date.now()) {
      return;
    }
    // 1. 같은 메시지의 재전달은 창별 최근 ID로 거르고 본문을 영속 보관하지 않는다.
    const text = event.type === 'message' && event.kind === 'text' && !event.outgoing && !!event.sender;
    if (text) {
      const now = Date.now();
      for (const [id, expires] of receivedMessages) {
        if (expires <= now) {
          receivedMessages.delete(id);
        }
      }
      if (receivedMessages.has(event.id)) {
        return;
      }
      receivedMessages.set(event.id, now + 60000);
      if (receivedMessages.size > 10000) {
        receivedMessages.delete(receivedMessages.keys().next().value!);
      }
    }

    // 2. OS 알림은 대표 펫에서만 만들고 내부 텍스트의 말풍선만 발신 창으로 보낸다.
    if (!preview && !targetID) {
      notifyReceivedMessage(event);
      if (text && isTauri()) {
        void presentSenderMessage({ ...event, expiresAt: Math.min(event.expiresAt, Date.now() + 15000) });
        return;
      }
    }
    if (event.kind === 'interaction') {
      pairedReaction = false;
      reactionStart = Date.now();
      reactUntil = reactionStart + 3300;
      gesture = event.body === 'highfive' ? 'highfive' : 'wave';
      reaction.textContent = event.body === 'highfive' ? '🙌 하이파이브!' : '👋 반가워요!';
      if (event.sender && session() && !composer.visible() && !recruitment.visible() && !keyboardFocus && menu.hidden) {
        void playPair({ fromID: event.sender.petId, toID: session()!.principal.petId, body: event.body === 'highfive' ? 'highfive' : 'wave' }).catch(console.error);
      }
    }
    if ((event.type !== 'notification' || !connectedAlertsMuted()) && queue.length < 100) {
      queue.push({ ...event, expiresAt: Math.min(event.expiresAt, Date.now() + 15000) });
    }

  }

  // 캐시된 외형을 먼저 사용하고 접속 시 최신 펫 버전과 기기 세션을 연결한다.
  async function refresh(): Promise<void> {
    // 1. 계정이 바뀌면 이전 수신·모집·입력 상태를 정리한다.
    const version = ++refreshVersion;
    const current = session();
    const nextAccount = `${serverURL()}/${current?.principal.deviceId || ''}/${current?.token || ''}`;
    if (nextAccount !== account) {
      disconnect();
      socketAccount = '';
      registered = !!targetID;
      root.hidden = !registered;
      account = nextAccount;
      composer.close();
      recruitment.close();
      releaseFocus();
      queue.length = 0;
      receivedMessages.clear();
      groups = [];
      groupFingerprint = '';
      recruitment.update();
      updateRecruitmentMenu();
      bubble.hidden = true;
      connectionStartedAt = Date.now();
      disconnect = (): void => {};
      design = null;
      image = null;
      if (imageURL) {
        URL.revokeObjectURL(imageURL);
        imageURL = undefined;
      }
    }
    if (!current) {
      if (isTauri() && !preview && !targetID) {
        await invoke('set_pet_registered', { registered: false });
        await invoke('sync_peers', { petIds: [] });
      }
      return;
    }
    if (!targetID) {
      publishConnection();
    }
    const key = `ourpets.own.${serverURL()}.${targetID || current.principal.petId}`;
    let own: Pet | undefined = JSON.parse(localStorage.getItem(key) || 'null') || undefined;
    try {
      // 2. 실제 등록을 완료한 대표 펫만 창과 수신 소켓을 활성화한다.
      if (!targetID) {
        const profile = await api<RegisteredPet>('/me/pet');
        if (stopped || account !== nextAccount || version !== refreshVersion) {
          return;
        }
        registered = profile.registered;
        root.hidden = !registered;
        if (isTauri() && !preview) {
          await invoke('set_pet_registered', { registered });
        }
        if (!registered) {
          disconnect();
          socketAccount = '';
          knownPets = [];
          if (isTauri() && !preview) {
            await invoke('sync_peers', { petIds: [] });
          }
          return;
        }
        own = profile;
        if (socketAccount !== nextAccount && (!isTauri() || !preview)) {
          disconnect = connect(receive, publishConnection, next => void updateGroups(next, true), event => {
            if (!preview && !targetID) {
              notifyGatheringActivity(event);
            }
          });
          socketAccount = nextAccount;
        }
      }

      // 3. 접속 상태를 갱신하고 오프라인 친구의 실제 창을 표시 목록에서 제거한다.
      const all = await api<Pet[]>('/pets');
      if (stopped || account !== nextAccount || version !== refreshVersion) {
        return;
      }
      knownPets = all;
      own = all.find(p => p.id === (targetID || current.principal.petId));
      offline = !!targetID && !!own && !own.online;
      root.dataset.offline = String(offline);
      menuMessage.setOffline(offline);
      if (targetID && own) {
        menu.querySelector<HTMLElement>('.pet-menu-title')!.textContent = own.ownerName || own.name;
        const status = menu.querySelector<HTMLElement>('.pet-menu-status')!;
        status.hidden = !offline;
        status.textContent = '오프라인 · 접속하면 대화할 수 있어요.';
        menu.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
          button.disabled = offline && button.dataset.action !== 'close';
        });
      }
      if (isTauri() && !preview && !targetID) {
        await syncDesktopGroups();
      }
      localStorage.setItem(key, JSON.stringify(own));
    } catch {
      // 네트워크가 끊겨도 마지막으로 받은 펫 외형을 유지한다.
    }
    if (stopped || account !== nextAccount || version !== refreshVersion) {
      return;
    }
    // 4. 캐시 복구 때도 이름표에는 소유자 닉네임을 표시하고 키보드 접근 이름도 맞춘다.
    builtin = own?.builtinId || 'cat';
    label.textContent = own?.ownerName || own?.name || '';
    canvas.setAttribute('aria-label', `${own?.ownerName || own?.name || (targetID ? '친구 펫' : '내 펫')} 동작 메뉴 · 오른쪽 클릭 또는 Enter`);
    if (own && !own.design && design) {
      design = null;
      image = null;
      if (imageURL) {
        URL.revokeObjectURL(imageURL);
        imageURL = undefined;
      }
    }
    if (own?.design && own.design.id !== design?.id && !stopped) {
      const nextURL = await designImage(own.design);
      const nextImage = await loadImage(nextURL);
      if (stopped || account !== nextAccount) {
        URL.revokeObjectURL(nextURL);
        return;
      }
      if (imageURL) {
        URL.revokeObjectURL(imageURL);
      }
      imageURL = nextURL;
      image = nextImage;
      design = own.design;

    }
  }

  // 유휴 프레임을 제한하고 현재 그림의 입력 영역만 네이티브 창에 전달한다.
  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    if (document.hidden || !registered) {
      label.hidden = true;
      root.dataset.nameVisible = 'false';
      if (!suspended) {
        reactUntil = 0;
        motion.stop();
        suspended = true;
      }
      previousTick = Date.now();
      setTimeout(() => void tick(), 500);
      return;
    }
    suspended = false;
    const now = Date.now();
    if (connectedAlertsMuted()) {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].type === 'notification') {
          queue.splice(index, 1);
        }
      }
      if (currentEvent?.type === 'notification') {
        bubble.hidden = true;
      }
    }
    const reacting = now < reactUntil;
    root.dataset.interacting = String(reacting);
    reaction.hidden = !reacting;
    root.dataset.animation = reacting ? gesture : 'idle';
    const reactionKey = reacting ? `${reactionStart}/${gesture}` : '';
    if (reactionKey && reactionKey !== previousReaction) {
      motion.react(gesture);
    }
    previousReaction = reactionKey;
    canvas.style.transform = motionPreference.matches || !landing ? 'none' : `scale(${1 + landing * .12}, ${1 - landing * .12})`;
    root.style.setProperty('--pet-ground', `${30 + liftHeight}px`);
    floorShadow.hidden = liftHeight <= 0;
    floorShadow.style.width = `${displayedSize * .65 / (1 + liftHeight / 800)}px`;
    floorShadow.style.opacity = String(.22 / (1 + liftHeight / 240));
    if (!bubble.hidden && (bubble.matches(':hover') || bubble.contains(document.activeElement))) {
      bubbleUntil += now - previousTick;
    }
    previousTick = now;
    const displayedID = targetID || session()?.principal.petId;
    const grouped = groups.some(group => group.hostPetId === displayedID || group.members.some(member => member.petId === displayedID));
    const movingNow = !carried && liftHeight === 0 && !landing && !offline && menu.hidden && !composer.visible() && !recruitment.visible() && !motionPreference.matches && (isTauri() ? walking : !grouped && preview && Math.floor(now / 4000) % 2 === 0);
    const visualHeight = drawPet(canvas, image, design, reacting ? 'react' : movingNow ? 'walk' : 'idle', motionPreference.matches ? 0 : now, { animationId: reacting && gesture === 'pat' ? clickedAnimationId : undefined, walking: movingNow, direction, gesture: reacting ? gesture : undefined, elapsed: now - reactionStart, reduced: motionPreference.matches, mirrored: mirroredGesture, pose: motion.pose, resting: offline || (grouped && !movingNow), distance: nativeDistance, speed: nativeSpeed, paired: pairedReaction, elevation: liftHeight, carried, builtin });
    const anchors = petAnchors(canvas, image, design);
    root.style.setProperty('--pet-visual-height', `${anchors.headHeight}px`);
    const overlaySpace = root.clientHeight - 30 - liftHeight - anchors.headHeight - 20 - topInset;
    root.style.setProperty('--pet-overlay-space', `${Math.max(48, overlaySpace)}px`);
    updateBubbleActions();
    if (!bubble.hidden && now > bubbleUntil) {
      bubble.hidden = true;
      releaseFocus();
    }
    if (bubble.hidden && menu.hidden && !composer.visible() && !recruitment.visible() && queue.length) {
      let event = queue.shift()!;
      while (event.expiresAt <= now && queue.length) {
        event = queue.shift()!;
      }
      if (event.expiresAt > now) {
        currentEvent = event;
        bubbleMessage = "";
        bubble.querySelector<HTMLButtonElement>('.bubble-reply')!.hidden = !event.sender || !!event.outgoing || event.kind === 'interaction';
        bubble.dataset.eventId = event.id;
        const sender = bubble.querySelector<HTMLElement>('.bubble-sender')!;
        sender.replaceChildren();
        const senderName = document.createElement('span');
        senderName.className = 'bubble-sender-name';
        senderName.textContent = event.outgoing ? event.outgoing.mode === 'all' ? '모두에게 보낸 메시지' : `${event.outgoing.recipientName || '상대'}에게 보낸 ${event.replyToMessageId ? '답장' : '메시지'}` : event.sender ? event.sender.userName || event.sender.petName : externalNotificationTitle(event.notification);
        sender.title = senderName.textContent;
        sender.append(senderName);
        if (event.sender?.designId) {
          const expectedID = event.id;
          bubble.dataset.eventId = expectedID;
          void api<Design>(`/designs/${event.sender.designId}`).then(async d => {
            const url = await designImage(d);
            if (bubble.dataset.eventId === expectedID) {
              const avatar = document.createElement('img');
              avatar.src = url;
              avatar.alt = '발신 펫';
              avatar.onload = () => URL.revokeObjectURL(url);
              sender.prepend(avatar);
            } else {
              URL.revokeObjectURL(url);
            }
          }).catch(console.error);
        } else if (event.sender) {
          const avatar = document.createElement('canvas');
          avatar.width = avatar.height = 28;
          avatar.className = 'bubble-avatar';
          drawPet(avatar, null, null, 'idle', 0, { builtin: event.sender.builtinId });
          sender.prepend(avatar);
        }
        bubblePages.setText(event.kind === 'interaction' ? (event.body === 'highfive' ? '🙌 내 펫과 하이파이브!' : '👋 친구 펫과 인사해요!') : event.body || event.notification?.body || '');
        bubble.hidden = false;
        motion.reveal(bubble);
        bubbleUntil = now + 12000;
      }
    }
    bubblePages.fit(overlaySpace, root.clientHeight - topInset - 20);
    const receivingProblem = !!session() && !!connectionState && connectionState !== '연결됨' && now - connectionStartedAt > 3000;
    connectionNotice.hidden = !!targetID || preview || connectionDismissed || !receivingProblem || !menu.hidden || composer.visible() || recruitment.visible() || !bubble.hidden;
    const hovered = isTauri() && !preview ? nativeHovered : canvas.matches(':hover');
    const showName = (hovered || !menu.hidden) && !!label.textContent && !dragging && !carried && liftHeight === 0 && !reacting;
    label.hidden = !showName;
    root.dataset.nameVisible = String(showName);
    if (!connectionNotice.hidden) {
      connectionNotice.querySelector<HTMLElement>('p')!.textContent = `${connectionState}. 연결이 돌아오면 새 소식부터 받아요.`;
      connectionNotice.querySelector<HTMLButtonElement>('.connection-login')!.hidden = !connectionState.includes('로그인');
      connectionNotice.querySelector<HTMLButtonElement>('.connection-retry')!.hidden = connectionState.includes('로그인');
    }
    if (isTauri() && !preview) {
      const regions = hitRegions(canvas, root);
      const serialized = JSON.stringify(regions);
      const overlayOpen = !menu.hidden || composer.visible() || recruitment.visible() || !connectionNotice.hidden;
      if (serialized !== lastRegions || menuState !== overlayOpen || reactionState !== reacting) {
        try {
          await invoke('set_regions', { regions, menuOpen: overlayOpen, reacting, visualWidth: petVisualWidth(displayedSize, image, design, canvas), visualHeight, handReach: anchors.handReach, handHeight: anchors.handHeight });
          menuState = overlayOpen;
          reactionState = reacting;
          lastRegions = serialized;
        } catch (error) {
          console.error(error);
        }
      }
    }
    root.dataset.overlayBusy = String(!menu.hidden || composer.visible() || recruitment.visible() || !bubble.hidden || !connectionNotice.hidden);
    canvas.setAttribute('aria-expanded', String(!menu.hidden || composer.visible() || recruitment.visible()));
    setTimeout(() => void tick(), carried || liftHeight > 0 || landing ? 1000 / 30 : motionPreference.matches ? 150 : (!image && walking) || (design && animationKey(design.manifest, 'walk')) || reacting ? 1000 / 30 : 100);
  }
  void refresh().catch(console.error);
  void tick();
  const refreshTimer = setInterval(() => {
    void refresh().catch(console.error);
    void fitContent();
  }, 5000);
  const unlisten = isTauri() ? await listen('session-changed', () => void refresh().catch(console.error)) : (): void => {};
  // 같은 제안의 최신 상태만 앞에 두고 중복 카드 대기를 남기지 않는다.
  function prioritize(event: PetEvent): void {
    const id = event.id.replace(/^sent:/, '');
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].id.replace(/^sent:/, '') === id) {
        queue.splice(index, 1);
      }
    }
    queue.unshift(event);
  }

  // 현재 모임 변화만 공유하고 수락한 펫을 제안자 옆자리로 연결한다.
  async function updateGroups(next: Gathering[], broadcast = false): Promise<void> {
    const fingerprint = JSON.stringify(next);
    if (fingerprint === groupFingerprint) {
      return;
    }
    const old = groups;
    groups = next;
    groupFingerprint = fingerprint;
    recruitment.update();
    updateRecruitmentMenu();
    if (isTauri() && broadcast && session()) {
      await syncDesktopGroups();
      await emit('gatherings-changed', groups);
    } else if (broadcast) {
      window.dispatchEvent(new CustomEvent('gatherings-changed', { detail: groups }));
    }
    const ownID = session()?.principal.petId;
    const active = groups.find(group => group.origin !== 'recruitment' && (group.hostPetId === ownID || group.members.some(member => member.petId === ownID)));
    menu.querySelector<HTMLButtonElement>('[data-action=gathering]')!.hidden = !active || !!targetID;
    if (!active) {
      activeProposal = undefined;
    } else if (currentEvent?.id.replace(/^sent:/, '') === active.id) {
      activeProposal = { ...currentEvent, expiresAt: active.expiresAt };
    }
    if (!active && old.some(group => group.id === currentEvent?.id.replace(/^sent:/, ''))) {
      bubbleMessage = '함께하기가 끝났어요.';
    }
    if (!targetID && active && (!old.some(group => group.id === active.id) || JSON.stringify(old.find(group => group.id === active.id)?.members) !== JSON.stringify(active.members))) {
      const id = currentEvent?.id.replace(/^sent:/, '');
      if (id !== active.id) {
        const host = knownPets.find(pet => pet.id === active.hostPetId);
        const card: PetEvent = activeProposal?.id.replace(/^sent:/, '') === active.id ? activeProposal : { id: active.id, type: 'message', kind: 'text', proposalKind: active.kind === 'coffee' ? 'coffee' : 'meal', body: active.hostPetId === ownID ? '함께할 친구를 기다리고 있어요.' : '수락했어요. 제안한 친구 곁으로 갈게요.', sender: { userId: host?.userId || '', petId: active.hostPetId, userName: host?.ownerName || '친구', petName: host?.name || '제안한 펫' }, outgoing: active.hostPetId === ownID ? { mode: 'selected', recipientCount: 0 } : undefined, createdAt: Date.now(), expiresAt: active.expiresAt };
        activeProposal = card;
        prioritize(card);
      }
      menu.hidden = true;
      bubble.hidden = true;
      if (id === active.id && currentEvent) {
        prioritize({ ...currentEvent, expiresAt: active.expiresAt });
      }
    }
    updateBubbleActions();
  }

  // 말풍선의 수락·참여자·종료 버튼을 현재 모임 상태에 맞춘다.
  function updateBubbleActions(): void {
    const id = currentEvent?.id.replace(/^sent:/, '');
    const group = groups.find(item => item.id === id);
    const ownID = session()?.principal.petId;
    const host = group?.hostPetId === ownID;
    const accepted = !!group?.members.some(member => member.petId === ownID);
    const accept = bubble.querySelector<HTMLButtonElement>('.bubble-accept')!;
    const leave = bubble.querySelector<HTMLButtonElement>('.bubble-leave')!;
    accept.hidden = !currentEvent?.proposalKind || !!currentEvent.outgoing || accepted;
    const acceptLabel = currentEvent?.proposalKind === 'coffee' ? '같이 마실래요' : '같이 먹을래요';
    if (accept.textContent !== acceptLabel) {
      accept.textContent = acceptLabel;
    }
    leave.hidden = !group || (!host && !accepted);
    const leaveLabel = host ? '제안 끝내기' : '함께하기 그만두기';
    if (leave.textContent !== leaveLabel) {
      leave.textContent = leaveLabel;
    }
    const state = bubble.querySelector<HTMLElement>('.bubble-state')!;
    const stateLabel = bubbleMessage || (group ? `${accepted ? '✓ 수락했어요 · ' : ''}${group.members.length ? `함께하는 친구: ${group.members.map(member => member.userName).join(', ')}` : '수락할 친구를 기다리고 있어요'}` : '');
    if (state.textContent !== stateLabel) {
      state.textContent = stateLabel;
    }
    if (group && !bubble.hidden) {
      bubbleUntil = Math.max(bubbleUntil, Date.now() + 1000);
    }
  }
  bubble.querySelector<HTMLButtonElement>('.bubble-accept')!.onclick = () => {
    if (!currentEvent?.proposalKind) {
      return;
    }
    const button = bubble.querySelector<HTMLButtonElement>('.bubble-accept')!;
    button.disabled = true;
    bubbleMessage = '';
    void api(`/gatherings/${currentEvent.id.replace(/^sent:/, '')}/accept`, { method: 'POST' }).then(async () => updateGroups(await api<Gathering[]>('/gatherings'), true)).catch(error => {
      bubbleMessage = error.message;
    }).finally(() => {
      button.disabled = false;
    });
  };
  bubble.querySelector<HTMLButtonElement>('.bubble-leave')!.onclick = () => {
    if (!currentEvent) {
      return;
    }
    const button = bubble.querySelector<HTMLButtonElement>('.bubble-leave')!;
    button.disabled = true;
    bubbleMessage = '';
    let accepted = false;
    void api(`/gatherings/${currentEvent.id.replace(/^sent:/, '')}/leave`, { method: 'POST' }).then(async () => {
      accepted = true;
      bubble.hidden = true;
      releaseFocus();
      await updateGroups(await api<Gathering[]>('/gatherings'), true);
    }).catch(error => {
      bubbleMessage = accepted ? '종료 요청은 보냈지만 새 상태를 확인하지 못했어요. 연결이 돌아오면 상태가 갱신돼요.' : error instanceof Error ? `${error.message} 다시 눌러 종료할 수 있어요.` : '함께하기를 끝내지 못했어요. 다시 눌러 주세요.';
      bubble.hidden = false;
      bubbleUntil = Date.now() + 12000;
    }).finally(() => {
      button.disabled = false;
    });
  };
  const browserGroups = (event: Event): void => void updateGroups((event as CustomEvent<Gathering[]>).detail);
  window.addEventListener('gatherings-changed', browserGroups);
  const unlistenGroups = isTauri() ? await listen<Gathering[]>('gatherings-changed', event => void updateGroups(event.payload)) : (): void => {};
  // 늦게 열린 펫 창도 현재 모집을 한 번 읽고 이후에는 실시간 상태 공유를 따른다.
  if ((targetID || (preview && isTauri())) && session() && session()?.principal.petRegistered !== false) {
    const bootstrapAccount = `${serverURL()}/${session()?.token}`;
    const bootstrapFingerprint = groupFingerprint;
    void api<Gathering[]>('/gatherings').then(next => {
      if (!stopped && bootstrapAccount === `${serverURL()}/${session()?.token}` && bootstrapFingerprint === groupFingerprint) {
        return updateGroups(next);
      }
    }).catch(console.error);
  }
  // 두 펫 중 자신의 표현에 해당하는 창은 같은 시점에 반응을 재생한다.
  function reactPair(pair: PairReaction): void {
    const displayedID = targetID || session()?.principal.petId;
    if (displayedID === pair.fromID || displayedID === pair.toID) {
      if (composer.visible() || recruitment.visible() || keyboardFocus || !menu.hidden) {
        return;
      }
      reactionStart = pair.startedAtUnixMs || Date.now();
      reactUntil = reactionStart + (pair.approachMs || 800) + (pair.holdMs || 1400) + (pair.returnMs || 1000);
      pairedReaction = true;
      gesture = pair.body;
      mirroredGesture = pair.leftID ? displayedID !== pair.leftID : displayedID === pair.toID;
      menu.hidden = true;
      reaction.textContent = pair.body === 'highfive' ? '🙌 같이 하이파이브!' : '👋 서로 인사해요!';
    }
  }
  const browserPair = (event: Event): void => reactPair((event as CustomEvent<PairReaction>).detail);
  window.addEventListener('pair-reaction', browserPair);
  const unlistenPair = isTauri() ? await listen<PairReaction>('pair-reaction', event => reactPair(event.payload)) : (): void => {};
  // 전송 성공은 내 펫에서 즉시 확인하되 수신 이력이나 실제 대상에 추가하지 않는다.
  function outgoing(event: PetEvent): void {
    if (targetID || !event.outgoing || event.sender?.petId !== session()?.principal.petId) {
      return;
    }
    menu.hidden = true;
    bubble.hidden = true;
    prioritize(event);
    currentEvent = event;
    if (event.proposalKind && session()) {
      void updateGroups([{ id: event.id.replace(/^sent:/, ''), hostPetId: session()!.principal.petId, kind: event.proposalKind, status: 'open', members: [], expiresAt: Date.now() + 30 * 60 * 1000 }], true).then(async () => updateGroups(await api<Gathering[]>('/gatherings'), true)).catch(console.error);
    }
  }
  const browserOutgoing = (event: Event): void => outgoing((event as CustomEvent<PetEvent>).detail);
  window.addEventListener('outgoing-message', browserOutgoing);
  const unlistenOutgoing = isTauri() ? await listen<PetEvent>('outgoing-message', event => outgoing(event.payload)) : (): void => {};
  // 현재 수신자와 표시 중인 발신자가 모두 일치하는 친구 창만 본문을 받는다.
  const unlistenSenderBubble = isTauri() && !preview && targetID ? await ownWindow!.listen<{ recipientPetId: string; message: PetEvent }>('sender-message-bubble', event => {
    const routed = event.payload;
    if (!stopped && routed.recipientPetId === session()?.principal.petId && routed.message.sender?.petId === targetID && routed.message.type === 'message' && routed.message.kind === 'text' && !routed.message.outgoing) {
      receive(routed.message);
    }
  }) : (): void => {};
  if (isTauri() && !preview && targetID) {
    await invoke('register_message_bubbles', { ready: true });
  }
  bubble.querySelector<HTMLButtonElement>('.bubble-reply')!.onclick = () => {
    if (!currentEvent?.sender || currentEvent.outgoing || currentEvent.type !== 'message') {
      return;
    }
    bubble.hidden = true;
    void composer.open('text', currentEvent.sender.petId, { id: currentEvent.id, body: currentEvent.body, sender: currentEvent.sender.userName });
  };
  // 운영체제의 동작 줄이기를 각 투명 창의 자동 이동에도 적용한다.
  function syncMotion(): void {
    if (isTauri() && !preview) {
      void invoke('set_motion_preference', { reduced: motionPreference.matches }).catch(console.error);
    }
  }
  motionPreference.addEventListener('change', syncMotion);
  syncMotion();
  const unlistenCancelled = isTauri() ? await ownWindow!.listen('pair-motion-cancelled', () => {
    reactUntil = 0;
    reaction.hidden = true;
    motion.stop();
  }) : (): void => {};
  const unlistenMotion = isTauri() ? await ownWindow!.listen<{ walking: boolean; direction: number; distance?: number; speed?: number; timestamp?: number }>('pet-motion', event => {
    walking = event.payload.walking;
    direction = event.payload.direction;
    if (Number.isFinite(event.payload.distance)) {
      nativeDistance = event.payload.distance;
    }
    nativeSpeed = Math.abs(event.payload.speed || 0);
  }) : (): void => {};
  const unlistenElevation = isTauri() && !preview ? await ownWindow!.listen<{ height: number; carried: boolean; landing: number; sequence: number }>('pet-elevation', event => {
    if (!Number.isFinite(event.payload.sequence) || event.payload.sequence <= elevationSequence) {
      return;
    }
    elevationSequence = event.payload.sequence;
    liftHeight = Math.max(0, event.payload.height || 0);
    carried = event.payload.carried;
    landing = Math.max(0, Math.min(1, event.payload.landing || 0));
    if (!carried && dragging) {
      down = undefined;
      dragging = false;
    }
  }) : (): void => {};
  const unlistenDisplay = await watchDisplay(preferences => {
    if (!preferences.visible || (targetID && !preferences.showOthers)) {
      composer.close();
      recruitment.close();
      menu.hidden = true;
      releaseFocus();
    }
    if (petSize !== preferences.petSize) {
      petSize = preferences.petSize;
      void fitContent();
    }
    root.dataset.ownOnly = String(!preferences.showOthers);
  });
  const unlistenDismiss = isTauri() ? await ownWindow!.listen('dismiss-pet-menu', () => {
    menu.hidden = true;
    composer.close();
    recruitment.close();
    releaseFocus();
    if (!connectionNotice.hidden) {
      connectionDismissed = true;
      connectionNotice.hidden = true;
    }
    canvas.setAttribute('aria-expanded', 'false');
  }) : (): void => {};
  // 브라우저 미리보기에서는 페이지 배경 클릭으로 같은 메뉴를 닫는다.
  function dismissBackground(event: PointerEvent): void {
    if (!root.contains(event.target as Node) || event.target === root) {
      menu.hidden = true;
      composer.close();
      recruitment.close();
      releaseFocus();
      canvas.setAttribute('aria-expanded', 'false');
    }
  }
  document.addEventListener('pointerdown', dismissBackground);
  // 트레이 명령과 명시적 재시도만 입력 포커스나 연결을 변경한다.
  const focusMenu = (): void => void focusOverlay('menu').catch(console.error);
  const focusBubble = (): void => void focusOverlay('bubble').catch(console.error);
  const retry = (): void => {
    if (!targetID && !preview) {
      void retryConnection().catch(error => publishConnection(error instanceof Error ? error.message : '다시 연결하지 못했어요.'));
    }
  };
  const unlistenFocusMenu = isTauri() ? await ownWindow!.listen('focus-pet-menu', focusMenu) : (): void => {};
  const unlistenFocusBubble = isTauri() ? await ownWindow!.listen('focus-live-bubble', focusBubble) : (): void => {};
  const unlistenRetry = isTauri() ? await ownWindow!.listen('retry-pet-connection', retry) : (): void => {};
  window.addEventListener('retry-pet-connection', retry);
  const resize = (): void => void fitContent();
  window.addEventListener('resize', resize);
  window.addEventListener('blur', releaseFocus);
  void fitContent();
  const localReceived = new Set<string>();
  let drainingLocal = false;
  // 이 PC의 개인 알림은 서버나 친구 창을 거치지 않고 내 펫에서만 확인한다.
  async function drainLocal(): Promise<void> {
    if (stopped || drainingLocal || !isTauri() || preview || targetID) {
      return;
    }
    drainingLocal = true;
    try {
      const events = await invoke<PetEvent[]>('local_notifications', { pending: true });
      for (const event of events) {
        if (!localReceived.has(event.id) && event.expiresAt > Date.now()) {
          receive(event);
          localReceived.add(event.id);
        }
        await invoke('local_ack_notification', { id: event.id });
      }
      if (localReceived.size > 10000) {
        localReceived.clear();
      }
    } finally {
      drainingLocal = false;
    }
  }
  const unlistenLocal = isTauri() && !preview && !targetID ? await listen('local-notifications-ready', () => void drainLocal().catch(console.error)) : (): void => {};
  const localTimer = setInterval(() => void drainLocal().catch(console.error), 2000);
  void drainLocal().catch(console.error);
  return () => {
    stopped = true;
    composer.dispose();
    menuMessage.dispose();
    recruitment.dispose();
    releaseFocus();
    motion.dispose();
    root.removeEventListener('keydown', escapeMenu);
    disconnect();
    clearInterval(refreshTimer);
    unlisten();
    unlistenPair();
    unlistenOutgoing();
    unlistenSenderBubble();
    if (isTauri() && !preview && targetID) {
      void invoke('register_message_bubbles', { ready: false }).catch(() => {});
    }
    unlistenCancelled();
    unlistenMotion();
    unlistenElevation();
    unlistenHover();
    unlistenDisplay();
    unlistenDismiss();
    unlistenGroups();
    unlistenFocusMenu();
    unlistenFocusBubble();
    unlistenRetry();
    window.removeEventListener('retry-pet-connection', retry);
    window.removeEventListener('resize', resize);
    window.removeEventListener('blur', releaseFocus);
    document.removeEventListener('pointerdown', dismissBackground);
    window.removeEventListener('gatherings-changed', browserGroups);
    motionPreference.removeEventListener('change', syncMotion);
    window.removeEventListener('outgoing-message', browserOutgoing);
    unlistenLocal();
    clearInterval(localTimer);
    window.removeEventListener('pair-reaction', browserPair);
    if (imageURL) {
      URL.revokeObjectURL(imageURL);
    }
  };
}
