import { api, designImage, serverURL, session } from './api';
import { drawPet, loadImage } from './render';
import { watchDisplay } from './preferences';
import type { Design, Manifest } from './types';
import './pet-upload.css';
import { mountCharacterPrompts } from './character-prompts';
import { mountAnimationEditor } from './animation-editor';
import { animationKey } from './pet-animations';

export interface PetUploadOptions {
  onAdded: (design: Design) => void | Promise<void>;
  onUpdated: (previous: Design, design: Design, isCurrent: () => boolean) => void | Promise<void>;
}

type PreviewAction = 'idle' | 'walk' | 'react';

// PNG 펫을 선택 목록에 추가하고 실제 적용은 바깥 설정 화면에 맡기는 모달을 구성한다.
export function mountPetUpload(root: HTMLElement, options: PetUploadOptions): { open(design?: Design): void; close(): void; dispose(): void } {
  // 1. 모달의 파일·미리보기·재시도 상태를 다른 설정 입력과 분리한다.
  let disposed = false;
  let busy = false;
  let draftVersion = 0;
  let editingDesign: Design | undefined;
  let previewVersion = 0;
  let petSize = 160;
  let selectedFile: File | undefined;
  let loadedImage: HTMLImageElement | undefined;
  let decodedPixels: { image: HTMLImageElement; data: Uint8ClampedArray } | undefined;
  let previewDesign: Design | undefined;
  let previewAnimation = 'idle';
  let previewReady = false;
  let animationDefaultsApplied = false;
  let useExampleDimensions = true;
  let previewProblem = '';
  let actionStarted = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let unwatch = (): void => {};
  let cachedSubmission: { file?: File; fingerprint: string; design: Design } | undefined;
  const urls = new Set<string>();
  const account = `${serverURL()}/${session()?.token || ''}`;
  const id = `pet-upload-${crypto.randomUUID()}`;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const dialog = document.createElement('dialog');
  dialog.className = 'pet-upload-dialog';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.innerHTML = `<div class="pet-upload-heading"><h2 id="${id}-title">펫 추가</h2><div class="pet-upload-actions"><button type="button" data-cancel>취소</button><button type="submit" form="${id}-form" class="primary">추가</button></div></div>
    <form id="${id}-form"><div class="pet-upload-layout"><fieldset class="pet-upload-fields" aria-label="추가할 펫 정보"><label for="${id}-name">이름<input id="${id}-name" name="name" maxlength="80" placeholder="예: 고양이" required></label><label for="${id}-file">PNG 파일<input id="${id}-file" name="image" class="file-input-compact" type="file" accept="image/png" aria-describedby="${id}-png-limits ${id}-png-guide" required></label><p class="fine pet-upload-file-hint" id="${id}-png-limits">최대 8 MiB · 2048 × 2048px · 투명 배경 권장</p><div class="pet-upload-png-guide fine" id="${id}-png-guide"><p>두 경우 모두 <strong>PNG 파일 하나</strong>를 선택해요.</p><ul><li><strong>일반 PNG</strong>: 펫 그림 하나가 들어 있어요. 애니메이션 설정 없이 추가할 수 있어요.</li><li><strong>스프라이트 시트 PNG</strong>: 여러 동작 그림이 한 이미지 안에 격자로 들어 있어요. 아래 애니메이션 설정에서 칸 크기와 재생 순서를 지정해요.</li></ul></div>
      <details class="character-prompts"><summary class="field-label">캐릭터 프롬프트</summary><div class="character-prompt-content"><p class="fine">먼저 일반 PNG로 캐릭터 한 자세를 만든 뒤, 그 이미지를 첨부해 스프라이트 시트로 확장하세요.</p><div class="character-prompt-toolbar"><label>이미지 종류<select data-character-prompt-kind><option value="single">일반 PNG 한 장</option><option value="animated">스프라이트 시트 PNG</option></select></label><button type="button" class="quiet" data-copy-character-prompt>프롬프트 복사</button></div><textarea data-character-prompt-text rows="12" readonly aria-label="캐릭터 생성 프롬프트" spellcheck="false"></textarea><p class="fine" data-character-prompt-hint></p><p class="fine" data-character-prompt-status role="status" aria-live="polite"></p></div></details>
      <details data-animation-settings><summary class="field-label">애니메이션 설정 · 스프라이트 시트</summary><p class="fine">스프라이트 시트 PNG를 선택했을 때 설정해요<br>일반 PNG는 이 항목을 비워 두면 돼요.</p><h3 class="pet-upload-frame-heading" id="${id}-frame-size">그림 한 칸 크기</h3><div class="pet-upload-two-col" role="group" aria-labelledby="${id}-frame-size"><label>너비<input name="frameWidth" type="number" min="1" max="2048" step="1" placeholder="px"></label><label>높이<input name="frameHeight" type="number" min="1" max="2048" step="1" placeholder="px"></label></div><p class="fine">예: 256 × 128px PNG에 64 × 64px 그림이 들어 있다면 너비·높이에 각각 64를 입력해요.</p><p class="fine" data-frame-guide role="status">PNG를 선택하면 원본 크기와 나눈 칸 수를 보여줘요.</p><figure class="pet-upload-frame-map" data-frame-map hidden><figcaption>왼쪽 위부터 가로로 세는 칸 번호</figcaption><div class="pet-upload-frame-scroll"><div class="pet-upload-frame-grid" data-frame-grid></div></div></figure>
      <div data-animation-editor></div><p class="fine">0,1,2,3은 네 칸을 순서대로 반복해요. 속도 8은 1초에 8장을 넘겨요.</p></details>
    </fieldset><section class="pet-upload-preview" aria-label="추가할 펫 미리보기"><h3>화면 미리보기</h3><div class="pet-upload-preview-stage"><p class="muted" data-empty>PNG를 고르면 이곳에서 미리 볼 수 있어요.</p><div class="pet-name-anchor"><canvas width="160" height="160" role="img" aria-label="추가할 펫의 모습" hidden></canvas><span class="pet-nameplate" data-preview-name></span></div></div><p class="fine" data-size-note></p><label for="${id}-action">미리보기 동작<select id="${id}-action" data-action><option value="idle">대기</option><option value="walk">걷기</option><option value="react">반응</option></select></label><p class="fine" data-preview-note role="status"></p></section></div>
    <p class="pet-upload-status" data-status role="status" aria-live="polite"></p></form>`;
  root.append(dialog);
  const disposePrompts = mountCharacterPrompts(dialog);
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const fields = form.querySelector<HTMLFieldSetElement>('.pet-upload-fields')!;
  const fileInput = form.querySelector<HTMLInputElement>('[name=image]')!;
  const nameInput = form.querySelector<HTMLInputElement>('[name=name]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
  const canvas = dialog.querySelector<HTMLCanvasElement>('canvas')!;
  const placeholder = dialog.querySelector<HTMLElement>('[data-empty]')!;
  const previewNote = dialog.querySelector<HTMLElement>('[data-preview-note]')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const action = dialog.querySelector<HTMLSelectElement>('[data-action]')!;
  const animationSettings = dialog.querySelector<HTMLDetailsElement>('[data-animation-settings]')!;
  const frameGuide = dialog.querySelector<HTMLElement>('[data-frame-guide]')!;
  const frameMap = dialog.querySelector<HTMLElement>('[data-frame-map]')!;
  const frameGrid = dialog.querySelector<HTMLElement>('[data-frame-grid]')!;
  const animationEditor = mountAnimationEditor(dialog.querySelector<HTMLElement>('[data-animation-editor]')!, {
    onChange: () => {
      syncAnimationPreviewChoices();
      void refreshPreview();
    },
  });

  // 등록한 이름과 내부 ID를 미리보기 선택지에 함께 반영한다.
  function syncAnimationPreviewChoices(): void {
    const current = action.value;
    const entries = animationEditor.choices();
    action.replaceChildren(...(entries.length ? entries : [{ id: 'idle', name: '대기' }, { id: 'walk', name: '걷기' }, { id: 'react', name: '반응' }]).map(entry => new Option(entry.name, entry.id)));
    if (Array.from(action.options).some(option => option.value === current)) {
      action.value = current;
    }
  }


  // 2. 현재 로그인과 미리보기 범위를 확인한 뒤 초안만 서버에 추가한다.

  // 모달을 연 계정이 바뀌면 다른 사용자의 목록으로 업로드하지 못하게 한다.
  function assertAccount(): void {
    if (!session() || account !== `${serverURL()}/${session()?.token || ''}`) {
      throw new Error('로그인한 계정이 바뀌었어요. 설정 화면에서 펫 추가를 다시 열어 주세요.');
    }
  }

  // 추가 결과와 복구 방법을 현재 모달 안에서만 안내한다.
  function feedback(message: string, error = false): void {
    if (!disposed) {
      status.textContent = message;
      status.classList.toggle('error', error);
    }
  }

  // 이미지 크기와 한 칸 입력을 확인해 원본 시트의 행·열·전체 칸 수를 계산한다.
  function frameLayout(image: HTMLImageElement): { width: number; height: number; count: number; columns: number; rows: number } {
    // 1. 잘못된 크기를 기본값으로 숨기지 않고 빈 입력만 전체 이미지로 해석한다.
    const widthText = (form.elements.namedItem('frameWidth') as HTMLInputElement).value;
    const heightText = (form.elements.namedItem('frameHeight') as HTMLInputElement).value;
    const width = widthText ? Number(widthText) : image.naturalWidth;
    const height = heightText ? Number(heightText) : image.naturalHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || image.naturalWidth % width || image.naturalHeight % height) {
      throw new Error('한 칸 너비·높이가 PNG 전체 크기를 나누어떨어지게 입력해 주세요.');
    }
    // 2. 칸 수는 서버와 같은 상한으로 제한하고 안내용 행·열도 함께 반환한다.
    const count = image.naturalWidth / width * (image.naturalHeight / height);
    if (count > 256) {
      throw new Error('스프라이트 시트는 전체 256칸 이내로 나누어 주세요.');
    }
    return { width, height, count, columns: image.naturalWidth / width, rows: image.naturalHeight / height };
  }

  // 이미지 전체 또는 정확히 나눈 프레임과 선택적인 동작 규격을 만든다.
  function manifestFor(image: HTMLImageElement): Manifest {
    // 1. 안내에 표시한 것과 같은 분할 결과로 저장할 프레임 크기를 정한다.
    const { width, height, count } = frameLayout(image);
    const settings = animationEditor.read(count);
    return { schemaVersion: Object.keys(settings.animations).length ? 2 : 1, displaySize: editingDesign?.manifest.displaySize || 160, frameWidth: width, frameHeight: height, ...settings };
  }

  // 설정을 펼쳤을 때 원본 크기·행·열과 번호가 붙은 실제 그림 칸을 보여 준다.
  function updateFrameGuide(): void {
    // 1. 현재 파일과 열린 설정에만 안내를 만들고 닫힌 동안에는 그림을 나누지 않는다.
    frameMap.hidden = true;
    if (!loadedImage || (!editingDesign && selectedFile !== fileInput.files?.[0])) {
      frameGuide.textContent = 'PNG를 선택하면 원본 크기와 나눈 칸 수를 보여줘요.';
      return;
    }
    if (!animationSettings.open) {
      return;
    }
    try {
      const { width, height, count, columns, rows } = frameLayout(loadedImage);
      frameGuide.textContent = `PNG ${loadedImage.naturalWidth} × ${loadedImage.naturalHeight}px · ${columns}열 × ${rows}행 · ${count}칸${count === 1 ? ' — 현재는 그림 한 장이에요. 여러 장면이 있다면 한 칸 크기를 입력하세요.' : ''}`;
      frameGrid.replaceChildren();
      if (count === 1) {
        return;
      }

      // 2. 원본 배치와 번호를 그대로 유지하며 각 칸을 같은 크기 안에 종횡비대로 그린다.
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < count; index++) {
        const cell = document.createElement('div');
        cell.className = 'pet-upload-frame-cell';
        const thumbnail = document.createElement('canvas');
        thumbnail.width = thumbnail.height = 48;
        thumbnail.setAttribute('aria-hidden', 'true');
        const scale = Math.min(40 / width, 40 / height);
        thumbnail.getContext('2d')!.drawImage(loadedImage, index % columns * width, Math.floor(index / columns) * height, width, height, (48 - width * scale) / 2, (48 - height * scale) / 2, width * scale, height * scale);
        const label = document.createElement('span');
        label.textContent = String(index);
        label.setAttribute('aria-label', `${index}번 칸`);
        cell.append(thumbnail, label);
        fragment.append(cell);
      }
      frameGrid.style.setProperty('--frame-columns', String(columns));
      frameGrid.append(fragment);
      frameMap.hidden = false;
    } catch (error) {
      frameGuide.textContent = error instanceof Error ? error.message : '한 칸 크기를 확인해 주세요.';
    }
  }

  // 선택한 동작에 실제 그림이 있는지 확인하고 같은 PNG의 디코딩 결과를 재사용한다.
  function hasPreviewContent(image: HTMLImageElement, design: Design): boolean {
    // 1. 원본 알파 값은 파일마다 한 번만 읽어 설정 변경 시 반복 디코딩을 피한다.
    if (decodedPixels?.image !== image) {
      const scratch = document.createElement('canvas');
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      const context = scratch.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      decodedPixels = { image, data: context.getImageData(0, 0, scratch.width, scratch.height).data };
    }

    // 2. 일부 투명 프레임은 허용하되 선택된 동작의 모든 칸이 비었으면 설정을 안내한다.
    const mode: PreviewAction = action.value === 'idle' ? 'idle' : action.value === 'walk' ? 'walk' : 'react';
    const selected = animationKey(design.manifest, mode, action.value);
    const frames = selected ? design.manifest.animations[selected]?.frames || [0] : [0];
    const { frameWidth: width, frameHeight: height } = design.manifest;
    const columns = image.naturalWidth / width;
    for (const frame of frames) {
      const left = (frame % columns) * width;
      const top = Math.floor(frame / columns) * height;
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          if (decodedPixels.data[(y * image.naturalWidth + x) * 4 + 3] > 20) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // 선택한 PNG를 디코딩하고 닫거나 선택을 바꾼 뒤 끝난 요청은 버린다.
  async function refreshPreview(): Promise<void> {
    // 1. 새 파일의 실제 형식과 크기를 확인하고 자원을 현재 모달에만 보관한다.
    const version = ++previewVersion;
    const keepPreview = !canvas.hidden && !!previewDesign && !!loadedImage && (!!editingDesign || selectedFile === fileInput.files?.[0]);
    previewReady = false;
    previewProblem = '';
    canvas.hidden = !keepPreview;
    placeholder.hidden = keepPreview;
    placeholder.textContent = '미리보기를 불러오는 중이에요.';
    frameMap.hidden = true;
    frameGuide.textContent = 'PNG와 한 칸 크기를 확인하는 중이에요.';
    try {
      assertAccount();
      if (editingDesign) {
        if (!loadedImage) {
          const url = await designImage(editingDesign);
          if (disposed || version !== previewVersion || !dialog.open) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.add(url);
          let image: HTMLImageElement;
          try {
            image = await loadImage(url);
          } catch (error) {
            urls.delete(url);
            URL.revokeObjectURL(url);
            throw error;
          }
          if (disposed || version !== previewVersion || !dialog.open) {
            urls.delete(url);
            URL.revokeObjectURL(url);
            return;
          }
          loadedImage = image;
        }
      } else {
        const file = fileInput.files?.[0];
        if (!file) {
          throw new Error('PNG를 고르면 이곳에서 미리 볼 수 있어요.');
        }
        if (file.size > 8 * 1024 * 1024) {
          throw new Error('PNG 파일은 8 MiB 이하로 선택하세요.');
        }
        if (file !== selectedFile || !loadedImage) {
          const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
          if (disposed || version !== previewVersion || !dialog.open) {
            return;
          }
          if (signature.join(',') !== '137,80,78,71,13,10,26,10') {
            throw new Error('PNG 파일을 선택하세요. 확장자만 바꾼 다른 이미지 형식은 추가할 수 없어요.');
          }
          const url = URL.createObjectURL(file);
          urls.add(url);
          let image: HTMLImageElement;
          try {
            image = await loadImage(url);
          } catch {
            urls.delete(url);
            URL.revokeObjectURL(url);
            throw new Error('PNG를 읽지 못했어요. 파일이 손상되지 않았는지 확인하고 다시 선택하세요.');
          }
          if (disposed || version !== previewVersion || !dialog.open) {
            urls.delete(url);
            URL.revokeObjectURL(url);
            return;
          }
          if (image.naturalWidth > 2048 || image.naturalHeight > 2048) {
            urls.delete(url);
            URL.revokeObjectURL(url);
            throw new Error('PNG 크기는 2048 × 2048px 이하여야 해요.');
          }
          urls.forEach(previous => {
            if (previous !== url) {
              URL.revokeObjectURL(previous);
              urls.delete(previous);
            }
          });
          selectedFile = file;
          loadedImage = image;
        }
      }
      if (!loadedImage || disposed || version !== previewVersion || !dialog.open) {
        return;
      }

      // 2. 칸 번호 안내와 실제 동작 미리보기를 같은 분할 규칙으로 갱신한다.
      if (animationDefaultsApplied && useExampleDimensions) {
        if (loadedImage.naturalWidth % 4 || loadedImage.naturalHeight % 4) {
          throw new Error('예시 시트는 4열 × 4행이에요. 이 PNG에 맞는 한 칸 너비·높이를 직접 입력하세요.');
        }
        (form.elements.namedItem('frameWidth') as HTMLInputElement).value = String(loadedImage.naturalWidth / 4);
        (form.elements.namedItem('frameHeight') as HTMLInputElement).value = String(loadedImage.naturalHeight / 4);
      }
      updateFrameGuide();
      const candidate = { id: 'pet-upload-preview', ownerId: session()?.principal.userId || '', version: 0, name: nameInput.value.trim(), imageHash: '', manifest: manifestFor(loadedImage) };
      if (!hasPreviewContent(loadedImage, candidate)) {
        throw new Error('선택한 동작의 칸이 모두 투명해요. 그림 한 칸의 너비·높이와 칸 번호를 확인해 주세요.');
      }
      previewDesign = candidate;
      previewAnimation = action.value;
      previewReady = true;
      canvas.hidden = false;
      placeholder.hidden = true;
      actionStarted = Date.now();
      paintPreview();
    } catch (error) {
      if (!disposed && version === previewVersion) {
        previewReady = false;
        previewProblem = error instanceof Error ? error.message : 'PNG를 미리 볼 수 없어요. 다른 파일로 다시 시도하세요.';
        placeholder.textContent = previewProblem;
        if (!loadedImage || selectedFile !== fileInput.files?.[0]) {
          frameGuide.textContent = '유효한 PNG를 선택하면 칸 번호를 보여줘요.';
        }
        previewNote.textContent = keepPreview ? `${previewProblem} 마지막 정상 설정의 모습을 표시하고 있어요.` : '';
        previewNote.classList.toggle('error', keepPreview);
      }
    }
  }

  // PC의 실제 표시 크기와 동작 줄이기 설정에 맞춰 PNG만 그린다.
  function paintPreview(): void {
    // 1. 모달이 닫혔거나 표시할 정상 미리보기가 없으면 프레임을 갱신하지 않는다.
    if (disposed || !dialog.open || document.hidden || canvas.hidden || !loadedImage || !previewDesign) {
      return;
    }
    const now = Date.now();
    const selectedAnimation = previewAnimation;
    const mode: PreviewAction = selectedAnimation === 'idle' ? 'idle' : selectedAnimation === 'walk' ? 'walk' : 'react';
    drawPet(canvas, loadedImage, previewDesign, mode, reducedMotion.matches ? 0 : now, { animationId: selectedAnimation, walking: mode === 'walk', gesture: mode === 'react' ? 'wave' : undefined, elapsed: now - actionStarted, reduced: reducedMotion.matches });

    // 2. 누락된 동작의 대체와 실제 크기를 함께 안내한다.
    dialog.querySelector<HTMLElement>('[data-preview-name]')!.textContent = nameInput.value.trim() || '추가할 펫';
    dialog.querySelector<HTMLElement>('[data-size-note]')!.textContent = `이 PC의 실제 펫 크기 · ${petSize}px`;
    previewNote.classList.toggle('error', !previewReady && !!previewProblem);
    previewNote.textContent = !previewReady && previewProblem ? `${previewProblem} 마지막 정상 설정의 모습을 표시하고 있어요.` : reducedMotion.matches ? '동작 줄이기 설정에 따라 정지 상태로 표시해요.' : !previewDesign.manifest.animations[selectedAnimation] ? '이 동작의 프레임이 없어 대기 프레임이나 첫 이미지로 표시해요.' : '선택한 동작을 실제 펫 크기로 미리 보여요.';
  }

  // 추가 요청을 잠그되 닫기와 취소는 계속 사용할 수 있게 한다.
  function updateBusy(): void {
    fields.disabled = busy;
    submit.disabled = busy;
    submit.textContent = busy ? (editingDesign ? '저장하는 중…' : '추가하는 중…') : (editingDesign ? '저장' : '추가');
    submit.setAttribute('aria-busy', String(busy));
  }

  // 같은 폼의 성공한 업로드는 재사용하고 목록 반영만 다시 시도한다.
  async function addPet(): Promise<void> {
    // 1. 현재 입력을 검증하고 추가 중에는 파일과 이름이 바뀌지 않게 한다.
    if (disposed || busy || !dialog.open || !form.reportValidity()) {
      return;
    }
    const version = draftVersion;
    busy = true;
    updateBusy();
    feedback('');
    let added = false;
    try {
      assertAccount();
      const label = nameInput.value.trim();
      if (!label || new TextEncoder().encode(label).length > 80) {
        throw new Error('이름을 조금 짧게 입력해 주세요.');
      }
      await refreshPreview();
      if (!dialog.open || disposed || version !== draftVersion) {
        return;
      }
      if (!previewReady || !previewDesign) {
        throw new Error(previewProblem || 'PNG 미리보기를 먼저 확인해 주세요.');
      }
      const file = fileInput.files?.[0];
      if (!editingDesign && !file) {
        throw new Error('추가할 PNG 파일을 선택하세요.');
      }
      const fingerprint = `${editingDesign?.id || `${file!.name}/${file!.size}/${file!.lastModified}`}/${label}/${JSON.stringify(previewDesign.manifest)}`;
      const previous = editingDesign;
      assertAccount();
      if (!cachedSubmission || cachedSubmission.file !== file || cachedSubmission.fingerprint !== fingerprint) {
        let design: Design;
        if (editingDesign) {
          design = await api<Design>(`/designs/${editingDesign.id}`, { method: 'PUT', body: JSON.stringify({ name: label, manifest: previewDesign.manifest }) });
        } else {
          const data = new FormData();
          data.set('name', label);
          data.set('image', file!);
          data.set('manifest', JSON.stringify(previewDesign.manifest));
          data.set('draft', 'true');
          design = await api<Design>('/designs', { method: 'POST', body: data });
        }
        if (disposed || !dialog.open || version !== draftVersion) {
          return;
        }
        cachedSubmission = { file, fingerprint, design };
      }

      // 2. 현재 모달의 결과만 부모에 전달하고 목록 반영이 끝난 뒤 닫는다.
      added = true;
      if (disposed || !dialog.open || version !== draftVersion) {
        return;
      }
      assertAccount();
      if (previous) {
        await options.onUpdated(previous, cachedSubmission.design, () => !disposed && dialog.open && version === draftVersion);
      } else {
        await options.onAdded(cachedSubmission.design);
      }
      if (!disposed && dialog.open && version === draftVersion) {
        close();
      }
    } catch (error) {
      if (!disposed && dialog.open && version === draftVersion) {
        feedback(added && account === `${serverURL()}/${session()?.token || ''}` ? '펫 추가는 완료했지만 목록에 반영하지 못했어요. 같은 내용으로 추가를 다시 누르면 중복 업로드 없이 목록을 갱신해요.' : error instanceof Error ? error.message : '추가하지 못했어요. 입력 내용을 유지했으니 다시 시도해 주세요.', true);
      }
    } finally {
      if (version === draftVersion) {
        busy = false;
        if (!disposed) {
          updateBusy();
        }
      }
    }
  }

  // 닫힌 초안의 응답을 무효화하고 입력·미리보기·파일 자원을 기본값으로 되돌린다.
  function reset(): void {
    // 1. 이전 입력과 추가 결과를 초기화한다.
    draftVersion += 1;
    previewVersion += 1;
    busy = false;
    form.reset();
    animationEditor.load({ schemaVersion: 1, displaySize: 160, frameWidth: 1, frameHeight: 1, animations: {} });
    syncAnimationPreviewChoices();
    action.value = 'idle';
    editingDesign = undefined;
    cachedSubmission = undefined;
    selectedFile = undefined;
    loadedImage = undefined;
    decodedPixels = undefined;
    previewDesign = undefined;
    previewAnimation = 'idle';
    previewReady = false;
    previewProblem = '';
    animationDefaultsApplied = false;
    useExampleDimensions = true;
    animationSettings.open = false;
    canvas.hidden = true;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    placeholder.hidden = false;
    placeholder.textContent = 'PNG를 고르면 이곳에서 미리 볼 수 있어요.';
    previewNote.textContent = '';
    previewNote.classList.remove('error');
    frameMap.hidden = true;
    frameGrid.replaceChildren();
    frameGuide.textContent = 'PNG를 선택하면 원본 크기와 나눈 칸 수를 보여줘요.';
    dialog.querySelector<HTMLElement>('[data-preview-name]')!.textContent = '';
    dialog.querySelector<HTMLElement>('[data-size-note]')!.textContent = '';
    dialog.querySelector<HTMLDetailsElement>('.character-prompts')!.open = false;
    feedback('');
    updateBusy();

    // 2. 새 모달에서 쓰지 않는 이전 파일 URL을 해제한다.
    urls.forEach(url => URL.revokeObjectURL(url));
    urls.clear();
  }

  // 새 추가는 기본값으로 열고 수정은 저장된 설정을 채워 실제 크기 미리보기를 시작한다.
  function open(design?: Design): void {
    // 1. 해제된 화면이나 이미 열린 모달을 중복으로 열지 않는다.
    if (disposed || busy || !dialog.isConnected || dialog.open) {
      return;
    }
    reset();
    // 2. 수정은 저장된 설정을 채우고 원본 PNG 선택·교체 경로를 닫는다.
    if (design && !editingDesign) {
      editingDesign = design;
      nameInput.value = design.name;
      (form.elements.namedItem('frameWidth') as HTMLInputElement).value = String(design.manifest.frameWidth);
      (form.elements.namedItem('frameHeight') as HTMLInputElement).value = String(design.manifest.frameHeight);
      animationEditor.load(design.manifest);
      syncAnimationPreviewChoices();
      animationDefaultsApplied = true;
      useExampleDimensions = false;
      animationSettings.open = Object.keys(design.manifest.animations).length > 0;
    }
    dialog.querySelector('h2')!.textContent = design ? '펫 수정' : '펫 추가';
    fileInput.hidden = !!design;
    fileInput.disabled = !!design;
    fileInput.required = !design;
    fileInput.parentElement!.hidden = !!design;
    dialog.querySelector<HTMLElement>('.pet-upload-file-hint')!.hidden = !!design;
    dialog.querySelector<HTMLElement>('.pet-upload-png-guide')!.hidden = !!design;
    dialog.querySelector<HTMLElement>('.character-prompts')!.hidden = !!design;
    updateBusy();
    dialog.showModal();
    if (!busy) {
      (!design && nameInput.value.trim() && !fileInput.files?.length ? fileInput : nameInput).focus();
    }
    try {
      assertAccount();
      if (editingDesign || fileInput.files?.length) {
        void refreshPreview();
      }
    } catch (error) {
      feedback(error instanceof Error ? error.message : '로그인 상태를 확인해 주세요.', true);
    }

    // 3. 닫힌 동안에는 타이머를 돌리지 않고 열린 모달에서만 그린다.
    clearInterval(timer);
    timer = setInterval(paintPreview, 1000 / 24);
  }

  // 모달을 닫고 네이티브 dialog가 호출한 버튼으로 포커스를 복구하게 한다.
  function close(): void {
    if (dialog.open) {
      dialog.close();
    }
    clearInterval(timer);
    timer = undefined;
    reset();
  }

  // 3. 브라우저 기본 취소와 바깥 클릭을 지원하고 공통 크기 설정을 구독한다.
  form.onsubmit = event => {
    event.preventDefault();
    void addPet();
  };
  form.addEventListener('invalid', () => feedback('표시한 입력 항목을 확인한 뒤 다시 추가하세요.', true), true);
  // 예시 기본값을 한 번만 채워 설정을 펼친 직후의 사용자 입력도 덮어쓰지 않는다.
  function initializeAnimationDefaults(): void {
    // 1. 일반 PNG는 빈 설정을 유지하고 예시 시트는 별도 버튼 없이 시작한다.
    if (!animationDefaultsApplied) {
      animationDefaultsApplied = true;
      (form.elements.namedItem('frameWidth') as HTMLInputElement).value = '256';
      (form.elements.namedItem('frameHeight') as HTMLInputElement).value = '256';
      animationEditor.load({ schemaVersion: 2, displaySize: 160, frameWidth: 256, frameHeight: 256, idleAnimation: 'idle', walkAnimation: 'walk', animations: {
        idle: { name: '대기', frames: [0,1,2,3], fps: 4 },
        walk: { name: '걷기', frames: [4,5,6,7,8,9,10,11], fps: 8 },
        react: { name: '반응', frames: [12,13,14,15], fps: 6 },
      } });
      syncAnimationPreviewChoices();
      void refreshPreview();
    }
  }

  // 펼치기 클릭에서 기본값을 먼저 채우고 비동기 toggle은 안내만 갱신한다.
  animationSettings.querySelector('summary')!.addEventListener('click', () => {
    if (!animationSettings.open) {
      initializeAnimationDefaults();
    }
  });
  animationSettings.ontoggle = () => {
    if (animationSettings.open) {
      initializeAnimationDefaults();
    }

    // 다시 펼칠 때는 수동으로 바꾼 칸 크기와 동작 순서를 그대로 안내한다.
    updateFrameGuide();
  };
  form.oninput = event => {
    const input = event.target as HTMLInputElement;
    if (input.closest('[data-animation-editor]')) {
      return;
    }
    if (input.name === 'name') {
      paintPreview();
    } else if (input.name && input.name !== 'image') {
      if (input.name === 'frameWidth' || input.name === 'frameHeight') {
        useExampleDimensions = false;
      }
      void refreshPreview();
    }
  };
  fileInput.onchange = () => void refreshPreview();
  action.onchange = () => {
    actionStarted = Date.now();
    void refreshPreview();
  };
  dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = close;
  dialog.onclose = () => {
    if (!dialog.open) {
      clearInterval(timer);
      timer = undefined;
      reset();
    }
  };
  dialog.onclick = event => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        close();
      }
    }
  };
  void watchDisplay(preferences => {
    if (!disposed) {
      petSize = preferences.petSize;
      dialog.style.setProperty('--pet-size', `${petSize}px`);
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

  // 모달·미리보기·공유 설정과 이 모듈이 만든 URL을 모두 해제한다.
  function dispose(): void {
    // 1. 늦은 응답과 열린 모달의 갱신을 중단한다.
    disposed = true;
    close();
    unwatch();
    disposePrompts();
    dialog.remove();

    // 2. 파일 미리보기 참조와 생성한 URL만 해제한다.
    urls.forEach(url => URL.revokeObjectURL(url));
    urls.clear();
    loadedImage = undefined;
    decodedPixels = undefined;
    selectedFile = undefined;
    previewDesign = undefined;
    cachedSubmission = undefined;
  }
  return { open, close, dispose };
}
