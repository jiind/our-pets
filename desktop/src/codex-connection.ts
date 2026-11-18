import { fragment, html, htmlString, intlLocale, msg, setText, t } from './i18n';
export interface CodexConfig {
  kind: 'codex';
  executable: string;
  mode: 'interval' | 'once';
  usagePercent: number;
  pollSeconds: number;
  notifyExhausted: boolean;
  notifyRecovered: boolean;
  notifyOnRefresh: boolean;
}

export interface CodexUsage {
  checkedAt: number;
  ordinaryUsageAllowed: boolean | null;
  windows: { key: string; label: string; usedPercent: number; resetsAt: number | null; windowDurationMins: number | null }[];
}

// 공급자 이름은 보존하고 앱이 만든 한도 기간·구분만 현재 언어로 표시한다.
export function usageWindowLabel(window: CodexUsage['windows'][number]): string {
  // 1. 기존 저장 상태가 다른 언어로 만들어졌어도 공급자 부분만 그대로 복원한다.
  const separator = window.label.lastIndexOf(' · ');
  if (separator < 0) {
    return window.label;
  }
  const provider = separator >= 0 ? window.label.slice(0, separator) : window.label;
  const minutes = window.windowDurationMins;

  // 2. 서버가 제공한 실제 기간을 사용하며 사용자별 잔여량 계산은 변경하지 않는다.
  const duration = minutes && minutes > 0 ? minutes % 1440 === 0 ? msg`${minutes / 1440}일` : minutes % 60 === 0 ? msg`${minutes / 60}시간` : msg`${minutes}분` : window.key.endsWith('/primary') ? t('1차 한도') : t('2차 한도');
  return `${provider} · ${duration}`;
}

// 기존 연결 모달에 사용자 PC의 Codex 로그인과 알림 규칙 입력만 추가한다.
export function mountCodexForm(editor: HTMLElement): () => void {
  // 1. 다른 공급자와 같은 버튼·입력 스타일로 조회 전용 연결을 구성한다.
  const choice = document.createElement('button');
  choice.type = 'button';
  choice.dataset.provider = 'codex';
  choice.setAttribute('aria-pressed', 'false');
  choice.setAttribute('aria-controls', 'codex-editor');
  setText(choice, () => 'Codex');
  editor.querySelector('.provider-picker')!.append(choice);
  const section = document.createElement('section');
  section.id = 'codex-editor';
  section.hidden = true;
  section.innerHTML = html`<p>이 PC의 Codex에 로그인한 ChatGPT 계정의 사용량을 확인해요.</p><form id="local-codex-form"><input type="hidden" name="id"><label>표시 이름<input name="name" value="내 Codex" maxlength="80" required></label><label>사용량 알림<select name="mode"><option value="interval">일정 사용량마다 알림</option><option value="once">1회 알림</option></select></label><label><span data-usage-label>알림 간격 (%)</span><input name="usagePercent" type="number" min="1" max="100" step="1" value="10" required></label><p class="fine" data-usage-hint></p><fieldset class="local-event-types"><legend>추가 알림</legend><label><input type="checkbox" name="notifyExhausted" checked>한도 소진</label><label><input type="checkbox" name="notifyRecovered" checked>사용 가능 복구</label><label><input type="checkbox" name="notifyOnRefresh" checked>재조회 결과</label></fieldset><details><summary>조회 설정</summary><label>조회 간격 (초)<input name="pollSeconds" type="number" min="30" max="3600" step="1" value="60" required></label><label>Codex 실행 파일<input name="executable" value="codex" placeholder="codex 또는 실행 파일의 절대 경로" maxlength="1024" required></label><p class="fine">이 PC에서 codex login으로 로그인한 계정을 사용해요. 모델 작업을 실행하지 않고 한도만 조회해요.</p></details><p class="local-form-notice" role="status" aria-live="polite"></p><div class="connector-form-actions"><button type="submit" class="primary">Codex 연결 저장</button><button type="button" data-reset="local-codex-form" class="quiet">새 연결로 입력</button></div></form>`;
  editor.querySelector('.connector-create')!.append(section);
  const form = section.querySelector('form')!;

  // 2. 1회와 반복의 의미를 현재 설정 값과 함께 표시한다.
  function sync(): void {
    const mode = form.querySelector<HTMLSelectElement>('[name=mode]')!.value;
    const percent = form.querySelector<HTMLInputElement>('[name=usagePercent]')!.value;
    setText(section.querySelector('[data-usage-label]')!, () => mode === 'once' ? t('알림 받을 사용량 (%)') : t('알림 간격 (%)'));
    setText(section.querySelector('[data-usage-hint]')!, () => mode === 'once' ? t('각 한도 주기에서 지정 사용량에 도달하면 한 번 알려요.') : msg`${percent || 10}%씩 새 구간을 넘을 때 알려요. 처음 연결할 때 지난 구간을 몰아서 알리지 않아요.`);
  }
  form.addEventListener('change', sync);
  form.addEventListener('input', sync);
  form.addEventListener('reset', () => queueMicrotask(sync));
  sync();
  return sync;
}

