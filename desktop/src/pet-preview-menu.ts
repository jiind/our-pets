import { icon } from './icons';
import type { Gesture } from './motion';

export type PetPreviewAction = 'idle' | 'walk' | Gesture;

// 미리보기 Canvas의 우클릭·키보드 메뉴에서 로컬 재생 동작만 선택한다.
export function mountPetPreviewMenu(canvas: HTMLCanvasElement, stage: HTMLElement, onSelect: (action: PetPreviewAction) => void): { close: () => void; dispose: () => void } {
  // 1. 실제 펫의 메시지·모집과 분리된 동작 메뉴와 접근성 연결을 만든다.
  const entries: { action: PetPreviewAction; label: string }[] = [
    { action: 'idle', label: '대기' },
    { action: 'walk', label: '걷기' },
    { action: 'wave', label: '👋 인사하기' },
    { action: 'highfive', label: '🙌 하이파이브' },
  ];
  const menu = document.createElement('div');
  const menuID = `pet-preview-menu-${crypto.randomUUID()}`;
  menu.className = 'pet-preview-menu';
  menu.id = menuID;
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '펫 동작 미리보기');
  menu.innerHTML = `<div class="pet-preview-menu-heading"><span>동작 미리보기</span><button type="button" class="menu-close" role="menuitem" aria-label="동작 미리보기 메뉴 닫기">${icon('close')}</button></div><div class="pet-preview-menu-actions">${entries.map(entry => `<button type="button" role="menuitem" data-preview-gesture="${entry.action}">${entry.label}</button>`).join('')}</div>`;
  stage.append(menu);
  canvas.setAttribute('role', 'button');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-haspopup', 'menu');
  canvas.setAttribute('aria-controls', menuID);
  canvas.setAttribute('aria-expanded', 'false');
  canvas.setAttribute('aria-keyshortcuts', 'Enter Space Shift+F10');
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
  let press: { x: number; y: number; id: number } | undefined;

  // 실제 펫과 동일하게 미리보기의 왼쪽 클릭 시작 위치만 기록한다.
  function startPat(event: PointerEvent): void {
    press = event.button === 0 && !event.ctrlKey ? { x: event.screenX, y: event.screenY, id: event.pointerId } : undefined;
  }

  // 이동하거나 취소한 포인터를 제외하고 미리보기 쓰다듬기만 재생한다.
  function finishPat(event: PointerEvent): void {
    const tapped = event.type === 'pointerup' && event.button === 0 && press?.id === event.pointerId && Math.hypot(event.screenX - press.x, event.screenY - press.y) <= 6;
    press = undefined;
    if (tapped) {
      close();
      onSelect('pat');
    }
  }

  // 미리보기의 다른 입력을 방해하지 않고 필요할 때만 펫으로 포커스를 돌린다.
  function close(restoreFocus = false): void {
    const wasOpen = !menu.hidden;
    menu.hidden = true;
    stage.classList.remove('preview-menu-open');
    canvas.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus && canvas.isConnected && !canvas.hidden) {
      canvas.focus({ preventScroll: true });
    }
  }

  // 표시 중인 펫의 동작 메뉴를 열고 첫 동작부터 키보드로 고를 수 있게 한다.
  function open(): void {
    if (canvas.hidden) {
      return;
    }
    menu.hidden = false;
    stage.classList.add('preview-menu-open');
    canvas.setAttribute('aria-expanded', 'true');
    buttons[1].focus({ preventScroll: true });
  }

  // 브라우저 기본 컨텍스트 메뉴 대신 해당 미리보기의 동작 선택을 연다.
  function contextMenu(event: MouseEvent): void {
    event.preventDefault();
    open();
  }

  // 펫에 포커스가 있으면 표준 키로 같은 동작 메뉴를 연다.
  function canvasKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      open();
    }
  }

  // 검증된 동작만 호출하고 선택한 즉시 메뉴를 닫아 펫의 반응을 보여 준다.
  function choose(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-preview-gesture]') : null;
    const entry = entries.find(item => item.action === target?.dataset.previewGesture);
    close(true);
    if (entry) {
      onSelect(entry.action);
    }
  }

  // 메뉴의 방향키 순환과 Escape 닫기를 처리하고 Tab은 기본 탐색을 유지한다.
  function menuKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  }

  // 배경을 누르면 해당 입력의 포커스를 유지하며 미리보기 메뉴만 닫는다.
  function outsidePointer(event: PointerEvent): void {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  }

  // 메뉴 밖으로 키보드 포커스가 이동하면 입력을 가로막지 않고 닫는다.
  function focusOut(event: FocusEvent): void {
    if (!menu.contains(event.relatedTarget as Node | null)) {
      close();
    }
  }

  // 창을 떠나거나 닫을 때 펫 동작 메뉴를 해제한다.
  function windowBlur(): void {
    close();
  }

  // 2. 메뉴 입력은 이 Canvas에만 연결하고 전역 닫기 구독은 화면 수명에 묶는다.
  canvas.addEventListener('contextmenu', contextMenu);
  canvas.addEventListener('pointerdown', startPat);
  canvas.addEventListener('pointerup', finishPat);
  canvas.addEventListener('pointercancel', finishPat);
  canvas.addEventListener('keydown', canvasKeyDown);
  menu.addEventListener('click', choose);
  menu.addEventListener('keydown', menuKeyDown);
  menu.addEventListener('focusout', focusOut);
  document.addEventListener('pointerdown', outsidePointer, true);
  window.addEventListener('blur', windowBlur);

  return {
    close,
    // 미리보기 화면이 사라지면 전역 구독과 이 메뉴의 DOM을 함께 정리한다.
    dispose(): void {
      close();
      canvas.removeEventListener('contextmenu', contextMenu);
      canvas.removeEventListener('pointerdown', startPat);
      canvas.removeEventListener('pointerup', finishPat);
      canvas.removeEventListener('pointercancel', finishPat);
      canvas.removeEventListener('keydown', canvasKeyDown);
      menu.removeEventListener('click', choose);
      menu.removeEventListener('keydown', menuKeyDown);
      menu.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', outsidePointer, true);
      window.removeEventListener('blur', windowBlur);
      menu.remove();
    },
  };
}
