import { html, setText, t } from './i18n';
import { api, serverURL, session } from './api';
import { rememberDevice } from './device-session';
import { mountLegalInfo } from './legal-info';
import './account-settings.css';

interface Account {
  displayName: string;
}

// 닉네임, 서버 정보, 고지와 계정 삭제를 설정 메뉴에 배치한다.
export async function mountAccountSettings(root: HTMLElement, onNicknameChanged: () => Promise<void>, onDeleted: (pendingFileCleanup: boolean) => Promise<void>, local: boolean, mountServerInfo: (root: HTMLElement) => () => void): Promise<() => void> {
  let disposed = false;
  let deleting = false;
  const origin = serverURL();
  const token = session()?.token;
  root.innerHTML = html`<div class="account-settings">
    <form data-profile><fieldset disabled><h2>계정 정보</h2><div class="nickname-row"><label for="account-nickname">닉네임</label><input id="account-nickname" name="displayName" autocomplete="nickname" maxlength="80" required><button type="submit" class="primary">저장</button></div><p data-status role="status" aria-live="polite"></p></fieldset><p data-load-status role="status">계정을 불러오는 중이에요.</p><button type="button" data-retry hidden>계정 다시 불러오기</button></form>
    <div data-server-info></div>
    <div data-legal-info></div>
    <section class="account-delete"><h2>계정 삭제</h2><p class="fine">현재 서버의 계정과 펫·등록한 이미지·보낸 메시지를 삭제합니다.</p><button type="button" class="quiet account-delete-button" data-delete-account disabled>계정 삭제…</button></section>
    <dialog class="account-delete-dialog" aria-label="이 서버의 계정을 삭제할까요?"><header><h2>이 서버의 계정을 삭제할까요?</h2></header><p>모든 기기에서 로그아웃되고 계정·펫·등록한 디자인·보낸 메시지·모집 정보가 삭제됩니다. 되돌릴 수 없습니다.</p><p class="fine">다른 사용자의 메시지, 서버 백업, 이 PC의 외부 연결과 OS 알림 기록은 별도로 관리됩니다.</p>
    <form data-delete-form><label><input name="confirm" type="checkbox" required> 삭제 범위를 확인했어요.</label><div class="account-actions"><button type="button" data-delete-cancel>취소</button><button type="submit" class="account-delete-confirm">계정 영구 삭제</button></div><p role="status" data-status aria-live="polite"></p></form></dialog>
  </div>`;
  const disposeServer = mountServerInfo(root.querySelector<HTMLElement>('[data-server-info]')!);
  const disposeLegal = mountLegalInfo(root.querySelector<HTMLElement>('[data-legal-info]')!);
  const profile = root.querySelector<HTMLFormElement>('[data-profile]')!;
  const fields = profile.querySelector('fieldset')!;
  const nickname = profile.querySelector<HTMLInputElement>('[name=displayName]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-retry]')!;
  const loadStatus = root.querySelector<HTMLElement>('[data-load-status]')!;
  const deletion = root.querySelector<HTMLDialogElement>('.account-delete-dialog')!;
  const deletionForm = deletion.querySelector<HTMLFormElement>('form')!;
  const deleteButton = root.querySelector<HTMLButtonElement>('[data-delete-account]')!;
  root.querySelector<HTMLElement>('.account-delete')!.hidden = local;

  // 화면을 전환한 뒤 이전 계정 설정에서 요청을 보내지 못하게 한다.
  function assertAccount(): void {
    if (disposed || origin !== serverURL() || token !== session()?.token) {
      throw new Error(t('로그인한 계정이 바뀌었어요. 설정 메뉴를 다시 열어 주세요.'));
    }
  }

  // 요청의 결과는 해당 폼에서만 보여 준다.
  function feedback(form: HTMLFormElement, message: string, error = false): void {
    if (!disposed) {
      const status = form.querySelector<HTMLElement>('[data-status]')!;
      setText(status, () => message);
      status.classList.toggle('error', error);
    }
  }

  // 본인의 닉네임을 불러오고 실패 시 다시 시도할 수 있게 한다.
  async function load(): Promise<void> {
    retry.disabled = true;
    try {
      assertAccount();
      const account = await api<Account>('/me/account');
      assertAccount();
      nickname.value = account.displayName;
      fields.disabled = false;
      deleteButton.disabled = false;
      loadStatus.textContent = '';
      retry.hidden = true;
    } catch (error) {
      if (!disposed) {
        setText(loadStatus, () => error instanceof Error ? error.message : t('계정을 불러오지 못했어요.'));
        retry.hidden = false;
      }
    } finally {
      retry.disabled = false;
    }
  }

  // 2. 닉네임 저장 후 같은 펫의 표시를 갱신한다.
  profile.onsubmit = async event => {
    event.preventDefault();
    if (fields.disabled) {
      return;
    }
    const displayName = nickname.value.trim();
    if (!displayName || new TextEncoder().encode(displayName).length > 80) {
      feedback(profile, t('닉네임은 1~80바이트로 입력하세요.'), true);
      return;
    }
    fields.disabled = true;
    feedback(profile, '');
    try {
      assertAccount();
      const account = await api<Account>('/me/account', { method: 'PUT', body: JSON.stringify({ displayName }) });
      assertAccount();
      nickname.value = account.displayName;
      await onNicknameChanged();
      feedback(profile, t('닉네임을 저장했어요.'));
    } catch (error) {
      feedback(profile, error instanceof Error ? error.message : t('닉네임을 저장하지 못했어요.'), true);
    } finally {
      fields.disabled = false;
    }
  };

  // 3. 별도 확인 창에서 동의를 받고 이 기기의 키로만 계정을 삭제한다.
  deletionForm.onsubmit = async event => {
    event.preventDefault();
    if (deleting || !deletionForm.reportValidity()) {
      return;
    }
    deleting = true;
    const controls = deletionForm.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input');
    controls.forEach(control => control.disabled = true);
    feedback(deletionForm, '');
    try {
      assertAccount();
      const deviceKey = await rememberDevice(origin);
      assertAccount();
      const result = await api<{ pendingFileCleanup: boolean }>('/me/account', { method: 'DELETE', body: JSON.stringify({ deviceKey }) });
      assertAccount();
      deletion.close();
      await onDeleted(result.pendingFileCleanup);
    } catch (error) {
      feedback(deletionForm, error instanceof Error ? error.message : t('계정을 삭제하지 못했어요.'), true);
    } finally {
      deleting = false;
      controls.forEach(control => control.disabled = false);
    }
  };
  deleteButton.onclick = () => {
    deletionForm.reset();
    feedback(deletionForm, '');
    deletion.showModal();
    deletionForm.querySelector<HTMLInputElement>('[name=confirm]')!.focus();
  };
  deletion.querySelector<HTMLButtonElement>('[data-delete-cancel]')!.onclick = () => deletion.close();
  deletion.oncancel = event => {
    if (deleting) {
      event.preventDefault();
    }
  };
  deletion.onclose = () => deletionForm.reset();
  retry.onclick = () => void load();
  await load();
  return () => {
    disposed = true;
    deletionForm.reset();
    deletion.close();
    disposeServer();
    disposeLegal();
  };
}
