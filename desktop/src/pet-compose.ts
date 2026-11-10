import { icon } from './icons';
import { isTauri } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { api, session } from './api';
import type { Pet, PetEvent } from './types';
import { setPetInput } from './pet-input';

type Kind = 'text';
type Reply = { id: string; body: string; sender: string };
type Scope = 'direct' | 'all';

// 클릭한 펫 위에서 메시지와 답장을 끝내는 입력창을 구성한다.
export function mountPetComposer(root: HTMLElement, preview: boolean, onOpen: () => void, getPets: () => Pet[]) {
  // 1. 설정 창과 독립된 입력 영역과 전송 상태를 준비한다.
  const panel = document.createElement('form');
  panel.className = 'pet-compose';
  panel.dataset.hit = '';
  panel.hidden = true;
  panel.setAttribute('aria-label', '펫에게 보내기');
  panel.innerHTML = `<div class="pet-compose-heading"><h2></h2><button type="button" class="menu-close" aria-label="작성 닫기">${icon('close')}</button></div>
    <p class="pet-compose-target"></p>
    <blockquote hidden></blockquote>
    <label class="pet-compose-body">메시지 내용<textarea name="body" rows="2" maxlength="2000" required placeholder="메시지와 이모지를 입력하세요"></textarea></label>
    <p class="pet-compose-status" role="status" aria-live="polite"></p>
    <button type="submit" class="primary">메시지 보내기</button>`;
  root.append(panel);
  const body = panel.querySelector<HTMLTextAreaElement>('textarea')!;
  const title = panel.querySelector<HTMLElement>('h2')!;
  const targetLabel = panel.querySelector<HTMLElement>('.pet-compose-target')!;
  const quote = panel.querySelector<HTMLElement>('blockquote')!;
  const status = panel.querySelector<HTMLElement>('[role=status]')!;
  const submit = panel.querySelector<HTMLButtonElement>('[type=submit]')!;
  let targetID: string | undefined;
  let scope: Scope = 'direct';
  let reply: Reply | undefined;
  let pets: Pet[] = [];
  let generation = 0;
  let busy = false;
  let disposed = false;
  let retry: { fingerprint: string; key: string } | undefined;

  // 사용자가 직접 작성할 때만 펫 창에 입력 포커스를 허용하고 변경 순서를 보장한다.
  function inputFocus(active: boolean): Promise<void> {
    if (active && (panel.hidden || disposed)) {
      return Promise.resolve();
    }
    return setPetInput(active, preview);
  }

  // 작성창을 닫고 자동 알림이 키보드 포커스를 받지 않는 상태로 돌아간다.
  function close(): void {
    if (panel.hidden) {
      return;
    }
    panel.hidden = true;
    generation += 1;
    void inputFocus(false).catch(console.error);
  }
  panel.querySelector<HTMLButtonElement>('.menu-close')!.onclick = close;

  // 고정된 한 명 또는 전체 범위만 표시하고 다중 대상 선택은 제공하지 않는다.
  function showRecipients(): void {
    const target = pets.find(pet => pet.id === targetID);
    targetLabel.textContent = scope === 'all' ? '접속 중인 친구 모두에게' : target ? `${target.ownerName || target.name}에게` : '선택한 친구에게';
  }

  // 선택한 동작의 입력창을 펫 위에 열고 필요한 입력에만 포커스를 준다.
  async function open(nextKind: Kind, nextTarget?: string, nextReply?: Reply, nextScope: Scope = nextTarget ? 'direct' : 'all'): Promise<void> {
    // 1. 이전 대상·답장 문맥을 초기화해 다른 친구에게 잘못 보내지 않게 한다.
    if (disposed || busy) {
      return;
    }
    if (nextKind !== 'text') {
      throw new Error('커피·담배·밥은 메시지 대신 모집에서 시작해 주세요.');
    }
    targetID = nextTarget;
    reply = nextReply;
    scope = nextScope;
    pets = getPets();
    const version = ++generation;
    retry = undefined;
    title.textContent = reply ? '답장하기' : scope === 'all' ? '전체 메시지 보내기' : '메시지 보내기';
    body.value = '';
    quote.hidden = !reply;
    quote.textContent = reply ? `${reply.sender}에게 답장 · ${reply.body}` : '';
    status.textContent = '';
    submit.textContent = '메시지 보내기';
    submit.disabled = true;
    showRecipients();
    panel.hidden = false;
    onOpen();

    // 2. 목록을 갱신한 뒤에도 동일한 작성창일 때만 입력을 활성화한다.
    try {
      await inputFocus(true);
      if (panel.hidden || version !== generation) {
        return;
      }
      body.focus();
      const latest = await api<Pet[]>('/pets');
      if (panel.hidden || version !== generation) {
        return;
      }
      pets = latest;
      showRecipients();
      submit.disabled = false;
    } catch (error) {
      if (version === generation) {
        status.textContent = error instanceof Error ? error.message : '친구 목록을 불러오지 못했어요. 다시 열어 주세요.';
        submit.disabled = false;
      }
    }
  }

  // 같은 요청의 재시도 키를 유지하며 전송 성공을 내 펫 말풍선으로 공유한다.
  async function send(nextKind: Kind, bodyText: string, ids: string[], all: boolean, nextReply?: Reply): Promise<void> {
    // 1. 로그인한 내 펫과 클릭한 상대를 기준으로 서버 전송 계약을 구성한다.
    if (nextKind !== 'text') {
      throw new Error('모집은 메시지로 전송할 수 없어요.');
    }
    const current = session();
    if (!current) {
      throw new Error('먼저 로그인해 주세요.');
    }
    if (!bodyText.trim() || (!all && !ids.length)) {
      throw new Error('보낼 친구와 내용을 골라 주세요.');
    }
    const payload = { senderPetId: current.principal.petId, mode: all ? 'all' : 'selected', petIds: all ? [] : ids.sort(), kind: 'text', replyToMessageId: nextReply?.id, body: bodyText };
    const fingerprint = JSON.stringify(payload);
    if (retry?.fingerprint !== fingerprint) {
      retry = { fingerprint, key: crypto.randomUUID() };
    }
    const result = await api<{ id: string; petIds: string[] }>('/messages', { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: retry.key }) });

    // 2. 성공한 메시지 전송만 현재 연결된 내 펫에 알린다.
    const own = pets.find(pet => pet.id === current.principal.petId);
    const recipient = !all && result.petIds.length === 1 ? pets.find(pet => pet.id === result.petIds[0]) : undefined;
    const sent: PetEvent = { id: `sent:${result.id}`, type: 'message', kind: 'text', replyToMessageId: payload.replyToMessageId, body: payload.body, sender: { userId: current.principal.userId, userName: own?.ownerName || '나', petId: current.principal.petId, petName: own?.ownerName || own?.name || '내 펫', designId: own?.design?.id, builtinId: own?.builtinId }, outgoing: { mode: payload.mode, recipientCount: result.petIds.length, recipientName: recipient?.ownerName || recipient?.name }, createdAt: Date.now(), expiresAt: Date.now() + 12000 };
    if (isTauri()) {
      await emit('outgoing-message', sent);
    } else {
      window.dispatchEvent(new CustomEvent('outgoing-message', { detail: sent }));
    }
    retry = undefined;
  }

  // 입력 내용과 대상을 고정한 채 보내고 실패하면 같은 작성창에서 재시도한다.
  async function submitMessage(): Promise<void> {
    // 1. 전송 중 변경되지 않도록 현재 내용과 대상의 복사본을 만든다.
    if (busy) {
      return;
    }
    busy = true;
    const version = generation;
    const ids = targetID && scope === 'direct' ? [targetID] : [];
    const all = scope === 'all';
    const nextBody = body.value;
    const nextReply = reply;
    const caption = submit.textContent;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = '보내는 중…';
    body.readOnly = true;
    status.textContent = '';

    // 2. 성공한 작성창만 닫고 실패한 내용은 같은 자리에서 복구한다.
    try {
      await send('text', nextBody, ids, all, nextReply);
      if (version === generation) {
        close();
      }
    } catch (error) {
      if (version === generation) {
        status.textContent = error instanceof Error ? error.message : '보내지 못했어요. 다시 시도해 주세요.';
      }
    } finally {
      busy = false;
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = caption;
      body.readOnly = false;
    }
  }
  panel.onsubmit = event => {
    event.preventDefault();
    void submitMessage();
  };

  // 메뉴 입력은 클릭한 상대 한 명 또는 전체로만 보내며 같은 전송 경계를 재사용한다.
  async function sendInline(text: string, recipient?: string): Promise<void> {
    // 1. 미리보기·전송 중·정리된 화면에서는 실메시지를 만들지 않는다.
    if (preview || disposed || busy) {
      throw new Error('현재 메시지를 보낼 수 없어요.');
    }
    busy = true;
    pets = getPets();

    // 2. 실패한 요청의 멱등성 키는 내부 전송 함수에 유지한다.
    try {
      await send('text', text, recipient ? [recipient] : [], !recipient);
    } finally {
      busy = false;
    }
  }

  // 현재 열린 입력창을 부모의 입력 영역과 알림 표시 정책에 연결한다.
  function visible(): boolean {
    return !panel.hidden;
  }

  // 트레이 명령이 현재 작성 중인 입력을 닫거나 초기화하지 않게 포커스만 복구한다.
  async function focus(): Promise<void> {
    if (!panel.hidden) {
      await inputFocus(true);
      body.focus();
    }
  }

  // 펫 창이 정리될 때 포커스 권한과 입력 영역도 함께 반환한다.
  function dispose(): void {
    close();
    disposed = true;
    panel.remove();
  }
  return { open, close, visible, focus, dispose, sendInline };
}
