import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import english from './locales/en.json';

export type Locale = 'ko' | 'en';
export type LocalePreference = 'system' | Locale;
type LocaleState = { preference: LocalePreference; locale: Locale };
const storageKey = 'ourpets.locale';
const messages: Readonly<Record<string, string>> = english;
const subscribers = new Set<(locale: Locale) => void>();
const bindings = new WeakMap<Element, Map<string, { read: () => string; last: string; node?: Text }>>();
const dynamic = Symbol('localized-ui');
type UIValue = { [dynamic]: () => unknown };
const pending = new Map<string, () => string>();
let preference = readPreference();
let locale = resolveLocale(preference, systemLocale());
let initialized = false;

// 명시적 선택이 없으면 OS 언어를 따르며 미지원·누락된 언어는 영어로 표시한다.
export function resolveLocale(value: LocalePreference, system: string | undefined): Locale {
  if (value !== 'system') {
    return value;
  }
  return system?.trim().split(/[-_.@]/u)[0].toLowerCase() === 'ko' ? 'ko' : 'en';
}

// 웹 미리보기에서는 브라우저가 제공하는 OS의 우선 언어만 사용한다.
function systemLocale(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.languages?.[0] || navigator.language;
}

// 저장한 명시적 선택만 복원하고 처음 사용하거나 손상된 값은 시스템 설정을 따른다.
function readPreference(): LocalePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === 'ko' || saved === 'en' ? saved : 'system';
  } catch {
    return 'system';
  }
}

// 자동 선택 여부를 표시 언어와 구분해 언어 선택 컨트롤에 반환한다.
export function getLocalePreference(): LocalePreference {
  return preference;
}

// 현재 화면에서 사용할 앱 언어를 반환한다.
export function getLocale(): Locale {
  return locale;
}

// 숫자와 날짜도 선택한 앱 언어의 표기 규칙을 따른다.
export function intlLocale(): string {
  return locale === 'en' ? 'en-US' : 'ko-KR';
}

// 고정 앱 문구만 번역하고 보간한 사용자 값은 다시 번역하거나 HTML로 해석하지 않는다.
export function t(source: string, values: readonly unknown[] = []): string {
  if (!source.trim()) {
    return source;
  }
  const key = source.trim();
  const translated = locale === 'en' ? messages[key] ?? key : key;
  const result = translated.replace(/\{(\d+)\}/gu, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token);
  return source.slice(0, source.length - source.trimStart().length) + result + source.slice(source.trimEnd().length);
}

// 템플릿의 고정 문구와 사용자 값을 분리해 언어별 어순으로 보간한다.
export function msg(parts: TemplateStringsArray, ...values: unknown[]): string {
  return t(parts.reduce((source, part, index) => source + (index ? `{${index - 1}}` : '') + part, ''), values);
}

// 인증·검증 오류는 알려진 서버 문구만 번역하고 알 수 없는 외부 원문은 유지한다.
export function translateError(message: string): string {
  if (messages[message]) {
    return t(message);
  }
  for (const provider of ['Codex', 'Claude']) {
    if (message.startsWith(provider + ' ')) {
      const source = '{0}' + message.slice(provider.length);
      if (messages[source]) {
        return t(source, [provider]);
      }
    }
  }
  return message;
}

// HTML 속성과 고정 UI 문구를 안전하게 직렬화한다.
function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

// 기존 HTML 템플릿의 문자 참조만 복원하며 동적 사용자 HTML은 실행하지 않는다.
function decodeHTML(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|nbsp|copy|hellip|times|#\d+|#x[\da-f]+);/giu, (token, key: string) => {
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(key[1].toLowerCase() === 'x' ? 2 : 1), key[1].toLowerCase() === 'x' ? 16 : 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0', copy: '©', hellip: '…', times: '×' } as Record<string, string>)[key.toLowerCase()];
  });
}

// UI의 조건부 문구만 재계산 가능하게 표시하고 일반 사용자 값과 구분한다.
export function fragment(read: () => unknown): UIValue {
  return { [dynamic]: read };
}

// 화면에 아직 삽입하지 않은 UI 계산은 작은 임시 색인에서만 보관한다.
function register(read: () => string): string {
  if (pending.size >= 4096) {
    pending.delete(pending.keys().next().value!);
  }
  const id = crypto.randomUUID();
  pending.set(id, read);
  return id;
}

// 보간 값 중 명시적으로 표시한 UI 계산만 실행하고 일반 데이터는 그대로 반환한다.
function resolve(value: unknown): unknown {
  return value && typeof value === 'object' && dynamic in value ? (value as UIValue)[dynamic]() : value;
}

