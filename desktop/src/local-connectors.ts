import { icon } from './icons';
import { mountClaudeForm, readClaudeConfig, type ClaudeConfig } from './claude-connection';
import { mountCodexForm, readCodexConfig, renderCodexUsage, type CodexConfig, type CodexUsage } from './codex-connection';
import { listen } from '@tauri-apps/api/event';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { session } from './api';

const dockerActionOptions = [
  { value: 'start', label: '시작' },
  { value: 'die', label: '종료' },
  { value: 'restart', label: '재시작' },
  { value: 'health_status', label: '상태 검사 변경' },
  { value: 'stop', label: '중지' },
  { value: 'destroy', label: '삭제' },
];

export type LocalConfig = { kind: 'docker'; endpoint: string; containers: string[]; actions: string[] } | { kind: 'slack'; teamId: string; channels: string[]; eventTypes: string[] } | CodexConfig | ClaudeConfig;
interface LocalSource {
  id: string;
  name: string;
  config: LocalConfig;
  enabled: boolean;
  state: string;
  lastError: string;
  codexUsage?: CodexUsage;
  claudeUsage?: CodexUsage;
}

// 로컬 입력을 HTML로 해석하지 않는 텍스트로 변환한다.
function safe(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

// 쉼표로 입력한 채널·컨테이너 이름을 중복 없는 목록으로 만든다.
function values(value: FormDataEntryValue | null): string[] {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))];
}

// 수신 연결 상태를 내부 코드 대신 이해할 수 있는 한글로 표시한다.
function stateLabel(state: string): string {
  return ({ connected: '수신 중', connecting: '연결 중', reconnecting: '재접속 대기', stopped: '중지됨', disabled: '중지됨', waiting: '새 전달 대기' } as Record<string, string>)[state] || '상태 확인 필요';
}

// 중지·정상·대기·연결 오류를 구분해 상태 배지의 의미 색상을 정한다.
function stateTone(source: LocalSource): 'success' | 'pending' | 'error' | 'idle' {
  // 1. 의도적으로 멈춘 연결과 정상 연결은 오류 문구보다 현재 상태를 우선한다.
  if (['stopped', 'disabled'].includes(source.state)) {
    return 'idle';
  }
  if (source.state === 'connected') {
    return 'success';
  }

  // 2. 새 전달을 기다리는 상태와 오류 없는 접속 시도만 대기로 표시한다.
  if (source.state === 'waiting' || (!source.lastError && ['connecting', 'reconnecting'].includes(source.state))) {
    return 'pending';
  }
  return 'error';
}

