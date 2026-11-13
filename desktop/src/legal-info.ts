import { icon } from './icons';
import privacy from '../../PRIVACY.md?raw';
import license from '../../LICENSE?raw';
import notices from '../../THIRD_PARTY_NOTICES.md?raw';
import { builtinCredits } from './builtin-pets';

// 계정 화면의 보조 영역에서 개인정보·라이선스 원문을 안전한 텍스트 모달로 제공한다.
export function mountLegalInfo(root: HTMLElement): () => void {
  // 1. 일반 설정과 구분한 진입점과 접근 가능한 원문 선택 모달을 만든다.
  const id = `legal-${crypto.randomUUID()}`;
  root.innerHTML = `<section class="account-info"><h2>정보 및 고지</h2><div class="account-info-links"><button type="button" class="quiet" data-legal-open="privacy">개인정보 안내</button><button type="button" class="quiet" data-legal-open="licenses">라이선스·출처</button></div></section><dialog class="legal-dialog" aria-labelledby="${id}-title"><header><h2 id="${id}-title">개인정보 안내</h2><button type="button" class="menu-close" data-legal-close aria-label="정보 및 고지 닫기">${icon('close')}</button></header><label class="legal-document-picker">문서<select data-legal-document><option value="privacy">개인정보 안내</option><option value="licenses">프로젝트 라이선스 · Apache-2.0</option><option value="third-party">서드파티 고지</option><option value="characters">캐릭터 출처·라이선스</option><option value="font">폰트 · Pretendard OFL</option><option value="gsap">GSAP</option><option value="dependencies">코드 의존성 라이선스</option></select></label><p class="fine" data-legal-summary></p><div class="legal-document" tabindex="0" data-legal-body></div><p role="status" data-legal-status></p></dialog>`;
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
  const picker = root.querySelector<HTMLSelectElement>('[data-legal-document]')!;
  const body = root.querySelector<HTMLElement>('[data-legal-body]')!;
  const title = root.querySelector<HTMLElement>('dialog h2')!;
  const status = root.querySelector<HTMLElement>('[data-legal-status]')!;
  const summary = root.querySelector<HTMLElement>('[data-legal-summary]')!;
  const documents: Record<string, string> = { privacy, licenses: license, 'third-party': notices, characters: builtinCredits };
  let revision = 0;
  let disposed = false;

  // 개인정보 안내는 제목·문단으로 읽기 좋게 표시하고 라이선스 원문은 그대로 보존한다.
  function writeDocument(text: string, kind: string): void {
    // 1. 원문 라이선스는 HTML로 해석하지 않고 줄바꿈을 그대로 표시한다.
    body.dataset.documentKind = kind;
    body.replaceChildren();
    if (kind !== 'privacy') {
      body.textContent = text;
      return;
    }

    // 2. 개인정보 안내의 단순 제목·문단만 안전한 DOM으로 구성한다.
    for (const block of text.trim().split(/\n\s*\n/u)) {
      const heading = block.match(/^(#{1,3})\s+(.+)$/u);
      const element = document.createElement(heading ? heading[1].length === 1 ? 'h3' : 'h4' : 'p');
      element.textContent = (heading ? heading[2] : block).replace(/`([^`]+)`/gu, '$1');
      body.append(element);
    }
  }

  // 문서는 선택한 항목만 표시하고 네트워크로 받은 원문도 HTML로 해석하지 않는다.
  async function showDocument(): Promise<void> {
    // 1. 이전 조회의 응답이 새 문서나 닫힌 화면을 덮어쓰지 못하게 한다.
    const current = ++revision;
    const key = picker.value;
    title.textContent = picker.selectedOptions[0].textContent;
    writeDocument(documents[key] || '', key);
    body.scrollTop = 0;
    status.textContent = '';
    summary.textContent = key === 'privacy' ? '가입한 서버에 계정·펫·메시지가 저장됩니다. 외부 연결은 이 PC에서 처리하며, OS 알림 기록은 운영체제 설정을 따릅니다. 실제 보관 기간과 삭제 요청은 해당 서버 운영자에게 확인하세요.' : '프로젝트 코드와 포함된 폰트·캐릭터·라이브러리는 각각의 라이선스를 따릅니다.';
    const localDocuments: Record<string, string> = { dependencies: '/licenses/dependencies.txt', font: '/fonts/OFL.txt', gsap: '/licenses/GSAP-Standard-License.txt' };
    if (!localDocuments[key]) {
      return;
    }

    // 2. 큰 의존성 원문은 로컬 번들에서 필요할 때만 읽고 실패를 분명하게 알린다.
    status.textContent = '라이선스 원문을 불러오는 중이에요.';
    try {
      const response = await fetch(localDocuments[key]);
      if (!response.ok) {
        throw new Error('라이선스 파일을 불러오지 못했어요.');
      }
      const text = await response.text();
      if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
        throw new Error('배포 라이선스 파일이 없습니다.');
      }
      if (!disposed && current === revision) {
        body.textContent = text;
        status.textContent = '';
      }
    } catch {
      if (!disposed && current === revision) {
        status.textContent = '라이선스 원문을 읽지 못했어요. 배포 파일의 licenses 폴더를 확인하거나 다시 선택해 주세요.';
      }
    }
  }

  // 2. 진입 버튼·문서 선택·닫기와 배경 입력에 같은 모달 수명 규칙을 적용한다.
  root.querySelectorAll<HTMLButtonElement>('[data-legal-open]').forEach(button => {
    button.onclick = () => {
      picker.value = button.dataset.legalOpen!;
      void showDocument();
      dialog.showModal();
    };
  });
  picker.onchange = () => void showDocument();
  root.querySelector<HTMLButtonElement>('[data-legal-close]')!.onclick = () => dialog.close();
  dialog.onclick = event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      dialog.close();
    }
  };
  dialog.onclose = () => revision += 1;
  return () => {
    disposed = true;
    revision += 1;
    dialog.close();
  };
}
