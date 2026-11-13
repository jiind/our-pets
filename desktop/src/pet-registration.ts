import { api, designImage, serverURL, session } from './api';
import { drawPet, loadImage } from './render';
import { watchDisplay } from './preferences';
import { icon } from './icons';
import type { Design, RegisteredPet } from './types';
import './pet-registration.css';
import { mountPetDisplaySettings } from './pet-display-settings';
import { mountPetUpload } from './pet-upload';
import { petMotion, type Gesture } from './motion';
import { mountPetPreviewMenu, type PetPreviewAction } from './pet-preview-menu';
import { builtinPets, builtinID, petSelection, builtinCredits } from './builtin-pets';
import { animationKey, randomClickAnimation } from './pet-animations';

export interface PetRegistrationOptions {
  onRegistered: (pet: RegisteredPet) => void | Promise<void>;
}

type PreviewAction = 'idle' | 'walk' | 'react';

// 계정 닉네임을 사용하는 대표 펫의 외형을 등록하거나 변경하는 화면을 구성한다.
export async function mountPetRegistration(root: HTMLElement, options: PetRegistrationOptions): Promise<() => void> {
  // 1. 서버 등록 상태와 무관한 미리보기·입력 자원을 화면 수명에 묶는다.
  let disposed = false;
  let busy = false;
  let autosaving = false;
  let autosavePending = false;
  let draftRevision = 0;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pet: RegisteredPet | undefined;
  let designs: Design[] = [];
  let catalogueProblem = '';
  let catalogueMutation = false;
  let selectedDesignID = 'default';
  let catalogueVersion = 0;
  let catalogueRequests = 0;
  let petSize = 160;
  let loadVersion = 0;
  let previewVersion = 0;
  let previewImage: HTMLImageElement | null = null;
  let previewDesign: Design | null = null;
  let previewProblem = '';
  let previewReady = true;
  let actionStarted = Date.now();
  let previewGesture: Gesture = 'wave';
  let previewAnimationId: string | undefined;
  let previewEndsAt = 0;
  let unwatch = (): void => {};
  const urls = new Set<string>();
  const savedImages = new Map<string, HTMLImageElement>();
  const account = `${serverURL()}/${session()?.token || ''}`;
  const id = `pet-registration-${crypto.randomUUID()}`;
  root.classList.add('pet-registration');
  root.innerHTML = `<header class="pet-registration-heading" data-registration-heading><h2 data-registration-title>내 펫 등록</h2><p data-registration-intro>캐릭터를 고르면 내 데스크톱에서 함께할 수 있어요.</p></header>
    <p class="pet-registration-status" data-status role="status" aria-live="polite">등록 상태를 불러오는 중이에요.</p><button type="button" data-retry hidden>등록 상태 다시 불러오기</button><button type="button" data-retry-save hidden>다시 저장</button>
    <div class="pet-registration-toolbar"><div data-display-settings></div><div class="pet-registration-actions" data-form-actions hidden><button type="submit" form="${id}-form" class="primary" data-submit disabled>등록 완료</button></div></div>
    <div class="pet-registration-layout" data-layout hidden><section class="pet-registration-preview" aria-label="화면에 표시할 내 펫 미리보기"><div class="pet-registration-preview-heading"><h3>화면 미리보기</h3></div><div class="pet-registration-preview-stage"><div class="pet-name-anchor"><canvas width="160" height="160" role="img" aria-label="등록할 내 펫"></canvas><span class="pet-nameplate" data-preview-name></span></div></div><div data-size-control></div><label class="pet-preview-control" for="${id}-action"><span>미리보기 동작</span><select id="${id}-action" data-preview-action><option value="idle">대기</option><option value="walk">걷기</option><option value="react">반응</option></select></label><p class="fine" data-preview-note role="status"></p></section><form id="${id}-form" data-registration-form><fieldset class="pet-registration-editor" data-editor aria-label="펫 외형 선택">

      <fieldset class="pet-registration-choice" aria-labelledby="${id}-pet-choice"><div class="pet-registration-choice-heading"><span class="pet-registration-field-title" id="${id}-pet-choice">펫 선택</span><span class="pet-registration-catalogue-actions"><button type="button" class="icon-button icon-button-compact" data-refresh-designs aria-label="등록된 펫 목록 새로고침" title="등록된 펫 목록 새로고침" aria-busy="false">${icon('refresh')}</button><button type="button" class="icon-button icon-button-compact primary" data-add-pet aria-label="펫 추가" title="펫 추가">${icon('plus')}</button></span></div><div class="pet-registration-character-options" data-characters></div><p class="fine" data-catalogue-note></p><details class="builtin-credits"><summary>캐릭터 출처·라이선스</summary><p class="fine" data-builtin-credits></p></details></fieldset>
    </fieldset></form>
</div>`;
  root.querySelector<HTMLElement>('[data-builtin-credits]')!.textContent = builtinCredits;
  const form = root.querySelector<HTMLFormElement>('[data-registration-form]')!;
  const editor = root.querySelector<HTMLFieldSetElement>('[data-editor]')!;
  const submit = root.querySelector<HTMLButtonElement>('[data-submit]')!;
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const retrySave = root.querySelector<HTMLButtonElement>('[data-retry-save]')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const previewNote = root.querySelector<HTMLElement>('[data-preview-note]')!;
  const action = root.querySelector<HTMLSelectElement>('[data-preview-action]')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const previewMotion = petMotion(canvas, root);
  const previewMenu = mountPetPreviewMenu(canvas, root.querySelector<HTMLElement>('.pet-registration-preview-stage')!, playPreview);

  const displaySettings = mountPetDisplaySettings(root.querySelector<HTMLElement>('[data-display-settings]')!, root.querySelector<HTMLElement>('[data-size-control]')!, message => feedback(message, true));
  const uploadDialog = mountPetUpload(root, {
    onUpdated: async (previous, design, isCurrent) => {
      // 1. 교체된 불변 버전은 목록에서 제거하고 기존 선택만 새 버전으로 옮긴다.
      assertAccount();
      catalogueVersion += 1;
      designs = [...designs.filter(item => item.id !== previous.id && item.id !== design.id), design];
      if (selectedDesignID === previous.id) {
        selectedDesignID = design.id;
      }
      if (pet?.design?.id === previous.id) {
        pet = { ...pet, design };
      }
      const revision = ++draftRevision;
      updateCatalogue();

      // 2. 서버가 반영한 대표 펫과 미리보기를 확인해 같은 기기에도 갱신한다.
      const current = await api<RegisteredPet>('/me/pet');
      assertAccount();
      if (disposed || !isCurrent() || revision !== draftRevision) {
        return;
      }
      pet = current;
      updateCatalogue();
      updateView();
      await refreshPreview();
      if (current.registered && isCurrent() && revision === draftRevision) {
        await options.onRegistered(current);
      }
    },
    onAdded: async design => {
      // 1. 새로 등록한 펫은 늦게 끝난 목록 조회와 분리해 즉시 선택지에 넣는다.
      if (disposed) {
        return;
      }
      assertAccount();
      catalogueVersion += 1;
      designs = [...designs.filter(item => item.id !== design.id), design];
      catalogueProblem = '';
      if (busy) {
        updateCatalogue();
        feedback('펫 목록에 추가했어요. 펫 선택에서 고를 수 있어요.');
        return;
      }
      selectedDesignID = design.id;
      updateCatalogue();

      // 2. 미리보기는 즉시 갱신하고 등록된 대표 펫에는 선택을 바로 저장한다.
      draftRevision += 1;
      void refreshPreview();
      if (pet?.registered) {
        requestAutosave(true);
      } else {
        feedback('목록에 추가했어요. 등록 완료를 누르면 적용돼요.');
      }
    },
  });

  // 2. 권위 있는 등록 상태와 선택 초안을 구분하는 조회·저장 동작을 준비한다.

  // 현재 로그인한 계정이 달라졌으면 이전 화면의 저장 요청을 막는다.
  function assertAccount(): void {
    if (account !== `${serverURL()}/${session()?.token || ''}`) {
      throw new Error('로그인한 계정이 바뀌었어요. 펫 설정을 다시 열어 주세요.');
    }
  }

  // 작업 결과를 해당 등록 화면에서만 읽을 수 있게 표시한다.
  function feedback(message: string, error = false): void {
    if (!disposed) {
      status.textContent = message;
      status.classList.toggle('error', error);
    }
  }

  // 이름 입력 대신 서버가 반환한 소유자의 닉네임을 사용한다.
  function draftName(): string | undefined {
    return pet?.ownerName.trim() || undefined;
  }

  // 펫 선택은 즉시 저장하고 이름 입력만 짧게 묶어 한글 조합과 연속 타이핑을 보존한다.
  function requestAutosave(immediate: boolean): void {
    // 1. 최초 등록과 해제된 화면은 자동 저장하지 않고 이전 입력 대기만 정리한다.
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    if (disposed || !pet?.registered || (!immediate && !draftName())) {
      return;
    }
    retrySave.hidden = true;

    // 2. 직접 선택·입력 종료는 바로 보내고 타이핑은 400ms 뒤 최신 초안을 보낸다.
    if (immediate) {
      autosavePending = true;
      void flushAutosave();
    } else {
      autosaveTimer = setTimeout(() => {
        autosaveTimer = undefined;
        autosavePending = true;
        void flushAutosave();
      }, 400);
    }
  }

  // 같은 대표 펫의 변경을 직렬 저장하고 이전 응답이 최신 선택·이름을 덮지 못하게 한다.
  async function flushAutosave(): Promise<void> {
    // 1. 저장 중에는 최신 변경만 대기시키고 확인한 값과 같으면 요청을 생략한다.
    if (autosaving || !pet?.registered) {
      return;
    }
    autosaving = true;
    if (!disposed) {
      updateView();
    }
    try {
      while (autosavePending && pet?.registered) {
        autosavePending = false;
        const revision = draftRevision;
        const petID = pet.id;
        const designId = selectedDesignID;
        const petName: string = draftName() || pet.name;
        if (designId === petSelection(pet) && petName === pet.name) {
          if (!disposed && revision === draftRevision) {
            retrySave.hidden = true;
            feedback('');
          }
          continue;
        }
        feedback('');
        try {
          assertAccount();
          const result: RegisteredPet = await api<RegisteredPet>('/me/pet/registration', { method: 'POST', body: JSON.stringify({ name: petName, designId }) });
          assertAccount();
          if (!result.registered || result.id !== petID) {
            throw new Error('같은 펫의 저장 상태를 확인하지 못했어요. 다시 저장해 주세요.');
          }

          // 2. 확인된 펫은 갱신하되 저장 중 사용자가 바꾼 초안과 포커스는 보존한다.
          pet = result;
          if (!disposed && revision === draftRevision) {
            updateCatalogue();
            updateView();
            retrySave.hidden = true;
            feedback('');
          }
          try {
            await options.onRegistered(result);
          } catch {
            if (revision === draftRevision) {
              feedback('저장했지만 화면 갱신을 확인하지 못했어요. 잠시 뒤 펫을 확인해 주세요.', true);
            }
          }
        } catch (error) {
          // 3. 실패한 선택을 숨기지 않고 최신 초안에서만 재시도 동작을 제공한다.
          if (!disposed && revision === draftRevision) {
            feedback(error instanceof Error ? error.message : '적용하지 못했어요. 다시 저장을 눌러 주세요.', true);
            retrySave.hidden = false;
          }
        }
      }
    } finally {
      autosaving = false;
      if (!disposed) {
        updateView();
      }
    }
  }

  // 등록 여부와 저장 상태에 맞춰 항상 열린 변경 폼과 상단 동작을 갱신한다.
  function updateView(): void {
    // 1. 등록된 펫은 바로 선택하고 최초 등록 중에만 입력을 제한한다.
    const registered = !!pet?.registered;
    root.querySelector<HTMLElement>('[data-registration-heading]')!.hidden = registered;
    canvas.setAttribute('aria-label', `${registered ? '변경할' : '등록할'} 내 펫 미리보기. 오른쪽 클릭으로 동작 메뉴 열기`);
    editor.disabled = busy || catalogueMutation;
    root.querySelector<HTMLButtonElement>('[data-add-pet]')!.disabled = busy || catalogueMutation;
    root.querySelector<HTMLElement>('[data-form-actions]')!.hidden = registered;
    submit.textContent = busy ? '등록하는 중…' : '등록 완료';
    form.setAttribute('aria-busy', String(busy || autosaving));
    submit.disabled = busy;
    submit.setAttribute('aria-busy', String(busy));
    root.querySelectorAll<HTMLButtonElement>('[data-design-action]').forEach(button => {
      button.disabled = busy || autosaving || autosavePending || catalogueMutation;
    });

    // 2. 선택한 등록 펫과 로컬 표시 설정을 현재 상태에 맞춘다.
    form.querySelectorAll<HTMLInputElement>('[name=character]').forEach(input => {
      input.checked = input.value === selectedDesignID;
    });
    displaySettings.setRegistered(registered);
    root.querySelector<HTMLElement>('[data-preview-name]')!.textContent = draftName() || '내 펫';
  }

  // 기본 캐릭터와 저장된 펫을 같은 라디오 목록으로 표시하고 현재 선택을 유지한다.
  function updateCatalogue(): void {
    // 1. 내 목록과 현재 사용 중인 외형을 안정적인 디자인 ID로 합친다.
    const choices = new Map(designs.map(design => [design.id, design]));
    if (pet?.design) {
      choices.set(pet.design.id, pet.design);
    }
    if (!builtinPets.some(option => option.selection === selectedDesignID) && !choices.has(selectedDesignID)) {
      selectedDesignID = 'default';
    }
    const counts = new Map<string, number>(builtinPets.map(option => [option.name, 1]));
    choices.forEach(design => counts.set(design.name, (counts.get(design.name) || 0) + 1));
    const entries = [...builtinPets.map(option => ({ id: option.selection, label: option.name })), ...Array.from(choices.values()).sort((first, second) => first.version - second.version).map(design => ({ id: design.id, label: `${design.name}${(counts.get(design.name) || 0) > 1 ? ` · v${design.version}` : ''}${design.ownerId !== pet?.userId ? ' · 현재 외형' : ''}` }))];

    // 2. 사용자 이름은 HTML이 아닌 텍스트로 넣고 선택과 필수 입력을 연결한다.
    const target = root.querySelector<HTMLElement>('[data-characters]')!;
    const focusedValue = target.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement ? document.activeElement.value : undefined;
    target.replaceChildren();
    for (const entry of entries) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'character';
      input.value = entry.id;
      input.required = true;
      input.checked = entry.id === selectedDesignID;
      label.append(input, document.createTextNode(entry.label));
      const row = document.createElement('div');
      row.className = 'pet-registration-character-row';
      row.append(label);
      const design = choices.get(entry.id);
      if (design && design.ownerId === pet?.userId) {
        const actions = document.createElement('span');
        actions.className = 'pet-registration-character-actions';
        for (const [action, title] of [['edit', '수정'], ['trash', '삭제']] as const) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'icon-button icon-button-compact';
          button.dataset.designAction = action;
          button.dataset.designId = design.id;
          button.setAttribute('aria-label', `${design.name} ${title}`);
          button.title = title;
          button.innerHTML = icon(action);
          button.disabled = busy || autosaving || autosavePending || catalogueMutation;
          actions.append(button);
        }
        row.append(actions);
      }
      target.append(row);
    }
    if (focusedValue) {
      Array.from(target.querySelectorAll<HTMLInputElement>('input')).find(input => input.value === focusedValue)?.focus({ preventScroll: true });
    }
    root.querySelector<HTMLElement>('[data-catalogue-note]')!.textContent = catalogueProblem || (pet?.registered ? '' : '펫을 선택한 뒤 등록 완료를 눌러 주세요.');
  }

  // 등록 외형만 삭제하고 사용 중이던 외형은 서버의 고양이 복귀 상태와 동기화한다.
  async function deleteDesign(design: Design): Promise<void> {
    // 1. 자동 저장과 삭제가 같은 선택을 동시에 덮어쓰지 못하게 한다.
    if (busy || autosaving || autosavePending || catalogueMutation) {
      return;
    }
    catalogueMutation = true;
    updateView();
    try {
      assertAccount();
      await api(`/designs/${design.id}`, { method: 'DELETE' });
      catalogueVersion += 1;
      designs = designs.filter(item => item.id !== design.id);
      if (pet?.design?.id === design.id) {
        pet = { ...pet, design: null, builtinId: 'cat' };
      }
      if (selectedDesignID === design.id) {
        selectedDesignID = 'default';
      }
      updateCatalogue();
      const current = await api<RegisteredPet>('/me/pet');
      assertAccount();
      if (disposed) {
        return;
      }

      // 2. 펫 자체를 새로 만들지 않고 목록·선택·미리보기만 갱신한다.
      pet = current;
      if (selectedDesignID === design.id) {
        selectedDesignID = 'default';
      }
      updateCatalogue();
      await refreshPreview();
      if (current.registered) {
        await options.onRegistered(current);
      }
      feedback('');
    } catch (error) {
      feedback(error instanceof Error ? error.message : '펫을 삭제하지 못했어요. 목록을 새로고침한 뒤 다시 시도하세요.', true);
    } finally {
      catalogueMutation = false;
      if (!disposed) {
        updateView();
      }
    }
  }


  // 목록에서 고른 등록 펫의 외형을 읽고 최신 선택만 미리보기에 반영한다.
  async function refreshPreview(): Promise<void> {
    // 1. 이전 요청과 선택이 바뀐 응답이 현재 미리보기를 덮지 못하게 한다.
    const version = ++previewVersion;
    previewReady = false;
    previewMenu.close();
    previewMotion.stop();
    previewProblem = '';
    canvas.hidden = true;
    previewNote.textContent = '미리보기를 불러오는 중이에요.';
    previewNote.hidden = false;
    try {
      assertAccount();
      let nextImage: HTMLImageElement | null = null;
      let nextDesign: Design | null = null;
      if (!builtinPets.some(option => option.selection === selectedDesignID)) {
        const design = designs.find(item => item.id === selectedDesignID) || (pet?.design?.id === selectedDesignID ? pet.design : undefined);
        if (!design) {
          throw new Error('미리 볼 펫을 선택하세요.');
        }
        let loaded = savedImages.get(design.id);
        if (!loaded) {
          const url = await designImage(design);
          if (disposed || version !== previewVersion) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.add(url);
          loaded = await loadImage(url);
          if (disposed || version !== previewVersion) {
            urls.delete(url);
            URL.revokeObjectURL(url);
            return;
          }
          savedImages.set(design.id, loaded);
        }
        nextImage = loaded;
        nextDesign = design;
      }
      if (disposed || version !== previewVersion) {
        return;
      }
      assertAccount();

      // 2. 같은 렌더러와 실제 PC 크기로 선택 결과를 표시한다.
      previewImage = nextImage;
      previewDesign = nextDesign;
      previewReady = true;
      canvas.hidden = false;
      playPreview(action.value === 'react' ? previewGesture : action.value === 'walk' ? 'walk' : 'idle');
    } catch (error) {
      if (!disposed && version === previewVersion) {
        previewProblem = error instanceof Error ? error.message : '선택한 펫을 표시하지 못했어요. 다시 선택해 주세요.';
        previewNote.textContent = previewProblem;
        previewNote.hidden = false;
      }
    }
  }

  // 메뉴와 선택 상자의 동작을 같은 렌더러로 재생하고 반응은 한 번 끝나면 대기로 복귀한다.
  function playPreview(next: PetPreviewAction): void {
    // 1. 준비된 현재 미리보기에서만 이전 동작을 중단하고 새 시작 시각을 정한다.
    if (disposed || !previewReady) {
      return;
    }
    previewMotion.stop();
    actionStarted = Date.now();
    const reacting = next !== 'idle' && next !== 'walk';
    const selected = next === 'pat' && previewDesign ? randomClickAnimation(previewDesign.manifest) : undefined;
    previewAnimationId = selected?.id;
    action.value = reacting ? 'react' : next;
    previewEndsAt = reacting ? actionStarted + (selected ? selected.animation.frames.length / selected.animation.fps * 1000 : 3300) : 0;

    // 2. 실제 펫과 같은 인사·하이파이브·쓰다듬기 자세를 미리보기 Canvas에만 적용한다.
    if (reacting) {
      previewGesture = next as Gesture;
      previewMotion.react(previewGesture);
    }
    paintPreview();
  }

  // 현재 PC의 실제 펫 크기와 선택한 동작으로 미리보기를 갱신한다.
  function paintPreview(): void {
    if (disposed || document.hidden || !previewReady) {
      return;
    }
    // 1. 앱과 같은 렌더러와 동작 줄이기 설정으로 캐릭터를 그린다.
    const now = Date.now();
    if (previewEndsAt && now >= previewEndsAt) {
      action.value = 'idle';
      previewEndsAt = 0;
      previewMotion.stop();
    }
    const mode = action.value as PreviewAction;
    const reduced = reducedMotion.matches;
    drawPet(canvas, previewImage, previewDesign, mode, reduced ? 0 : now, { animationId: mode === 'react' ? previewAnimationId : undefined, walking: mode === 'walk', gesture: mode === 'react' ? previewGesture : undefined, elapsed: reduced ? 0 : now - actionStarted, reduced, pose: previewMotion.pose, builtin: builtinID(selectedDesignID) });

    // 2. 발밑 이름표와 누락된 동작 등 필요한 안내만 표시한다.
    root.querySelector<HTMLElement>('[data-preview-name]')!.textContent = draftName() || '내 펫';
    previewNote.textContent = reduced ? '동작 줄이기 설정에 따라 정지 상태로 표시해요.' : previewDesign && !animationKey(previewDesign.manifest, mode, mode === 'react' ? previewAnimationId : undefined) ? '이 동작의 프레임이 없어 첫 이미지로 표시해요.' : '';
    previewNote.hidden = !previewNote.textContent;
  }

  // 현재 펫을 기준으로 외형 선택을 되돌린다.
  function resetDraft(): void {
    if (!pet) {
      return;
    }
    selectedDesignID = petSelection(pet);
    updateCatalogue();
    updateView();
    void refreshPreview();
  }

  // 저장된 펫 목록만 다시 읽고 현재 외형 선택은 보존한다.
  async function refreshDesigns(): Promise<void> {
    // 1. 겹치는 조회의 완료 순서와 새로고침 버튼의 대기 상태를 함께 관리한다.
    const version = ++catalogueVersion;
    const button = root.querySelector<HTMLButtonElement>('[data-refresh-designs]')!;
    catalogueRequests += 1;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      assertAccount();
      const latest = await api<Design[]>('/me/designs');
      if (disposed || version !== catalogueVersion) {
        return;
      }
      assertAccount();

      // 2. 현재 이름과 선택을 유지하면서 저장된 목록만 갱신한다.
      designs = latest;
      catalogueProblem = '';
      updateCatalogue();
    } finally {
      // 3. 실패하거나 새 펫 추가로 응답이 오래돼도 마지막 조회 후 버튼을 복구한다.
      catalogueRequests -= 1;
      if (!disposed) {
        button.disabled = catalogueRequests > 0;
        button.setAttribute('aria-busy', String(catalogueRequests > 0));
      }
    }
  }

  // 대표 펫의 권위 있는 등록 상태를 읽고 등록 전에는 데스크톱 표시를 요청하지 않는다.
  async function loadRegistration(): Promise<void> {
    // 1. 다른 로그인이나 늦게 끝난 이전 조회가 새 화면을 덮어쓰지 않게 한다.
    const version = ++loadVersion;
    root.querySelector<HTMLButtonElement>('[data-retry]')!.hidden = true;
    feedback('등록 상태를 불러오는 중이에요.');
    try {
      assertAccount();
      const current = await api<RegisteredPet>('/me/pet');
      if (disposed || version !== loadVersion) {
        return;
      }
      assertAccount();
      if (typeof current.registered !== 'boolean') {
        throw new Error('서버의 펫 등록 상태를 확인하지 못했어요. 서버를 업데이트한 뒤 다시 불러와 주세요.');
      }
      pet = current;
      try {
        await refreshDesigns();
      } catch {
        if (!disposed) {
          catalogueProblem = '등록된 펫 목록을 가져오지 못했어요. 목록을 새로고침하거나 고양이를 선택하세요.';
        }
      }
      if (disposed || version !== loadVersion) {
        return;
      }

      // 2. 등록된 외형과 입력 초안을 분리해 완료 전 선택이 실제 펫을 바꾸지 않게 한다.
      root.querySelector<HTMLElement>('[data-layout]')!.hidden = false;
      resetDraft();
      feedback(current.registered ? '' : '캐릭터를 선택한 뒤 등록 완료를 눌러 주세요.');
    } catch (error) {
      if (!disposed && version === loadVersion) {
        feedback(error instanceof Error ? error.message : '등록 상태를 읽지 못했어요. 다시 불러와 주세요.', true);
        root.querySelector<HTMLButtonElement>('[data-retry]')!.hidden = false;
      }
    }
  }

  // 최초 펫 등록만 명시적으로 완료하고 이후 변경은 자동 저장에 맡긴다.
  async function registerPet(): Promise<void> {
    // 1. 등록된 펫의 Enter 입력은 자동 저장으로 처리하고 최초 등록만 검증한다.
    if (pet?.registered) {
      requestAutosave(true);
      return;
    }
    if (busy || !pet || !form.reportValidity()) {
      return;
    }
    const petID = pet.id;
    const designId = selectedDesignID;
    const petName = draftName();
    busy = true;
    updateView();
    try {
      assertAccount();
      if (!petName) {
        throw new Error('닉네임을 불러오지 못했어요. 다시 로그인해 주세요.');
      }
      await refreshPreview();
      if (!previewReady) {
        throw new Error(previewProblem || '선택한 펫을 먼저 확인해 주세요.');
      }
      assertAccount();

      // 2. 카탈로그 추가와 구분해 같은 대표 펫의 선택만 확정한다.
      const result = await api<RegisteredPet>('/me/pet/registration', { method: 'POST', body: JSON.stringify({ name: petName, designId }) });
      assertAccount();
      if (!result.registered || result.id !== petID) {
        throw new Error('같은 펫의 저장 상태를 확인하지 못했어요. 다시 불러와 주세요.');
      }
      pet = result;
      if (!disposed) {
        resetDraft();
        feedback('내 펫 설정을 저장했어요.');
      }
      try {
        await options.onRegistered(result);
      } catch {
        feedback('설정은 저장했지만 데스크톱 상태를 갱신하지 못했어요. 화면을 다시 열어 주세요.', true);
      }
    } catch (error) {
      feedback(error instanceof Error ? error.message : '설정을 저장하지 못했어요. 다시 시도해 주세요.', true);
    } finally {
      busy = false;
      if (!disposed) {
        updateView();
      }
    }
  }

  // 3. 입력 동작과 공통 표시 설정을 구독하고 화면을 떠날 때 모두 해제한다.
  form.onsubmit = event => {
    event.preventDefault();
    void registerPet();
  };
  form.addEventListener('invalid', () => feedback('표시한 입력 항목을 확인한 뒤 다시 저장하세요.', true), true);
  form.onchange = event => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'character') {
      selectedDesignID = input.value;
      draftRevision += 1;
      updateView();
      void refreshPreview();
      requestAutosave(true);
    }
  };
  root.querySelector<HTMLButtonElement>('[data-add-pet]')!.onclick = () => uploadDialog.open();
  root.querySelector<HTMLElement>('[data-characters]')!.onclick = event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-design-action]') : null;
    const design = designs.find(item => item.id === button?.dataset.designId);
    if (!button || !design || busy || autosaving || autosavePending || catalogueMutation) {
      return;
    }
    if (button.dataset.designAction === 'edit') {
      uploadDialog.open(design);
    } else {
      void deleteDesign(design);
    }
  };
  retrySave.onclick = () => requestAutosave(true);
  root.querySelector<HTMLButtonElement>('[data-retry]')!.onclick = () => void loadRegistration();
  root.querySelector<HTMLButtonElement>('[data-refresh-designs]')!.onclick = () => {
    void refreshDesigns().catch(() => feedback('등록된 펫 목록을 가져오지 못했어요. 다시 시도하세요.', true));
  };
  action.onchange = () => {
    previewMenu.close();
    playPreview(action.value === 'react' ? 'wave' : action.value === 'walk' ? 'walk' : 'idle');
  };
  const timer = setInterval(paintPreview, 1000 / 24);
  void watchDisplay(preferences => {
    if (!disposed) {
      petSize = preferences.petSize;
      root.style.setProperty('--pet-size', `${petSize}px`);
      canvas.width = canvas.height = petSize;
      paintPreview();
    }
  }).then(stop => {
    if (disposed) {
      stop();
    } else {
      unwatch = stop;
    }
  }).catch(() => feedback('이 PC의 펫 크기를 읽지 못해 기본 크기로 미리 보여요.', true));
  void loadRegistration();

  // 미리보기 타이머·공유 설정·이 모듈이 만든 이미지 URL을 모두 해제한다.
  function dispose(): void {
    // 1. 늦게 끝나는 조회와 미리보기 구독을 중단한다.
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    if (pet?.registered) {
      autosavePending = true;
      void flushAutosave();
    }
    disposed = true;
    loadVersion += 1;
    previewVersion += 1;
    clearInterval(timer);
    previewMenu.dispose();
    previewMotion.dispose();
    unwatch();
    displaySettings.dispose();
    uploadDialog.dispose();

    // 2. 이 화면에서 만든 이미지 URL과 캐시 참조만 해제한다.
    urls.forEach(url => URL.revokeObjectURL(url));
    urls.clear();
    savedImages.clear();
  }
  return dispose;
}