// 원본 오류나 인증정보를 출력하지 않고 원인별 복구 방법만 안내한다.
function recovery(error: unknown, kind?: LocalConfig['kind']): string {
  // 1. 원본을 화면에 노출하지 않고 중복 연결과 인증 원인만 분류한다.
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (kind === 'claude' || message.includes('claude')) {
    const original = String(error instanceof Error ? error.message : error);
    return original.length < 400 && /Claude|상태줄|세션|사용량/.test(original) ? original : 'Claude 상태줄 연결을 적용하고 수신할 세션을 선택하세요. Claude Code의 활동 후 새 값을 받을 수 있어요.';
  }
  if (message.includes('codex') && message.includes('이미')) {
    return '이 PC의 Codex 연결이 이미 있어요. 외부 연결에서 기존 연결을 수정하세요.';
  }
  if (kind === 'codex' || message.includes('codex')) {
    const original = String(error instanceof Error ? error.message : error);
    if (original.length <= 400 && /Codex|ChatGPT|사용량|조회/.test(original)) {
      return original;
    }
    return 'Codex 실행 파일과 이 PC의 ChatGPT 계정 로그인을 확인하세요. 조회에는 인터넷이 필요해요. 저장한 경로·알림 규칙을 확인한 뒤 다시 연결하세요.';
  }
  if (message.includes('같은 slack') || message.includes('이미 있습니다')) {
    return '같은 Slack 앱의 연결이 이미 있어요. 외부 연결에서 기존 연결을 수정하세요.';
  }
  if (message.includes('이름')) {
    return '표시 이름은 1~80바이트 범위로 입력하세요. 한글은 보통 한 글자에 3바이트입니다.';
  }
  if (message.includes('토큰') || message.includes('auth') || message.includes('credential') || message.includes('자격증명')) {
    return 'Slack 앱의 xapp- 토큰과 connections:write 권한, 이 PC의 보안 저장소를 확인한 뒤 다시 저장하세요. 수정할 때 토큰을 비우면 기존 값을 유지합니다.';
  }

  // 2. 수신 대상과 권한 문제에는 설정에서 바로 고칠 수 있는 방법을 안내한다.
  if (message.includes('워크스페이스') || message.includes('채널') || message.includes('team') || message.includes('channel')) {
    return '워크스페이스 ID는 T로, 채널 ID는 C·D·G로 시작해야 해요. Slack 앱의 채널 접근 권한과 이벤트 구독도 확인하세요.';
  }
  if (message.includes('권한') || message.includes('permission') || message.includes('denied')) {
    return kind === 'docker' ? '이 PC에서 Docker가 실행 중인지, 현재 계정에 소켓 접근 권한이 있는지 확인하고 다시 연결하세요.' : 'Slack 앱의 Socket Mode, 이벤트 구독과 채널 접근 권한을 확인하고 다시 연결하세요.';
  }

  // 3. 나머지 오류는 공급자별 연결 확인과 재시도 방법으로 안내한다.
  if (kind === 'docker') {
    return 'Docker 실행 상태와 주소를 확인하세요. 이 PC의 기본 엔진은 local을 사용하고, 직접 지정한 주소에는 인증정보나 API 경로를 넣지 마세요. 확인 후 다시 시도할 수 있어요.';
  }
  if (kind === 'slack') {
    return '인터넷 연결과 Slack 앱의 Socket Mode·이벤트 구독을 확인한 뒤 다시 시도하세요. 입력 내용은 유지됩니다.';
  }
  return '이 PC의 연결 정보를 읽지 못했어요. 상태 새로고침으로 다시 시도하세요. 계속 실패하면 앱의 로컬 저장소 접근 권한을 확인하세요.';
}

