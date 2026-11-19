import { fragment, html, setText, t } from './i18n';
import { icon } from './icons';
import privacy from '../../PRIVACY.md?raw';
import license from '../../LICENSE?raw';
import notices from '../../THIRD_PARTY_NOTICES.md?raw';
import { builtinCredits } from './builtin-pets';

// 계정 화면의 보조 영역에서 개인정보·라이선스 원문을 안전한 텍스트 모달로 제공한다.
export function mountLegalInfo(root: HTMLElement): () => void {
  // 1. 같은 문서 목록에서 개별 진입 버튼과 접근 가능한 원문 읽기 모달을 만든다.
  const id = `legal-${crypto.randomUUID()}`;
  const documents: ReadonlyArray<{ key: string; title: string; text?: string; path?: string }> = [
    {
      key: 'privacy',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('개인정보 안내');
      },
      text: privacy
    },
    {
      key: 'licenses',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('프로젝트 라이선스 · Apache-2.0');
      },
      text: license
    },
    {
      key: 'third-party',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('서드파티 고지');
      },
      text: notices
    },
    {
      key: 'characters',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('캐릭터 출처·라이선스');
      },
      // 캐릭터 안내만 번역하고 인용한 라이선스 원문은 보존한다.
      get text() {
        return builtinCredits();
      }
    },
    {
      key: 'font',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('폰트 · Pretendard OFL');
      },
      path: '/fonts/OFL.txt'
    },
    { key: 'gsap', title: 'GSAP', path: '/licenses/GSAP-Standard-License.txt' },
    {
      key: 'dependencies',
      // 선택한 앱 언어로 고정 표시 문구를 계산한다.
      get title() {
        return t('코드 의존성 라이선스');
      },
      path: '/licenses/dependencies.txt'
    },
  ];
  root.innerHTML = html`<section class="account-info"><h2>정보 및 고지</h2><div class="account-info-links">${fragment(() => documents.map(document => html`<button type="button" class="quiet" data-legal-open="${fragment(() => document.key)}" aria-haspopup="dialog" aria-controls="${fragment(() => id)}-dialog">${fragment(() => document.title)}</button>`).join(''))}</div></section><dialog id="${fragment(() => id)}-dialog" class="legal-dialog" aria-labelledby="${fragment(() => id)}-title"><header><h2 id="${fragment(() => id)}-title">정보 및 고지</h2><button type="button" class="menu-close" data-legal-close aria-label="정보 및 고지 닫기">${fragment(() => icon('close'))}</button></header><p class="fine" data-legal-summary></p><div class="legal-document" tabindex="0" data-legal-body></div><p role="status" data-legal-status></p></dialog>`;
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
  const body = root.querySelector<HTMLElement>('[data-legal-body]')!;
  const title = root.querySelector<HTMLElement>('dialog h2')!;
  const status = root.querySelector<HTMLElement>('[data-legal-status]')!;
  const summary = root.querySelector<HTMLElement>('[data-legal-summary]')!;
  let revision = 0;
  let disposed = false;
  let opener: HTMLButtonElement | undefined;

  // 개인정보 안내는 제목·문단으로 읽기 좋게 표시하고 라이선스 원문은 그대로 보존한다.
  function writeDocument(text: string, kind: string): void {
    // 1. 원문 라이선스는 HTML로 해석하지 않고 줄바꿈을 그대로 표시한다.
    body.dataset.documentKind = kind;
    body.replaceChildren();
    if (kind !== 'privacy') {
      setText(body, () => kind === 'characters' ? builtinCredits() : text);
      return;
    }

    // 2. 개인정보 안내의 단순 제목·문단만 안전한 DOM으로 구성한다.
    for (const block of text.trim().split(/\n\s*\n/u)) {
      const heading = block.match(/^(#{1,3})\s+(.+)$/u);
      const element = document.createElement(heading ? heading[1].length === 1 ? 'h3' : 'h4' : 'p');
      setText(element, () => (heading ? heading[2] : block).replace(/`([^`]+)`/gu, '$1'));
      body.append(element);
    }
  }

  // 문서는 선택한 항목만 표시하고 네트워크로 받은 원문도 HTML로 해석하지 않는다.
  async function showDocument(document: typeof documents[number]): Promise<void> {
    // 1. 이전 조회의 응답이 새 문서나 닫힌 화면을 덮어쓰지 못하게 한다.
    const current = ++revision;
    const key = document.key;
    setText(title, () => document.title);
    writeDocument(document.text || '', key);
    body.scrollTop = 0;
    status.textContent = '';
    setText(summary, () => key === 'privacy' ? t('가입한 서버에 계정·펫·메시지가 저장됩니다. 외부 연결은 이 PC에서 처리하며, OS 알림 기록은 운영체제 설정을 따릅니다. 실제 보관 기간과 삭제 요청은 해당 서버 운영자에게 확인하세요.') : t('프로젝트 코드와 포함된 폰트·캐릭터·라이브러리는 각각의 라이선스를 따릅니다.'));
    if (!document.path) {
      return;
    }

    // 2. 큰 의존성 원문은 로컬 번들에서 필요할 때만 읽고 실패를 분명하게 알린다.
    setText(status, () => t('라이선스 원문을 불러오는 중이에요.'));
    try {
      const response = await fetch(document.path);
      if (!response.ok) {
        throw new Error(t('라이선스 파일을 불러오지 못했어요.'));
      }
      const text = await response.text();
      if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
        throw new Error(t('배포 라이선스 파일이 없습니다.'));
      }
      if (!disposed && current === revision) {
        setText(body, () => text);
        status.textContent = '';
      }
    } catch {
      if (!disposed && current === revision) {
        setText(status, () => t('라이선스 원문을 읽지 못했어요. 창을 닫고 다시 열거나 배포 파일의 licenses 폴더를 확인해 주세요.'));
      }
    }
  }

  // 2. 각 문서 버튼은 해당 원문만 열고 닫기·배경 입력은 같은 모달 수명 규칙을 따른다.
  root.querySelectorAll<HTMLButtonElement>('[data-legal-open]').forEach(button => {
    button.onclick = () => {
      const document = documents.find(document => document.key === button.dataset.legalOpen)!;
      opener = button;
      void showDocument(document);
      dialog.showModal();
    };
  });
  root.querySelector<HTMLButtonElement>('[data-legal-close]')!.onclick = () => dialog.close();
  dialog.onclick = event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      dialog.close();
    }
  };
  dialog.onclose = () => {
    if (!dialog.open) {
      revision += 1;
      if (!disposed) {
        opener?.focus({ preventScroll: true });
      }
    }
  };
  return () => {
    disposed = true;
    revision += 1;
    dialog.close();
  };
}
