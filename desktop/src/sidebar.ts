import { icon } from './icons';
import './sidebar.css';

interface SidebarPreferences {
  collapsed: boolean;
  width: number;
}

const storageKey = 'ourpets.sidebar';
const minimumWidth = 160;
const defaultWidth = 190;
const maximumWidth = 320;
const railWidth = 72;
const minimumContent = 360;

// 저장값이 손상되거나 저장소가 막혀도 기본 탐색 너비로 시작한다.
function readPreferences(): SidebarPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null') as Partial<SidebarPreferences> | null;
    return {
      collapsed: value?.collapsed === true,
      width: typeof value?.width === 'number' && Number.isFinite(value.width) ? Math.max(minimumWidth, Math.min(maximumWidth, value.width)) : defaultWidth,
    };
  } catch {
    return { collapsed: false, width: defaultWidth };
  }
}

// 현재 PC의 접힘 상태와 마지막 확장 너비를 저장하고 저장소 오류는 조작을 막지 않는다.
function savePreferences(value: SidebarPreferences): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 저장할 수 없는 환경에서도 현재 창의 탐색 조작은 계속 허용한다.
  }
}

// 기존 탐색에 접기·펼치기와 너비 조절을 붙이고 화면 수명에 맞춰 모두 해제한다.
export function mountSidebar(workspace: HTMLElement): () => void {
  // 1. 원래 DOM과 속성을 보존하고 브랜드 옆에 화면 제어와 구분선을 만든다.
  const existingSidebar = workspace.querySelector<HTMLElement>('.sidebar');
  if (!existingSidebar) {
    return () => undefined;
  }
  const sidebar = existingSidebar;
  let disposed = false;
  let preferences = readPreferences();
  let drag: { pointerId: number; startX: number; startWidth: number; original: SidebarPreferences; moved: boolean } | undefined;
  const oldWidth = workspace.style.getPropertyValue('--sidebar-width');
  const oldPriority = workspace.style.getPropertyPriority('--sidebar-width');
  const oldCollapsed = workspace.getAttribute('data-sidebar-collapsed');
  const oldResizing = workspace.getAttribute('data-sidebar-resizing');
  const brand = sidebar.querySelector<HTMLElement>('.brand');
  const brandParent = brand?.parentNode;
  const brandNext = brand?.nextSibling;
  const heading = document.createElement('div');
  heading.className = 'sidebar-heading';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sidebar-toggle';
  const handle = document.createElement('div');
  handle.className = 'sidebar-resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '탐색 메뉴 너비');
  handle.title = '드래그하거나 좌우 방향키로 너비 조절 · Home 최소 · End 최대';
  sidebar.prepend(heading);
  if (brand) {
    heading.append(brand);
  }
  heading.append(toggle);
  sidebar.append(handle);
  const labelChanges = new Map<HTMLElement, { original: string | null; applied: string }>();
  const named = sidebar.querySelectorAll<HTMLElement>('.brand, nav button, .sidebar-bottom button');
  named.forEach(element => {
    if (!element.hasAttribute('aria-label')) {
      const label = element.textContent?.trim() || element.title || '우리 펫';
      labelChanges.set(element, { original: null, applied: label });
      element.setAttribute('aria-label', label);
    }
  });

  // 본문 최소 너비를 보존하며 현재 창에서 허용할 탐색 확장 범위를 계산한다.
  function availableWidth(): number {
    const width = workspace.clientWidth || window.innerWidth;
    const gap = Number.parseFloat(getComputedStyle(workspace).columnGap) || 0;
    return Math.min(maximumWidth, Math.floor(width - minimumContent - gap));
  }

  // 저장한 확장 너비는 보존하면서 실제 창에 맞는 너비와 접근 가능한 상태만 갱신한다.
  function render(): void {
    if (disposed) {
      return;
    }
    // 1. 지나치게 좁은 창에서는 임시로 접고 넓어지면 원래 확장 선택을 복원한다.
    const maximum = availableWidth();
    const constrained = maximum < minimumWidth;
    const collapsed = preferences.collapsed || constrained;
    const width = collapsed ? railWidth : Math.max(minimumWidth, Math.min(maximum, preferences.width));
    workspace.style.setProperty('--sidebar-width', `${width}px`);
    workspace.dataset.sidebarCollapsed = String(collapsed);
    workspace.dataset.sidebarResizing = String(!!drag);

    // 2. 아이콘 버튼과 구분선은 시각 상태와 같은 펼침·너비 정보를 제공한다.
    toggle.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-left');
    toggle.title = constrained ? '창을 넓히면 탐색 메뉴를 펼칠 수 있어요' : collapsed ? '탐색 메뉴 펼치기' : '탐색 메뉴 접기';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.disabled = constrained;
    handle.tabIndex = constrained ? -1 : 0;
    handle.setAttribute('aria-disabled', String(constrained));
    handle.setAttribute('aria-valuemin', String(collapsed ? railWidth : minimumWidth));
    handle.setAttribute('aria-valuemax', String(Math.max(railWidth, maximum)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', collapsed ? '접힌 탐색 메뉴' : `${width}픽셀`);
  }

  // 접기와 펼치기는 마지막 확장 너비를 변경하지 않고 상태만 저장한다.
  function toggleCollapsed(): void {
    if (disposed || availableWidth() < minimumWidth) {
      return;
    }
    finishResize(true);
    preferences.collapsed = !preferences.collapsed;
    render();
    savePreferences(preferences);
  }

  // 드래그를 확정하거나 취소한 뒤 포인터 캡처와 임시 전역 리스너를 정리한다.
  function finishResize(commit: boolean): void {
    // 1. 캡처 해제 이벤트가 다시 들어와도 같은 조작을 두 번 처리하지 않는다.
    const current = drag;
    if (!current) {
      return;
    }
    drag = undefined;
    window.removeEventListener('pointermove', pointerMove);
    window.removeEventListener('pointerup', pointerUp);
    window.removeEventListener('pointercancel', pointerCancel);
    try {
      if (handle.hasPointerCapture(current.pointerId)) {
        handle.releasePointerCapture(current.pointerId);
      }
    } catch {
      // OS가 먼저 캡처를 끝냈다면 나머지 입력과 상태 정리만 계속한다.
    }

    // 2. 취소는 시작 상태로 복귀하고 완료한 실제 변경만 저장한다.
    if (!commit) {
      preferences = current.original;
    }
    render();
    if (commit && current.moved) {
      savePreferences(preferences);
    }
  }

  // 주 포인터로 구분선을 잡으면 현재 실제 너비에서 조절을 시작한다.
  function pointerDown(event: PointerEvent): void {
    if (disposed || drag || event.button !== 0 || !event.isPrimary || availableWidth() < minimumWidth) {
      return;
    }
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width, original: { ...preferences }, moved: false };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 캡처가 제공되지 않아도 같은 창의 포인터 이벤트로 조절을 마무리한다.
    }
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    render();
  }

  // 구분선의 이동량만 반영하고 본문을 침범하지 않는 확장 범위로 제한한다.
  function pointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (availableWidth() < minimumWidth) {
      finishResize(false);
      return;
    }
    const difference = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(difference) < 4) {
      return;
    }
    event.preventDefault();
    drag.moved = true;
    preferences.collapsed = false;
    preferences.width = Math.max(minimumWidth, Math.min(availableWidth(), drag.startWidth + difference));
    render();
  }

  // 시작한 포인터가 끝났을 때만 새 너비를 확정한다.
  function pointerUp(event: PointerEvent): void {
    if (drag?.pointerId === event.pointerId) {
      finishResize(true);
    }
  }

  // 포인터 조작이 중단되면 이전 접힘 상태와 확장 너비로 복귀한다.
  function pointerCancel(event: PointerEvent): void {
    if (drag?.pointerId === event.pointerId) {
      finishResize(false);
    }
  }

  // 키보드에서도 조절·최소·최대 너비를 사용하고 진행 중 드래그를 취소할 수 있게 한다.
  function keyDown(event: KeyboardEvent): void {
    // 1. Escape는 드래그만 취소하고 그 외 키는 조절 가능한 창에서 처리한다.
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finishResize(false);
      return;
    }
    if (drag) {
      return;
    }
    const maximum = availableWidth();
    if (disposed || maximum < minimumWidth || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    // 2. 접힌 상태의 오른쪽 키는 마지막 확장 너비를 복원한다.
    const actual = Math.max(minimumWidth, Math.min(maximum, preferences.width));
    if (preferences.collapsed) {
      if (event.key === 'ArrowLeft' || event.key === 'Home') {
        return;
      }
      preferences.collapsed = false;
      if (event.key === 'End') {
        preferences.width = maximum;
      }
    } else {
      preferences.width = event.key === 'Home' ? minimumWidth : event.key === 'End' ? maximum : Math.max(minimumWidth, Math.min(maximum, actual + (event.key === 'ArrowRight' ? 16 : -16)));
    }
    render();
    savePreferences(preferences);
  }

  // 창이나 컨테이너 크기가 바뀌면 저장된 선호 너비를 현재 범위로 다시 제한한다.
  function layoutChanged(): void {
    render();
  }

  // 다른 창으로 전환하면 중단된 드래그를 시작 상태로 되돌린다.
  function windowBlurred(): void {
    finishResize(false);
  }
  toggle.addEventListener('click', toggleCollapsed);
  handle.addEventListener('pointerdown', pointerDown);
  handle.addEventListener('lostpointercapture', pointerCancel);
  handle.addEventListener('keydown', keyDown);
  window.addEventListener('resize', layoutChanged);
  window.addEventListener('blur', windowBlurred);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(layoutChanged);
  observer?.observe(workspace);
  render();

  // 2. 전역 리스너·관찰자·임시 DOM을 해제하고 원래 탐색 마크업과 속성을 복원한다.
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    finishResize(false);
    toggle.removeEventListener('click', toggleCollapsed);
    handle.removeEventListener('pointerdown', pointerDown);
    handle.removeEventListener('lostpointercapture', pointerCancel);
    handle.removeEventListener('keydown', keyDown);
    window.removeEventListener('resize', layoutChanged);
    window.removeEventListener('blur', windowBlurred);
    observer?.disconnect();
    labelChanges.forEach((label, element) => {
      if (element.getAttribute('aria-label') === label.applied) {
        element.removeAttribute('aria-label');
      }
    });
    if (brand && brandParent) {
      brandParent.insertBefore(brand, brandNext && brandNext.parentNode === brandParent ? brandNext : null);
    }
    heading.remove();
    handle.remove();
    if (oldWidth) {
      workspace.style.setProperty('--sidebar-width', oldWidth, oldPriority);
    } else {
      workspace.style.removeProperty('--sidebar-width');
    }
    if (oldCollapsed === null) {
      workspace.removeAttribute('data-sidebar-collapsed');
    } else {
      workspace.setAttribute('data-sidebar-collapsed', oldCollapsed);
    }
    if (oldResizing === null) {
      workspace.removeAttribute('data-sidebar-resizing');
    } else {
      workspace.setAttribute('data-sidebar-resizing', oldResizing);
    }
  };
}
