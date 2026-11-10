import { displayPreferences, updateDisplay, watchDisplay, type DesktopPreferences } from './preferences';
import './pet-display-settings.css';

export interface PetDisplaySettings {
  // 실제 펫 등록 상태로 표시 버튼의 사용 가능 여부를 갱신한다.
  setRegistered(registered: boolean): void;
  // 화면 구독과 입력을 해제하고 대기 중인 크기 설정을 저장한다.
  dispose(): void;
}

// 이 PC의 펫 표시·크기를 설정 본문에서 조절하고 트레이와 같은 상태를 사용한다.
export function mountPetDisplaySettings(root: HTMLElement, sizeRoot: HTMLElement, onError: (message: string) => void): PetDisplaySettings {
  // 1. 초기 조회와 무관하게 입력을 만들고 등록 전에는 표시 버튼만 제한한다.
  let disposed = false;
  let registered = false;
  let ready = false;
  let initializing = false;
  let activeToggle: 'visible' | 'showOthers' | undefined;
  let preferences: DesktopPreferences = { visible: true, showOthers: true, petSize: 160 };
  let pendingSize: number | undefined;
  let inFlightSize: number | undefined;
  let persistingSize = false;
  let flushRequested = false;
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  let sizeFrame: number | undefined;
  let unwatch: (() => void) | undefined;
  let problem = '';
  const id = `pet-display-${crypto.randomUUID()}`;
  root.classList.add('pet-display-settings');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '펫 표시');
  root.innerHTML = `<div class="pet-display-toolbar"><button type="button" class="display-toggle" data-display-visible disabled>펫 숨기기</button><button type="button" class="display-toggle" data-display-others disabled>내 펫만 보기</button></div>
    <p class="fine" id="${id}-note" data-display-note role="status">화면 설정을 불러오는 중이에요.</p>
    <button type="button" class="quiet" data-display-retry hidden>화면 설정 다시 불러오기</button>`;
  sizeRoot.innerHTML = `<label class="pet-preview-control" for="${id}-size"><span>펫 크기</span><span class="pet-preview-size"><input id="${id}-size" type="range" min="80" max="240" step="4" value="160" aria-describedby="${id}-note" disabled><output id="${id}-output" for="${id}-size">160px</output></span></label>`;
  const visible = root.querySelector<HTMLButtonElement>('[data-display-visible]')!;
  const others = root.querySelector<HTMLButtonElement>('[data-display-others]')!;
  const range = sizeRoot.querySelector<HTMLInputElement>('input[type=range]')!;
  const output = sizeRoot.querySelector<HTMLOutputElement>('output')!;
  const note = root.querySelector<HTMLElement>('[data-display-note]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-display-retry]')!;

  // 확정된 표시 상태와 저장 중인 최신 크기를 함께 표시한다.
  function render(): void {
    if (disposed) {
      return;
    }
    // 1. 등록 여부와 저장 상태를 버튼 권한 및 눌림 상태에 함께 반영한다.
    visible.disabled = others.disabled = !ready || !registered || !!activeToggle;
    range.disabled = !ready;
    visible.textContent = preferences.visible ? '펫 숨기기' : '펫 표시';
    others.textContent = preferences.showOthers ? '내 펫만 보기' : '친구 펫도 보기';
    visible.setAttribute('aria-pressed', String(preferences.visible));
    others.setAttribute('aria-pressed', String(!preferences.showOthers));
    visible.setAttribute('aria-busy', String(activeToggle === 'visible'));
    others.setAttribute('aria-busy', String(activeToggle === 'showOthers'));

    // 2. 미저장 크기는 유지하고 로딩·오류 상태가 있을 때만 별도로 안내한다.
    const size = pendingSize ?? inFlightSize ?? preferences.petSize;
    range.value = String(size);
    range.setAttribute('aria-valuetext', `${size}픽셀`);
    output.textContent = `${size}px`;
    note.textContent = problem || (!ready ? '화면 설정을 불러오는 중이에요.' : '');
    note.hidden = !note.textContent;
    note.classList.toggle('error', !!problem);
    retry.hidden = ready || !problem;
    retry.disabled = initializing;
  }

  // 화면을 벗어나도 마지막 저장 실패는 공통 오류 안내로 전달한다.
  function report(message: string): void {
    problem = message;
    render();
    onError(message);
  }

  // 트레이가 바뀐 값을 반영하되 아직 저장하지 않은 슬라이더 선택은 보존한다.
  function receive(value: DesktopPreferences): void {
    if (disposed) {
      return;
    }
    preferences = value;
    ready = true;
    render();
  }

  // 화면 수명 중 한 번 구독하고 실패 시 명시적인 재시도로 다시 연결한다.
  async function initialize(): Promise<void> {
    // 1. 중복 초기화를 막고 재시도 상태를 준비한다.
    if (disposed || initializing) {
      return;
    }
    initializing = true;
    problem = '';
    render();

    // 2. 구독 도착 전에 화면이 해제돼도 반환된 해제 함수를 즉시 실행한다.
    try {
      const stop = await watchDisplay(receive);
      if (disposed) {
        stop();
        return;
      }
      unwatch?.();
      unwatch = stop;
    } catch {
      if (!disposed) {
        report('화면 설정을 불러오지 못했어요. 다시 불러오기를 눌러 주세요.');
      }
    } finally {
      initializing = false;
      render();
    }
  }

  // 버튼 요청은 직렬화하고 현재 트레이 상태를 읽은 뒤 해당 옵션만 반전한다.
  async function toggle(field: 'visible' | 'showOthers'): Promise<void> {
    // 1. 중복 클릭과 등록 전 동작을 막고 서버 계정과 독립적인 PC 설정만 읽는다.
    if (disposed || !ready || !registered || activeToggle) {
      return;
    }
    activeToggle = field;
    problem = '';
    render();
    try {
      const actual = await displayPreferences();
      if (disposed || !registered) {
        return;
      }

      // 2. 부분 설정만 저장하고 네이티브 이벤트가 늦어도 확정된 상태를 다시 읽는다.
      const patch = field === 'visible' ? { visible: !actual.visible } : { showOthers: !actual.showOthers };
      await updateDisplay(patch);
      receive(await displayPreferences());
    } catch {
      report(field === 'visible' ? '펫 표시 변경을 확인하지 못했어요. 다시 시도해 주세요.' : '친구 펫 표시 변경을 확인하지 못했어요. 다시 시도해 주세요.');
    } finally {
      activeToggle = undefined;
      render();
    }
  }

  // 크기를 즉시 미리 반영하고 요청 순서를 보존하며 마지막 선택만 파일로 저장한다.
  async function flushSize(): Promise<void> {
    // 1. 저장 중인 요청은 유지하고 새 선택을 같은 저장 루프에 이어 붙인다.
    if (persistingSize) {
      return;
    }
    persistingSize = true;

    // 2. 연속 입력은 파일 저장을 생략하고 조작 종료나 입력 휴지 시점에만 확정한다.
    try {
      while (pendingSize !== undefined || flushRequested) {
        const size = pendingSize ?? preferences.petSize;
        const persist = flushRequested;
        pendingSize = undefined;
        flushRequested = false;
        inFlightSize = size;
        render();
        try {
          await updateDisplay({ petSize: size }, persist);
          preferences = persist ? await displayPreferences() : { ...preferences, petSize: size };
        } catch {
          try {
            preferences = await displayPreferences();
          } catch {
            // 재조회도 실패하면 마지막 확인값을 사용하고 사용자의 새 선택은 보존한다.
          }
          report('펫 크기 변경을 확인하지 못했어요. 잠시 뒤 다시 조절해 주세요.');
        } finally {
          inFlightSize = undefined;
          render();
        }
      }
    } finally {
      persistingSize = false;
    }
  }

  // 다음 화면 프레임에 실제 크기를 반영하고 입력 휴지·종료 시 마지막 크기를 저장한다.
  function changeSize(immediate: boolean): void {
    // 1. 초기 조회가 끝난 경우에만 유효한 범위의 최신 선택을 대기시킨다.
    if (disposed || !ready) {
      return;
    }
    const size = Math.max(80, Math.min(240, Math.round(Number(range.value) / 4) * 4));
    if (!Number.isFinite(size)) {
      return;
    }
    if (size !== (pendingSize ?? inFlightSize ?? preferences.petSize)) {
      pendingSize = size;
    }
    problem = '';
    clearTimeout(sizeTimer);
    sizeTimer = undefined;
    flushRequested ||= immediate;
    render();

    // 2. 연속 입력은 프레임마다 최신 값으로 전달하고 파일 저장 대기만 다시 시작한다.
    if (immediate) {
      if (sizeFrame !== undefined) {
        cancelAnimationFrame(sizeFrame);
        sizeFrame = undefined;
      }
      void flushSize();
    } else {
      if (sizeFrame === undefined) {
        sizeFrame = requestAnimationFrame(() => {
          sizeFrame = undefined;
          void flushSize();
        });
      }
      sizeTimer = setTimeout(() => {
        sizeTimer = undefined;
        flushRequested = true;
        void flushSize();
      }, 100);
    }
  }
  visible.onclick = () => void toggle('visible');
  others.onclick = () => void toggle('showOthers');
  range.oninput = () => changeSize(false);
  range.onchange = () => changeSize(true);
  retry.onclick = () => void initialize();
  render();
  void initialize();

  // 2. 등록 상태 변경과 화면 해제를 호출자에게 동기적으로 제공한다.
  return {
    // 등록 결과만 버튼 권한에 적용하고 크기 미리보기 설정은 계속 허용한다.
    setRegistered(value: boolean): void {
      registered = value;
      render();
    },
    // 구독과 입력을 해제하고 마지막 크기 선택은 진행 중인 저장 뒤에도 반영한다.
    dispose(): void {
      // 1. 화면과 연결된 입력·타이머·구독을 한 번만 정리한다.
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(sizeTimer);
      sizeTimer = undefined;
      if (sizeFrame !== undefined) {
        cancelAnimationFrame(sizeFrame);
        sizeFrame = undefined;
      }
      unwatch?.();
      unwatch = undefined;
      visible.onclick = others.onclick = retry.onclick = null;
      range.oninput = range.onchange = null;

      // 2. 진행 중인 저장이 있어도 마지막 미저장 크기까지 반영한다.
      flushRequested = true;
      void flushSize();
    },
  };
}
