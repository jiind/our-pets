import { icon } from './icons';
import type { Animation, Manifest } from './types';

interface EditorOptions {
  onChange(): void;
}

// 이름·프레임·속도를 가진 자유 애니메이션 목록과 자동 대기·걷기 연결을 편집한다.
export function mountAnimationEditor(root: HTMLElement, options: EditorOptions) {
  // 1. 등록 데이터는 안정적인 내부 ID로 연결하고 사용자 이름은 텍스트로만 표시한다.
  root.innerHTML = `<div class="pet-upload-animation-heading"><h3>애니메이션</h3><button type="button" class="icon-button icon-button-compact primary" data-add-animation aria-label="애니메이션 추가" title="애니메이션 추가">${icon('plus')}</button></div><div data-animation-list></div><div class="pet-upload-two-col" data-animation-roles hidden><label>대기할 때<select data-idle-animation aria-label="대기 애니메이션"></select></label><label>이동할 때<select data-walk-animation aria-label="걷기 애니메이션"></select></label></div><p class="fine">왼쪽 클릭하면 대기·걷기를 제외한 애니메이션 중 하나를 랜덤으로 재생해요.</p>`;
  const list = root.querySelector<HTMLElement>('[data-animation-list]')!;
  const add = root.querySelector<HTMLButtonElement>('[data-add-animation]')!;
  const idle = root.querySelector<HTMLSelectElement>('[data-idle-animation]')!;
  const walk = root.querySelector<HTMLSelectElement>('[data-walk-animation]')!;

  // 현재 이름과 내부 ID를 같은 순서로 읽어 역할 선택·미리보기 선택지에 제공한다.
  function choices(): { id: string; name: string }[] {
    return Array.from(list.querySelectorAll<HTMLElement>('[data-animation-row]')).map(row => ({ id: row.dataset.animationRow!, name: row.querySelector<HTMLInputElement>('[data-animation-name]')!.value.trim() || '이름 없는 애니메이션' }));
  }

  // 항목의 이름·삭제를 반영해 자동 재생 역할의 연결을 유효한 ID로 유지한다.
  function syncRoles(): void {
    // 1. 변경 전 역할을 기억하고 사용자 이름을 안전한 옵션 텍스트로 넣는다.
    const entries = choices();
    for (const select of [idle, walk]) {
      const previous = select.value;
      select.replaceChildren(...entries.map(entry => new Option(entry.name, entry.id)));
      if (entries.some(entry => entry.id === previous)) {
        select.value = previous;
      }
    }

    // 2. 빈 목록은 역할 선택을 숨기고 서버와 같은 최대 개수를 적용한다.
    root.querySelector<HTMLElement>('[data-animation-roles]')!.hidden = entries.length === 0;
    add.disabled = entries.length >= 32;
  }

  // 저장된 설정 또는 새 빈 항목을 같은 폼 행으로 만들고 독립적으로 수정·삭제한다.
  function append(id: string, animation: Animation): void {
    // 1. 입력 이름은 내부 ID로 연결하고 사용자 텍스트는 HTML에 보간하지 않는다.
    const row = document.createElement('section');
    row.className = 'pet-upload-animation';
    row.dataset.animationRow = id;
    row.innerHTML = `<div class="pet-upload-animation-heading"><label>애니메이션 이름<input data-animation-name maxlength="80" placeholder="예: 춤추기"></label><div class="pet-upload-animation-actions"><button type="button" class="icon-button" data-animation-remove>${icon('trash')}</button></div></div><div class="pet-upload-two-col"><label>칸 번호·재생 순서<input data-animation-frames placeholder="예: 0,1,2,3" pattern="[0-9, ]*"></label><label>재생 속도 (장/초)<input data-animation-fps type="number" min="1" max="24" step="1"></label></div>`;
    const name = row.querySelector<HTMLInputElement>('[data-animation-name]')!;
    name.name = `${id}Name`;
    name.value = animation.name || ({ idle: '대기', walk: '걷기', react: '반응' } as Record<string, string>)[id] || id;
    const frames = row.querySelector<HTMLInputElement>('[data-animation-frames]')!;
    frames.name = `${id}Frames`;
    frames.value = animation.frames.join(',');
    const fps = row.querySelector<HTMLInputElement>('[data-animation-fps]')!;
    fps.name = `${id}FPS`;
    fps.value = String(animation.fps);
    const remove = row.querySelector<HTMLButtonElement>('[data-animation-remove]')!;
    remove.setAttribute('aria-label', `${name.value} 애니메이션 삭제`);

    // 2. 해당 행만 제거하고 자동 역할·미리보기도 같은 변경으로 갱신한다.
    remove.onclick = () => {
      row.remove();
      syncRoles();
      options.onChange();
    };
    list.append(row);
  }

  // 구버전 세 동작 또는 새 자유 목록을 저장된 값 그대로 복원한다.
  function load(manifest: Manifest): void {
    list.replaceChildren();
    for (const [id, animation] of Object.entries(manifest.animations)) {
      if (animation) {
        append(id, animation);
      }
    }
    syncRoles();
    idle.value = manifest.idleAnimation || (manifest.animations.idle ? 'idle' : choices()[0]?.id || '');
    walk.value = manifest.walkAnimation || (manifest.animations.walk ? 'walk' : idle.value);
  }

  // 실제 프레임 개수와 서버 정책에 맞는 이름·순서·속도·역할만 직렬화한다.
  function read(count: number): Pick<Manifest, 'animations' | 'idleAnimation' | 'walkAnimation'> {
    // 1. 비어 있는 동작은 생략하고 입력한 동작만 엄격히 검증한다.
    const animations: Manifest['animations'] = Object.create(null);
    for (const row of list.querySelectorAll<HTMLElement>('[data-animation-row]')) {
      const value = row.querySelector<HTMLInputElement>('[data-animation-frames]')!.value.trim();
      if (!value) {
        continue;
      }
      const name = row.querySelector<HTMLInputElement>('[data-animation-name]')!.value.trim();
      if (!name || new TextEncoder().encode(name).length > 80) {
        throw new Error('애니메이션 이름은 1~80바이트로 입력하세요.');
      }
      if (!/^\d+(?:\s*,\s*\d+)*$/.test(value)) {
        throw new Error('칸 번호는 0부터 시작하며 쉼표로 구분해 재생 순서대로 입력하세요.');
      }
      const frames = value.split(',').map(item => Number(item.trim()));
      const fps = Number(row.querySelector<HTMLInputElement>('[data-animation-fps]')!.value);
      if (frames.length > 256 || frames.some(frame => !Number.isInteger(frame) || frame >= count) || !Number.isInteger(fps) || fps < 1 || fps > 24) {
        throw new Error(`칸 번호는 0~${count - 1}, 재생 속도는 초당 1~24장으로 입력하세요.`);
      }
      animations[row.dataset.animationRow!] = { name, frames, fps };
    }

    // 2. 자동 역할은 프레임이 있는 항목만 가리키도록 확인한다.
    if (Object.keys(animations).length && (!animations[idle.value] || !animations[walk.value])) {
      throw new Error('대기·걷기에 사용할 애니메이션의 프레임을 입력하거나 다른 항목을 선택하세요.');
    }
    return Object.keys(animations).length ? { animations, idleAnimation: idle.value, walkAnimation: walk.value } : { animations };
  }

  // 3. 목록 추가·이름 편집은 기존 입력을 유지한 채 역할 이름과 미리보기만 갱신한다.
  add.onclick = () => {
    if (choices().length >= 32) {
      return;
    }
    append(`animation-${crypto.randomUUID()}`, { name: `애니메이션 ${choices().length + 1}`, frames: [0], fps: 8 });
    syncRoles();
    options.onChange();
    list.lastElementChild?.querySelector<HTMLInputElement>('[data-animation-name]')?.focus();
  };
  root.oninput = event => {
    const input = event.target as HTMLInputElement;
    if (input.matches('[data-animation-name]')) {
      const row = input.closest<HTMLElement>('[data-animation-row]')!;
      row.querySelector('[data-animation-remove]')!.setAttribute('aria-label', `${input.value} 애니메이션 삭제`);
      syncRoles();
    }
    options.onChange();
  };
  return { choices, load, read };
}