// 사용자 개인 Docker·Slack·Codex·Claude 연결을 현재 PC에만 설정하는 화면을 구성한다.
export async function mountLocalConnectors(root: HTMLElement): Promise<() => void> {
  // 1. 브라우저에서는 비밀값을 받지 않고 데스크톱에서는 공급자별 입력을 나눠 표시한다.
  const current = session();
  if (!current || current.principal.expiresAt <= Date.now()) {
    root.innerHTML = '<p role="status">로그인한 뒤 알림 메뉴에서 연결을 설정해 주세요.</p>';
    return () => {};
  }
  if (!isTauri()) {
    root.innerHTML = '<section class="connector-intro"><h2>내 PC의 Docker · Slack · Codex · Claude 연결</h2><p>데스크톱 앱에서 연결할 수 있어요. 이 PC에서 직접 소식을 받아 내 펫에만 표시합니다.</p></section>';
    return () => {};
  }
  let sources: LocalSource[] = [];
  let saving = false;
  let sourceActionBusy = false;
  let disposed = false;
  let sourceFingerprint = "";
  const editorID = `connector-editor-${crypto.randomUUID()}`;
  root.innerHTML = `
  <section class="connector-existing"><div class="section-label"><h2>외부 연결</h2><div class="connector-list-actions"><button id="refresh-local-sources" type="button" class="icon-button icon-button-compact" aria-label="연결 상태 새로고침" title="연결 상태 새로고침" aria-busy="false">${icon('refresh')}</button><button id="add-local-source" type="button" class="icon-button icon-button-compact primary" aria-label="연결 추가" title="연결 추가">${icon('plus')}</button></div></div><p id="local-source-notice" role="status"></p><div id="local-source-list"></div></section>
  <dialog class="connector-dialog" aria-labelledby="${editorID}"><section class="connector-create"><div class="connector-dialog-heading"><h2 id="${editorID}">연결 추가·수정</h2><button type="button" class="menu-close" data-editor-close aria-label="연결 추가·수정 닫기">${icon('close')}</button></div><div class="provider-picker" role="group" aria-label="알림 공급자 선택"><button type="button" data-provider="docker" aria-pressed="true" aria-controls="docker-editor">Docker</button><button type="button" data-provider="slack" aria-pressed="false" aria-controls="slack-editor">Slack</button></div>
  <section id="docker-editor"><p>Docker 엔진의 컨테이너 상태 변경을 받아요.</p><form id="local-docker-form"><input type="hidden" name="id"><label>표시 이름<input name="name" value="내 Docker" maxlength="80" required></label><label>Docker 주소<input name="endpoint" value="local" placeholder="local" maxlength="1024" required></label><p class="fine">이 PC의 기본 Docker 엔진은 local을 그대로 사용하세요.</p><details><summary>주소와 수신 범위 자세히 설정</summary><p class="fine">local은 Unix 소켓·Windows 파이프를 자동 선택합니다. 직접 지정한 unix·npipe·http(s)·tcp 주소도 사용할 수 있어요. 인증정보와 API 경로는 주소에 넣지 마세요.</p><label>컨테이너 이름 또는 ID · 쉼표로 구분<input name="containers" placeholder="비워두면 모든 컨테이너"></label><fieldset class="local-event-types"><legend>수신 동작</legend><label><input type="checkbox" name="allActions">전체 수신</label><div class="local-event-options" data-docker-actions></div></fieldset></details><p class="local-form-notice" role="status" aria-live="polite"></p><div class="connector-form-actions"><button type="submit" class="primary">Docker 연결 저장</button><button type="button" data-reset="local-docker-form" class="quiet">새 연결로 입력</button></div></form></section>
  <section id="slack-editor" hidden><p>Slack 앱이 접근할 수 있는 채널의 소식을 받아요. Socket Mode를 켠 앱이 필요합니다.</p><form id="local-slack-form"><input type="hidden" name="id"><label>표시 이름<input name="name" value="내 Slack" maxlength="80" required></label><label>워크스페이스 ID<input name="teamId" placeholder="T0123456789" pattern="T[A-Z0-9]{2,63}" required></label><label>채널 ID · 쉼표로 구분<input name="channels" placeholder="C0123456789,D0123456789" required></label><label>앱 수준 토큰<input name="appToken" type="password" autocomplete="new-password" placeholder="xapp-… · 수정 시 비우면 기존 값 유지"></label><details><summary>Slack 앱 준비와 수신 범위</summary><p class="fine">Socket Mode와 connections:write 권한의 xapp- 토큰을 사용하세요. 일반 Slack 로그인이나 xoxb 토큰으로 대체할 수 없어요. 앱에 아래 이벤트 구독과 채널 접근 권한을 설정해야 합니다.</p><fieldset class="local-event-types"><legend>수신할 소식</legend>${[['message', '메시지'], ['app_mention', '앱 멘션'], ['reaction_added', '반응 추가'], ['reaction_removed', '반응 삭제']].map(([value, label]) => `<label><input name="eventTypes" type="checkbox" value="${value}" checked>${label}</label>`).join('')}</fieldset></details><p class="local-form-notice" role="status" aria-live="polite"></p><div class="connector-form-actions"><button type="submit" class="primary">Slack 연결 저장</button><button type="button" data-reset="local-slack-form" class="quiet">새 연결로 입력</button></div></form></section></section></dialog>`;
  const notice = root.querySelector<HTMLElement>('#local-source-notice')!;
  const editor = root.querySelector<HTMLDialogElement>('.connector-dialog')!;
  const syncCodexForm = mountCodexForm(editor);
  const claudeForm = mountClaudeForm(editor);
  const dockerForm = root.querySelector<HTMLFormElement>('#local-docker-form')!;
  const allDockerActions = dockerForm.querySelector<HTMLInputElement>('[name=allActions]')!;

  // 전체 수신이나 저장 중에는 개별 동작 선택을 잠그고 선택값은 보존한다.
  function updateDockerActionInputs(): void {
    dockerForm.querySelectorAll<HTMLInputElement>('[name=actions]').forEach(input => {
      input.disabled = saving || allDockerActions.checked;
    });
  }

  // 기본·기존 수신 동작을 같은 체크박스 목록으로 만들고 사용자 지정 동작도 보존한다.
  function renderDockerActions(selected?: string[]): void {
    // 1. 새 연결은 기존 여섯 기본값을 사용하고 빈 저장 목록만 전체 수신으로 복원한다.
    const choices = new Map(dockerActionOptions.map(option => [option.value, option.label]));
    const checked = new Set(selected ?? dockerActionOptions.map(option => option.value));
    checked.forEach(value => {
      if (!choices.has(value)) {
        choices.set(value, `${value} · 기존 설정`);
      }
    });
    allDockerActions.checked = selected?.length === 0;

    // 2. 저장된 동작 이름은 HTML로 해석하지 않고 개별 선택 상태를 연결한다.
    const target = dockerForm.querySelector<HTMLElement>('[data-docker-actions]')!;
    target.replaceChildren();
    choices.forEach((caption, value) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'actions';
      input.value = value;
      input.checked = checked.has(value);
      label.append(input, document.createTextNode(caption));
      target.append(label);
    });
    updateDockerActionInputs();
  }
  allDockerActions.onchange = updateDockerActionInputs;
  renderDockerActions();

  // 선택된 공급자의 폼을 모달로 열고 표시 이름부터 입력할 수 있게 한다.
  function openEditor(): void {
    // 1. 표시 중인 화면에서 저장과 겹치지 않을 때만 모달을 연다.
    if (!root.isConnected || editor.open || saving) {
      return;
    }
    editor.showModal();

    // 2. 현재 공급자의 이름 입력으로 포커스를 옮긴다.
    const kind = root.querySelector<HTMLButtonElement>('[data-provider][aria-pressed=true]')!.dataset.provider;
    root.querySelector<HTMLInputElement>(`#local-${kind}-form [name=name]`)!.focus({ preventScroll: true });
  }

  // 닫기·배경 입력은 네이티브 dialog의 포커스 복원과 함께 처리한다.
  function closeEditor(): void {
    if (editor.open) {
      editor.close();
    }
  }

  // 하나의 연결 저장 중에는 공급자 전환이나 추가 저장으로 입력이 바뀌지 않게 한다.
  function setEditorBusy(value: boolean): void {
    // 1. 모달 진입과 제출에서 확인하는 저장 상태를 먼저 반영한다.
    saving = value;

    // 2. 폼·공급자 전환·새 연결 진입을 같은 저장 상태로 제한한다.
    editor.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('form input, form button, form select, [data-provider]').forEach(control => {
      control.disabled = value;
    });
    root.querySelector<HTMLButtonElement>('#add-local-source')!.disabled = value;
    updateDockerActionInputs();
    claudeForm.setBusy(value);
  }

  // 새 연결은 기존 수정 ID와 입력을 비운 뒤 모달에서 시작한다.
  function addConnection(): void {
    // 1. 저장 중인 연결은 유지하고 새 입력을 동시에 만들지 않는다.
    if (saving) {
      return;
    }
    editor.querySelectorAll<HTMLFormElement>('form').forEach(form => {
      form.reset();
      form.querySelector<HTMLInputElement>('[name=id]')!.value = '';
      form.querySelector<HTMLElement>('.local-form-notice')!.textContent = '';
    });

    // 2. 수신 동작과 공급자 기본 선택을 복원하고 입력 모달을 연다.
    renderDockerActions();
    chooseProvider('docker');
    openEditor();
  }
  root.querySelector<HTMLButtonElement>('#add-local-source')!.onclick = addConnection;
  editor.querySelector<HTMLButtonElement>('[data-editor-close]')!.onclick = closeEditor;
  editor.onclick = event => {
    if (event.target !== editor) {
      return;
    }
    const bounds = editor.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      closeEditor();
    }
  };

  // 선택한 공급자의 입력만 표시하고 다른 폼의 미완성 내용은 보존한다.
  function chooseProvider(kind: LocalConfig['kind']): void {
    // 1. 선택된 공급자를 버튼 상태로 함께 전달한다.
    root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.provider === kind));
    });

    // 2. 선택하지 않은 폼은 내용과 비밀값을 다시 만들지 않고 숨긴다.
    root.querySelector<HTMLElement>('#docker-editor')!.hidden = kind !== 'docker';
    root.querySelector<HTMLElement>('#slack-editor')!.hidden = kind !== 'slack';
    root.querySelector<HTMLElement>('#codex-editor')!.hidden = kind !== 'codex';
    root.querySelector<HTMLElement>('#claude-editor')!.hidden = kind !== 'claude';
    if (kind === 'claude') {
      void claudeForm.load();
    }
  }
  root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => {
    button.onclick = () => chooseProvider(button.dataset.provider as LocalConfig['kind']);
  });

  // 2. 폼을 다시 만들지 않고 저장한 연결과 상태만 갱신한다.
  async function refresh(): Promise<void> {
    // 1. 토큰이 없는 공개 연결 정보만 네이티브 저장소에서 읽는다.
    sources = await invoke<LocalSource[]>('local_list_sources');
    if (!root.isConnected || disposed) {
      return;
    }
    const fingerprint = JSON.stringify(sources);
    if (fingerprint === sourceFingerprint) {
      return;
    }
    sourceFingerprint = fingerprint;

    // 2. 원본 오류 대신 복구 안내와 연결별 동작을 표시한다.
    root.querySelector('#local-source-list')!.innerHTML = sources.length ? sources.map(source => `<article class="connector-source" data-source-id="${safe(source.id)}"><div class="section-label"><strong>${safe(source.name)} · ${source.config.kind === 'docker' ? 'Docker' : source.config.kind === 'slack' ? 'Slack' : source.config.kind === 'claude' ? 'Claude' : 'Codex'}</strong><span class="pill connector-status" data-tone="${stateTone(source)}">${safe(source.config.kind === 'codex' && source.state === 'connected' ? '조회 연결됨' : stateLabel(source.state))}</span></div><p class="fine ${source.lastError && source.state !== 'waiting' ? 'error' : ''}">${safe(source.lastError ? recovery(source.lastError, source.config.kind) : source.enabled ? '이 PC의 내 펫으로 소식을 받습니다.' : '이 연결의 수신을 중지했어요.')}</p>${source.config.kind === 'codex' ? renderCodexUsage(source.codexUsage, safe) : source.config.kind === 'claude' ? renderCodexUsage(source.claudeUsage, safe, 'Claude') : ''}<p class="source-action-notice" role="status"></p><div class="connector-form-actions"><button type="button" data-source-action="toggle">${source.enabled ? '수신 중지' : '다시 연결'}</button>${source.enabled && source.lastError && source.state !== 'waiting' ? '<button type="button" data-source-action="retry">다시 연결</button>' : ''}${source.config.kind === 'codex' || source.config.kind === 'claude' ? `<button type="button" data-source-action="refresh-usage" ${!source.enabled || !['connected', ...(source.config.kind === 'claude' ? ['waiting'] : [])].includes(source.state) ? 'disabled' : ''}>${source.config.kind === 'claude' ? '최신 값 확인' : '지금 조회'}</button>` : ''}<button type="button" data-source-action="edit" class="quiet">수정</button><button type="button" data-source-action="remove" class="quiet" title="이 연결의 자격증명도 지웁니다">연결 삭제</button></div></article>`).join('') : '<p class="empty">아직 연결이 없어요. 외부 연결 옆 + 버튼으로 Docker·Slack·Codex·Claude를 연결하세요.</p>';
  }

  // 연결 목록을 읽지 못해도 공급자 폼과 재시도 버튼을 계속 사용할 수 있게 한다.
  async function refreshWithNotice(): Promise<void> {
    // 1. 목록 요청 동안만 중복 새로고침을 막는다.
    const button = root.querySelector<HTMLButtonElement>('#refresh-local-sources')!;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');

    // 2. 실패해도 폼과 재시도 버튼을 보존한다.
    try {
      await refresh();
      notice.textContent = '';
      notice.className = '';
    } catch (error) {
      notice.textContent = recovery(error);
      notice.className = 'error';
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  }
  root.querySelector<HTMLButtonElement>('#refresh-local-sources')!.onclick = () => void refreshWithNotice();
  root.querySelector('#local-source-list')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-source-action]');
    const article = button?.closest<HTMLElement>('[data-source-id]');
    const source = sources.find(item => item.id === article?.dataset.sourceId);
    if (!button || !source || !article || sourceActionBusy) {
      return;
    }
    if (button.dataset.sourceAction === 'edit') {
      if (saving) {
        return;
      }
      chooseProvider(source.config.kind);
      const form = root.querySelector<HTMLFormElement>(`#local-${source.config.kind}-form`)!;
      form.reset();
      if (source.config.kind === 'claude') {
        const option = new Option(`세션 ${source.config.sessionKey.slice(0, 8)}`, source.config.sessionKey);
        form.querySelector<HTMLSelectElement>('[name=sessionKey]')!.add(option);
      }
      for (const [key, value] of Object.entries({ id: source.id, name: source.name, ...source.config })) {
        const input = form.elements.namedItem(key);
        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          input.checked = Boolean(value);
        } else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
          input.value = Array.isArray(value) ? value.join(',') : String(value);
        }
      }
      if (source.config.kind === 'docker') {
        renderDockerActions(source.config.actions);
      }
      if (source.config.kind === 'slack') {
        const config = source.config;
        form.querySelector<HTMLInputElement>('[name=appToken]')!.value = '';
        form.querySelectorAll<HTMLInputElement>('[name=eventTypes]').forEach(input => {
          input.checked = config.eventTypes.includes(input.value);
        });
      }
      if (source.config.kind === 'codex') {
        syncCodexForm();
      }
      if (source.config.kind === 'claude') {
        claudeForm.sync();
        void claudeForm.load(source.config.sessionKey);
      }
      form.querySelector<HTMLElement>('.local-form-notice')!.textContent = '저장한 연결을 수정하고 있어요. 저장하면 이 PC에 반영됩니다.';
      openEditor();
      return;
    }
    sourceActionBusy = true;
    const feedback = article.querySelector<HTMLElement>('.source-action-notice')!;
    article.querySelectorAll<HTMLButtonElement>('button').forEach(control => {
      control.disabled = true;
    });
    void (async () => {
      try {
        if (button.dataset.sourceAction === 'refresh-usage') {
          feedback.textContent = '사용량을 조회하는 중…';
          await invoke(source.config.kind === 'claude' ? 'local_refresh_claude' : 'local_refresh_codex', { id: source.id });
          notice.textContent = source.config.kind === 'claude' ? 'Claude 상태줄의 최신 전달값을 확인했어요.' : 'Codex 사용량을 다시 조회했어요.';
          notice.className = '';
        } else if (button.dataset.sourceAction === 'remove') {
          await invoke('local_remove_source', { id: source.id });
        } else {
          await invoke('local_enable_source', { id: source.id, enabled: button.dataset.sourceAction === 'retry' || !source.enabled });
        }
        await refresh();
      } catch (error) {
        feedback.textContent = recovery(error, source.config.kind);
        feedback.className = 'source-action-notice error';
      } finally {
        sourceActionBusy = false;
        article.querySelectorAll<HTMLButtonElement>('button').forEach(control => {
          control.disabled = control.dataset.sourceAction === 'refresh-usage' && (!source.enabled || !['connected', ...(source.config.kind === 'claude' ? ['waiting'] : [])].includes(source.state));
        });
      }
    })();
  });

  // 3. 공급자별 형식을 확인하고 실패한 폼의 내용과 재시도 경로를 유지한다.
  for (const kind of ['docker', 'slack', 'codex', 'claude'] as const) {
    const form = root.querySelector<HTMLFormElement>(`#local-${kind}-form`)!;
    const feedback = form.querySelector<HTMLElement>('.local-form-notice')!;
    form.addEventListener('invalid', () => {
      feedback.textContent = '표시한 입력 항목의 형식을 확인하고 다시 저장하세요.';
      feedback.className = 'local-form-notice error';
    }, true);
    form.onsubmit = event => {
      event.preventDefault();
      if (saving) {
        return;
      }
      const data = new FormData(form);
      const config: LocalConfig = kind === 'docker' ? { kind, endpoint: String(data.get('endpoint')).trim(), containers: values(data.get('containers')), actions: data.has('allActions') ? [] : data.getAll('actions').map(String) } : kind === 'codex' ? readCodexConfig(data) : kind === 'claude' ? readClaudeConfig(data) : { kind, teamId: String(data.get('teamId')).trim(), channels: values(data.get('channels')), eventTypes: data.getAll('eventTypes').map(String) };
      if (config.kind === 'codex' && (!Number.isInteger(config.usagePercent) || config.usagePercent < 1 || config.usagePercent > 100 || !Number.isInteger(config.pollSeconds) || config.pollSeconds < 30 || config.pollSeconds > 3600)) {
        feedback.textContent = '사용량은 1~100%, 조회 간격은 30~3600초로 설정하세요.';
        feedback.className = 'local-form-notice error';
        return;
      }
      if (config.kind === 'claude' && (!/^[a-f0-9]{64}$/.test(config.sessionKey) || !Number.isInteger(config.usagePercent) || config.usagePercent < 1 || config.usagePercent > 100)) {
        feedback.textContent = '상태줄에서 받은 세션을 선택하고 1~100% 알림 기준을 입력하세요.';
        feedback.className = 'local-form-notice error';
        return;
      }
      const token = String(data.get('appToken') || '').trim();
      if (!String(data.get('name') || '').trim() || new TextEncoder().encode(String(data.get('name')).trim()).length > 80) {
        feedback.textContent = '표시 이름은 1~80바이트로 입력하세요. 한글은 보통 한 글자에 3바이트입니다.';
        feedback.className = 'local-form-notice error';
        return;
      }
      if (config.kind === 'docker' && !data.has('allActions') && !config.actions.length) {
        feedback.textContent = '수신 동작을 한 개 이상 선택하거나 전체 수신을 선택하세요.';
        feedback.className = 'local-form-notice error';
        return;
      }
      if (config.kind === 'slack' && ((!data.get('id') && !token.startsWith('xapp-')) || (token && (!token.startsWith('xapp-') || token.length < 12 || token.length > 4096 || /\s/.test(token))) || !config.eventTypes.length || config.channels.some(channel => !/^[CDG][A-Z0-9]{2,63}$/.test(channel)))) {
        feedback.textContent = '새 연결에는 xapp- 앱 토큰이 필요해요. 채널 ID와 수신 이벤트를 한 개 이상 선택했는지도 확인하세요.';
        feedback.className = 'local-form-notice error';
        return;
      }
      const button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
      setEditorBusy(true);
      button.setAttribute('aria-busy', 'true');
      const caption = button.textContent;
      button.textContent = '저장하는 중…';
      feedback.textContent = '';
      void (async () => {
        try {
          const saved = await invoke<LocalSource>('local_save_source', { draft: { id: String(data.get('id') || '') || null, name: String(data.get('name')).trim(), config, appToken: kind === 'slack' ? token || null : null } });
          form.querySelector<HTMLInputElement>('[name=id]')!.value = saved.id;
          if (kind === 'slack') {
            form.querySelector<HTMLInputElement>('[name=appToken]')!.value = '';
          }
          feedback.className = 'local-form-notice';
          feedback.textContent = '이 PC에 저장했어요. 외부 연결에서 수신 상태를 확인하세요.';
          try {
            await refresh();
            notice.textContent = '연결을 저장했어요.';
            notice.className = '';
            closeEditor();
          } catch {
            feedback.textContent = '저장은 완료했지만 상태를 새로 받지 못했어요. 창을 닫고 외부 연결 옆 새로고침을 눌러 주세요.';
          }
        } catch (error) {
          feedback.textContent = recovery(error, kind);
          feedback.className = 'local-form-notice error';
        } finally {
          setEditorBusy(false);
          button.removeAttribute('aria-busy');
          button.textContent = caption;
        }
      })();
    };
  }
  root.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(button => {
    button.onclick = () => {
      const form = root.querySelector<HTMLFormElement>(`#${button.dataset.reset}`)!;
      form.reset();
      form.querySelector<HTMLInputElement>('[name=id]')!.value = '';
      form.querySelector<HTMLElement>('.local-form-notice')!.textContent = '';
      if (form === dockerForm) {
        renderDockerActions();
      }
    };
  });
  editor.addEventListener('close', () => {
    if (!disposed && root.isConnected && !saving) {
      void refresh().catch(() => {});
    }
  });
  await refreshWithNotice();
  // 현재 화면이 살아 있고 입력 중이 아닐 때만 공개 사용량·연결 상태를 반영한다.
  const unlisten = await listen('local-sources-updated', () => {
    if (!disposed && root.isConnected && !saving && !sourceActionBusy && !editor.open && !root.querySelector('#local-source-list')!.contains(document.activeElement)) {
      void refresh().catch(() => {});
    }
  });
  if (!root.isConnected) {
    unlisten();
  }
  return () => {
    disposed = true;
    unlisten();
    closeEditor();
  };
}
