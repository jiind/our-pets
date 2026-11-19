import { getLocale, html, setLocale, setText, t, watchLocale, type Locale } from './i18n';
import koreanFlag from './assets/flags/kr.png';
import englishFlag from './assets/flags/us.png';

// 현재 국기 버튼 하나에서 앱 언어 선택지를 연다.
export function mountLanguageSettings(root: HTMLElement): () => void {
  const flags = { ko: koreanFlag, en: englishFlag };
  const id = `locale-${crypto.randomUUID()}`;
  root.classList.add('language-settings');
  root.innerHTML = html`<button type="button" class="language-toggle" aria-label="앱 언어" title="앱 언어" aria-controls="${id}" aria-expanded="false"><img class="language-flag" alt=""><span class="language-chevron" aria-hidden="true"></span></button>
  <div class="language-options" id="${id}" role="group" aria-label="앱 언어" hidden>
    <button type="button" data-language="ko" lang="ko"><img class="language-flag" src="${koreanFlag}" alt="">한국어</button>
    <button type="button" data-language="en" lang="en"><img class="language-flag" src="${englishFlag}" alt="">English</button>
  </div><p class="fine error" role="status" data-language-error></p>`;
  const toggle = root.querySelector<HTMLButtonElement>('.language-toggle')!;
  const flag = toggle.querySelector('img')!;
  const panel = root.querySelector<HTMLElement>('.language-options')!;
  const options = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-language]'));
  const status = root.querySelector<HTMLElement>('[data-language-error]')!;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let saving = false;
  const update = (): void => {
    const current = getLocale();
    flag.src = flags[current];
    options.forEach(option => option.setAttribute('aria-pressed', String(option.dataset.language === current)));
  };
  update();
  const stop = watchLocale(update);

  function showOptions(open: boolean): void {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      options.find(option => option.dataset.language === getLocale())?.focus({ preventScroll: true });
    }
  }

  toggle.addEventListener('click', () => showOptions(panel.hasAttribute('hidden')), { signal });
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !root.contains(event.target as Node)) {
      showOptions(false);
    }
  }, { signal });
  root.addEventListener('keydown', event => {
    if (panel.hidden) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      showOptions(false);
      toggle.focus({ preventScroll: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = options.findIndex(option => option === document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      options[(current + step + options.length) % options.length].focus({ preventScroll: true });
    }
  }, { signal });

  options.forEach(option => option.addEventListener('click', async () => {
    if (saving) {
      return;
    }
    saving = true;
    status.textContent = '';
    showOptions(false);
    toggle.focus({ preventScroll: true });
    try {
      await setLocale(option.dataset.language as Locale);
    } catch {
      if (!signal.aborted) {
        setText(status, () => t('앱 창 사이에 언어를 동기화하지 못했어요. 다시 선택해 주세요.'));
      }
    } finally {
      saving = false;
    }
  }, { signal }));
  return () => {
    lifetime.abort();
    stop();
  };
}