// UI 리터럴에만 번역 표식을 붙이고 보간된 사용자 데이터·SVG·선택값은 보존한다.
export function html(parts: TemplateStringsArray | readonly string[], ...values: unknown[]): string {
  // 1. 보간 값은 번역 처리 뒤에 삽입해 사용자 이름·본문을 번역 대상으로 만들지 않는다.
  const slot = /\uE000(\d+)\uE001/gu;
  const resolved = values.map(resolve);
  const source = parts.reduce((result, part, index) => result + (index ? `\uE000${index - 1}\uE001` : '') + part, '');
  let raw = '';
  const translated = source.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gu, token => {
    if (token.startsWith('<')) {
      if (/^<\/(?:textarea|script|style)\b/iu.test(token)) {
        raw = '';
        return token;
      }
      if (/^<(?:textarea|script|style)\b/iu.test(token)) {
        raw = token;
      }
      const attributes: { name: string; parts: string[]; values: string[]; last: string; binding?: string }[] = [];
      const tag = token.replace(/\b(aria-label|aria-description|title|alt|placeholder|value)\s*=\s*("([^"]*)"|'([^']*)')/gu, (attribute, name: string, _quoted: string, double: string | undefined, single: string | undefined) => {
        const original = double ?? single ?? '';
        const indices = [...original.matchAll(slot)].map(match => Number(match[1]));
        const reactive = indices.some(index => values[index] && typeof values[index] === 'object' && dynamic in (values[index] as object));
        if (name === 'value') {
          return indices.length || !/[가-힣]/u.test(original) ? attribute : `value="${escapeHTML(t(decodeHTML(original)))}"`;
        }
        if (!/[가-힣]/u.test(original) && !reactive) {
          return attribute;
        }
        const chunks = original.split(/\uE000\d+\uE001/gu).map(decodeHTML);
        const parameters = indices.map(index => decodeHTML(String(resolved[index])));
        const last = chunks.map((chunk, index) => (index ? parameters[index - 1] : '') + t(chunk)).join('');
        const binding = reactive ? register(() => chunks.map((chunk, index) => (index ? decodeHTML(String(resolve(values[indices[index - 1]]))) : '') + t(chunk)).join('')) : undefined;
        attributes.push({ name, parts: chunks, values: parameters, last, binding });
        return `${name}="${chunks.map((chunk, index) => (index ? `\uE000${indices[index - 1]}\uE001` : '') + escapeHTML(t(chunk))).join('')}"`;
      });
      return attributes.length ? tag.replace(/\s*\/?>$/u, ending => ` data-i18n-attributes="${escapeHTML(JSON.stringify(attributes))}"${ending}`) : tag;
    }
    if (raw) {
      return token;
    }
    return token.split(/(\uE000\d+\uE001)/gu).map(chunk => {
      const index = chunk.match(/^\uE000(\d+)\uE001$/u);
      if (index) {
        const value = values[Number(index[1])];
        if (value && typeof value === 'object' && dynamic in value && !/<(?:[a-z]|!--)/iu.test(String(resolved[Number(index[1])])) ) {
          const id = register(() => decodeHTML(String(resolve(value))));
          return `<!--ourpets-ui:${id}-->${chunk}<!--/ourpets-ui-->`;
        }
      }
      if (!/[가-힣]/u.test(chunk)) {
        return chunk;
      }
      const original = decodeHTML(chunk);
      return `<!--ourpets-i18n:${encodeURIComponent(original)}-->${escapeHTML(t(original))}<!--/ourpets-i18n-->`;
    }).join('');
  });

  // 2. 동적 값은 호출자가 이미 처리한 HTML 이스케이프와 마크업을 그대로 유지한다.
  return translated.replace(slot, (_token, index: string) => String(resolved[Number(index)]));
}

// 보간이 없는 고정 HTML도 같은 안전한 번역 경계를 사용한다.
export function htmlString(source: string): string {
  return html([source]);
}

// 동적 UI 문구의 계산만 보관해 언어 전환 때 입력과 연결을 다시 만들지 않는다.
export function setText(element: Element, read: () => string): void {
  // 1. 현재 문구와 계산을 요소의 수명에 묶고 같은 문자열의 DOM 변경은 생략한다.
  const value = read();
  const own = bindings.get(element) ?? new Map();
  if (element.textContent !== value || element.childNodes.length !== 1 || element.firstChild?.nodeType !== Node.TEXT_NODE) {
    element.textContent = value;
  }
  own.set('textContent', { read, last: value, node: element.firstChild?.nodeType === Node.TEXT_NODE ? element.firstChild as Text : undefined });
  bindings.set(element, own);
}

// 접근성 이름·도움말·플레이스홀더도 사용자 입력을 건드리지 않고 갱신한다.
export function setAttribute(element: Element, name: string, read: () => string): void {
  const value = read();
  const own = bindings.get(element) ?? new Map();
  own.set(name, { read, last: value });
  bindings.set(element, own);
  element.setAttribute(name, value);
}

