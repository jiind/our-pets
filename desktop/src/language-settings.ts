import { getLocalePreference, html, setLocale, setText, t, watchLocale, type LocalePreference } from './i18n';

// 로그인 전과 계정 화면에서 같은 PC 언어 선택 컨트롤을 제공한다.
export function mountLanguageSettings(root: HTMLElement, compact = false): () => void {
  // 1. 언어 이름은 해당 언어의 고유 표기로 보여 주고 계정 정보와 별도로 저장한다.
  const id = `locale-${crypto.randomUUID()}`;
  root.className = compact ? 'language-settings language-settings-compact' : 'language-settings';
  root.innerHTML = html`<div class="language-control"><label for="${id}">앱 언어</label><select id="${id}"><option value="system">시스템 설정 따르기</option><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select></div><p class="fine error" role="status" data-language-error></p>`;
  const select = root.querySelector('select')!;
  const status = root.querySelector<HTMLElement>('[data-language-error]')!;
  let disposed = false;
  select.value = getLocalePreference();
  const stop = watchLocale(() => select.value = getLocalePreference());

  // 2. 저장에 성공한 설정만 적용하며 실패하면 이전 언어와 입력 상태를 유지한다.
  select.onchange = () => {
    select.disabled = true;
    status.textContent = '';
    void setLocale(select.value as LocalePreference).catch(() => {
      if (!disposed) {
        select.value = getLocalePreference();
        setText(status, () => t('언어 설정을 저장하지 못했어요. 다시 선택해 주세요.'));
      }
    }).finally(() => {
      if (!disposed) {
        select.disabled = false;
        select.focus({ preventScroll: true });
      }
    });
  };
  return () => {
    disposed = true;
    stop();
    select.onchange = null;
  };
}