// 비밀값이나 임의 명령 인자 없이 Codex 알림 설정을 만든다.
export function readCodexConfig(data: FormData): CodexConfig {
  return {
    kind: 'codex', executable: String(data.get('executable') || 'codex').trim(),
    mode: data.get('mode') === 'once' ? 'once' : 'interval',
    usagePercent: Number(data.get('usagePercent')), pollSeconds: Number(data.get('pollSeconds')),
    notifyExhausted: data.has('notifyExhausted'), notifyRecovered: data.has('notifyRecovered'), notifyOnRefresh: data.has('notifyOnRefresh'),
  };
}

// 마지막으로 받은 공개 사용률·조회 시각만 표시하며 리셋 예상으로 사용 가능을 추정하지 않는다.
export function renderCodexUsage(usage: CodexUsage | undefined, escape: (value: string) => string, provider: 'Codex' | 'Claude' = 'Codex'): string {
  if (!usage) {
    return htmlString('<p class="fine">첫 사용량 조회를 기다리고 있어요.</p>');
  }
  const time = new Date(usage.checkedAt);
  const checked = (): string => Number.isFinite(time.getTime()) ? time.toLocaleString(intlLocale()) : t('확인 불가');
  const windows = usage.windows.map(window => {
    const percent = 100 - Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
    const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
    const label = (): string => reset && Number.isFinite(reset.getTime()) ? reset.toLocaleString(intlLocale()) : t('미제공');
    return html`<div class="codex-quota"><div><span>${fragment(() => escape(usageWindowLabel(window)))}</span><strong>${fragment(() => percent)}% 남음</strong></div><progress max="100" value="${fragment(() => percent)}" aria-label="${fragment(() => escape(usageWindowLabel(window)))} 잔여량 ${fragment(() => percent)}%"></progress><p class="fine">다음 초기화: ${fragment(() => escape(label()))}</p></div>`;
  }).join('');
  const allowed = (): string => provider === 'Claude' ? Date.now() - usage.checkedAt > 60000 ? t('새 상태줄 전달 대기 · 마지막 전달값') : t('Claude 상태줄 전달값') : usage.ordinaryUsageAllowed === true ? t('Codex에서 사용 가능 확인') : usage.ordinaryUsageAllowed === false ? t('현재 사용 불가') : t('사용 가능 여부 미제공');
  return html`<div class="codex-usage">${fragment(() => windows || htmlString('<p class="fine">사용률 정보가 제공되지 않았어요.</p>'))}<p class="fine">${fragment(() => allowed())} · ${fragment(() => provider === 'Claude' ? t('수신') : t('조회'))} ${fragment(() => escape(checked()))}</p></div>`;
}