// 앱이 명시적으로 표시한 고정 UI 표식과 동적 문구만 다시 계산한다.
export function refreshTranslations(root: Node = document): void {
  // 1. 사용자 본문·입력·실행 코드는 읽지 않고 앱이 만든 주석 사이의 텍스트만 바꾼다.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let comment: Node | null = walker.nextNode();
  while (comment) {
    if (comment.nodeValue?.startsWith('ourpets-ui:')) {
      const text = comment.nextSibling;
      const read = pending.get(comment.nodeValue.slice('ourpets-ui:'.length));
      if (read && text?.nodeType === Node.TEXT_NODE && text.nextSibling?.nodeValue === '/ourpets-ui') {
        const element = comment.parentElement;
        if (element) {
          const own = bindings.get(element) ?? new Map();
          own.set(comment.nodeValue, { read, last: text.nodeValue || '', node: text as Text });
          bindings.set(element, own);
          pending.delete(comment.nodeValue.slice('ourpets-ui:'.length));
        }
      }
    }
    if (comment.nodeValue?.startsWith('ourpets-i18n:')) {
      const text = comment.nextSibling;
      if (text?.nodeType === Node.TEXT_NODE && text.nextSibling?.nodeValue === '/ourpets-i18n') {
        text.nodeValue = t(decodeURIComponent(comment.nodeValue.slice('ourpets-i18n:'.length)));
      }
    }
    comment = walker.nextNode();
  }

  // 2. UI가 나중에 다른 값으로 바꾼 속성은 덮어쓰지 않으며 폼 값에는 접근하지 않는다.
  const elements = root instanceof Element ? [root, ...root.querySelectorAll('*')] : root instanceof Document || root instanceof DocumentFragment ? [...root.querySelectorAll('*')] : [];
  for (const element of elements) {
    const serialized = element.getAttribute('data-i18n-attributes');
    if (serialized) {
      const attributes = JSON.parse(serialized) as { name: string; parts: string[]; values: string[]; last: string; binding?: string }[];
      for (const attribute of attributes) {
        const read = attribute.binding ? pending.get(attribute.binding) : undefined;
        if (read) {
          setAttribute(element, attribute.name, read);
          pending.delete(attribute.binding!);
          continue;
        }
        if (attribute.binding) {
          continue;
        }
        if (element.getAttribute(attribute.name) === attribute.last) {
          attribute.last = attribute.parts.map((part, index) => (index ? attribute.values[index - 1] : '') + t(part)).join('');
          element.setAttribute(attribute.name, attribute.last);
        }
      }
      element.setAttribute('data-i18n-attributes', JSON.stringify(attributes));
    }
    bindings.get(element)?.forEach((binding, name) => {
      if (binding.node) {
        if (binding.node.parentElement === element && binding.node.nodeValue === binding.last) {
          binding.last = binding.read();
          binding.node.nodeValue = binding.last;
        }
      } else if (name !== 'textContent' && element.getAttribute(name) === binding.last) {
        binding.last = binding.read();
        element.setAttribute(name, binding.last);
      }
    });
  }
}

// 표시 언어와 선택 방식을 함께 갱신하며 폼·실시간 연결은 다시 만들지 않는다.
function applyLocale(state: LocaleState): void {
  preference = state.preference;
  locale = state.locale;
  try {
    if (localStorage.getItem(storageKey) !== preference) {
      localStorage.setItem(storageKey, preference);
    }
  } catch {
    // 저장할 수 없는 환경에서도 현재 표시 언어는 바꾼다.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.title = t('우리 펫');
    refreshTranslations();
  }
  subscribers.forEach(listener => listener(locale));
}

// 명시적 언어 또는 시스템 설정을 PC에 저장하고 모든 앱 창에 전파한다.
export async function setLocale(value: LocalePreference): Promise<void> {
  if (value !== 'system' && value !== 'ko' && value !== 'en') {
    throw new Error(t('지원하지 않는 언어입니다.'));
  }
  const saved = typeof window !== 'undefined' && isTauri()
    ? await invoke<LocaleState>('set_locale', { locale: value })
    : { preference: value, locale: resolveLocale(value, systemLocale()) };
  applyLocale(saved);
}

// 화면 수명에 맞춰 언어 변경 구독을 등록하고 해제한다.
export function watchLocale(listener: (value: Locale) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

// 저장된 PC 언어·창 간 이벤트·새 UI 표식의 초기 번역을 한 번만 연결한다.
export async function initializeLocale(): Promise<void> {
  // 1. 네이티브에서는 언어 이벤트를 먼저 구독하고 같은 PC의 저장 값을 읽는다.
  if (initialized) {
    return;
  }
  initialized = true;
  if (isTauri()) {
    await listen<LocaleState>('locale-changed', event => applyLocale(event.payload));
    applyLocale(await invoke<LocaleState>('get_locale'));
  } else {
    applyLocale({ preference: readPreference(), locale: resolveLocale(readPreference(), systemLocale()) });
    window.addEventListener('storage', event => {
      if (event.key === storageKey) {
        const saved = readPreference();
        applyLocale({ preference: saved, locale: resolveLocale(saved, systemLocale()) });
      }
    });
  }

  // 2. 새 화면도 명시적 UI 표식만 번역하며 메시지·닉네임·PNG·입력은 해석하지 않는다.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.addedNodes.length) {
        refreshTranslations(record.target);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
