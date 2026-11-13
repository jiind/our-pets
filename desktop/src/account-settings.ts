import { api, serverURL, session } from './api';
import { icon } from './icons';
import { mountLegalInfo } from './legal-info';
import './account-settings.css';

interface Account {
  username: string;
  displayName: string;
}

// 계정 소유자가 아이디를 확인하고 닉네임·비밀번호만 변경하는 화면을 구성한다.
export async function mountAccountSettings(root: HTMLElement, onNicknameChanged: () => Promise<void>, onDeleted: (pendingFileCleanup: boolean) => Promise<void>): Promise<() => void> {
  // 1. 화면 수명과 로그인 계정을 고정하고 민감 입력은 이 폼 안에서만 관리한다.
  let disposed = false;
  const accountKey = `${serverURL()}/${session()?.token || ''}`;
  const id = `account-${crypto.randomUUID()}`;
  root.innerHTML = `<div class="account-settings"><form data-profile><fieldset disabled><h2>계정 정보</h2><label>아이디<input name="username" autocomplete="username" readonly></label><label>닉네임<input name="displayName" autocomplete="nickname" maxlength="80" required></label><div class="account-actions"><button type="submit" class="primary">닉네임 저장</button></div><p data-status role="status" aria-live="polite"></p></fieldset></form><form data-password><fieldset disabled><h2>비밀번호 변경</h2>${[['currentPassword', '현재 비밀번호', 'current-password'], ['newPassword', '새 비밀번호', 'new-password'], ['confirmPassword', '새 비밀번호 확인', 'new-password']].map(([name, label, autocomplete]) => `<div><label for="${id}-${name}">${label}</label><div class="auth-password-input"><input id="${id}-${name}" name="${name}" type="password" minlength="10" maxlength="256" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off" required><button type="button" class="password-visibility" data-password-name="${name}" data-password-label="${label}" aria-label="${label} 보기" aria-controls="${id}-${name}" aria-pressed="false">${icon('eye')}</button></div></div>`).join('')}<div class="account-actions"><button type="submit" class="primary">비밀번호 변경</button></div><p data-status role="status" aria-live="polite"></p></fieldset></form><div data-legal-info></div><section class="account-delete"><h2>계정 삭제</h2><p class="fine">현재 서버의 계정과 펫·등록한 이미지·보낸 메시지를 삭제합니다.</p><button type="button" class="quiet account-delete-button" data-delete-account disabled>계정 삭제…</button></section><dialog class="account-delete-dialog" aria-labelledby="${id}-delete-title"><header><h2 id="${id}-delete-title">이 서버의 계정을 삭제할까요?</h2></header><p>모든 기기에서 로그아웃되고 계정·펫·등록한 디자인·보낸 메시지·모집 정보가 삭제됩니다. 되돌릴 수 없습니다.</p><p class="fine">다른 사용자의 메시지, 서버 백업, 이 PC의 외부 연결과 OS 알림 기록은 별도로 관리됩니다.</p><form data-delete-form><label>현재 비밀번호<input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label><label><input name="confirm" type="checkbox" required> 삭제 범위를 확인했어요.</label><div class="account-actions"><button type="button" data-delete-cancel>취소</button><button type="submit" class="account-delete-confirm">계정 영구 삭제</button></div><p role="status" data-status aria-live="polite"></p></form></dialog><p data-load-status role="status">계정을 불러오는 중이에요.</p><button type="button" data-retry hidden>계정 다시 불러오기</button></div>`;
  const disposeLegal = mountLegalInfo(root.querySelector<HTMLElement>('[data-legal-info]')!);
  const deletion = root.querySelector<HTMLDialogElement>('.account-delete-dialog')!;
  const deletionForm = deletion.querySelector<HTMLFormElement>('form')!;
  const deleteButton = root.querySelector<HTMLButtonElement>('[data-delete-account]')!;
  let deleting = false;
  const profile = root.querySelector<HTMLFormElement>('[data-profile]')!;
  const password = root.querySelector<HTMLFormElement>('[data-password]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-retry]')!;
  const loadStatus = root.querySelector<HTMLElement>('[data-load-status]')!;

  // 다른 계정으로 전환한 뒤 이전 폼이 저장 요청을 보내지 못하게 한다.
  function assertAccount(): void {
    if (disposed || accountKey !== `${serverURL()}/${session()?.token || ''}`) {
      throw new Error('로그인한 계정이 바뀌었어요. 계정 메뉴를 다시 열어 주세요.');
    }
  }

  // 폼별 결과를 다른 설정이나 비밀번호 원문 없이 표시한다.
  function feedback(form: HTMLFormElement, message: string, error = false): void {
    if (!disposed) {
      const status = form.querySelector<HTMLElement>('[data-status]')!;
      status.textContent = message;
      status.classList.toggle('error', error);
    }
  }

  // 인증한 계정의 공개 정보만 읽고 실패하면 재시도 경로를 유지한다.
  async function load(): Promise<void> {
    // 1. 이전 계정 화면의 지연 응답은 현재 입력에 반영하지 않는다.
    retry.disabled = true;
    try {
      assertAccount();
      const account = await api<Account>('/me/account');
      assertAccount();
      (profile.elements.namedItem('username') as HTMLInputElement).value = account.username;
      (profile.elements.namedItem('displayName') as HTMLInputElement).value = account.displayName;

      // 2. 조회 성공 뒤에만 수정 폼을 활성화한다.
      profile.querySelector('fieldset')!.disabled = false;
      password.querySelector('fieldset')!.disabled = false;
      deleteButton.disabled = false;
      loadStatus.textContent = '';
      retry.hidden = true;
    } catch (error) {
      if (!disposed) {
        loadStatus.textContent = error instanceof Error ? error.message : '계정을 불러오지 못했어요.';
        retry.hidden = false;
      }
    } finally {
      retry.disabled = false;
    }
  }

  // 2. 아이디는 보내지 않고 닉네임 변경 성공 후 펫 표시도 동기화한다.
  profile.onsubmit = event => {
    event.preventDefault();
    const fields = profile.querySelector('fieldset')!;
    if (fields.disabled) {
      return;
    }
    const input = profile.elements.namedItem('displayName') as HTMLInputElement;
    const displayName = input.value.trim();
    if (!displayName || new TextEncoder().encode(displayName).length > 80) {
      feedback(profile, '닉네임은 1~80바이트로 입력하세요.', true);
      return;
    }
    fields.disabled = true;
    feedback(profile, '');
    void (async () => {
      try {
        assertAccount();
        const account = await api<Account>('/me/account', { method: 'PUT', body: JSON.stringify({ displayName }) });
        assertAccount();
        input.value = account.displayName;
        await onNicknameChanged();
        feedback(profile, '닉네임을 저장했어요.');
      } catch (error) {
        feedback(profile, error instanceof Error ? error.message : '닉네임을 저장하지 못했어요.', true);
      } finally {
        fields.disabled = false;
      }
    })();
  };

  // 새 비밀번호 일치를 확인한 뒤 현재 비밀번호와 함께 서버에 검증을 요청한다.
  password.onsubmit = event => {
    event.preventDefault();
    const fields = password.querySelector('fieldset')!;
    if (fields.disabled) {
      return;
    }
    const data = new FormData(password);
    const currentPassword = String(data.get('currentPassword'));
    const newPassword = String(data.get('newPassword'));
    if (newPassword !== data.get('confirmPassword')) {
      feedback(password, '새 비밀번호가 서로 일치하지 않습니다.', true);
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 256) {
      feedback(password, '새 비밀번호는 256바이트 이내로 입력하세요.', true);
      return;
    }
    fields.disabled = true;
    feedback(password, '');
    void (async () => {
      try {
        assertAccount();
        await api('/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });
        assertAccount();
        password.reset();
        password.querySelectorAll<HTMLInputElement>('input').forEach(input => input.type = 'password');
        password.querySelectorAll<HTMLButtonElement>('[data-password-name]').forEach(button => {
          button.setAttribute('aria-label', `${button.dataset.passwordLabel} 보기`);
          button.setAttribute('aria-pressed', 'false');
          button.innerHTML = icon('eye');
        });
        feedback(password, '비밀번호를 변경했어요. 다른 로그인 세션은 종료됩니다.');
      } catch (error) {
        feedback(password, error instanceof Error ? error.message : '비밀번호를 변경하지 못했어요.', true);
      } finally {
        fields.disabled = false;
      }
    })();
  };

  // 비밀번호 보기 상태는 해당 입력에만 적용하고 화면을 떠나면 입력을 지운다.
  password.querySelectorAll<HTMLButtonElement>('[data-password-name]').forEach(button => {
    button.onclick = () => {
      const input = password.elements.namedItem(button.dataset.passwordName!) as HTMLInputElement;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', `${button.dataset.passwordLabel} ${visible ? '숨기기' : '보기'}`);
      button.setAttribute('aria-pressed', String(visible));
      button.innerHTML = icon(visible ? 'eye-off' : 'eye');
    };
  });
  // 삭제는 별도 확인 창에서 현재 비밀번호와 명시적 체크를 받은 뒤 본인에게만 실행한다.
  deletionForm.onsubmit = event => {
    event.preventDefault();
    if (deleting || !deletionForm.reportValidity()) {
      return;
    }
    const data = new FormData(deletionForm);
    const currentPassword = String(data.get('currentPassword'));
    deleting = true;
    deletion.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => control.disabled = true);
    feedback(deletionForm, '');
    void (async () => {
      try {
        assertAccount();
        const result = await api<{ pendingFileCleanup: boolean }>('/me/account', { method: 'DELETE', body: JSON.stringify({ currentPassword }) });
        assertAccount();
        deletionForm.reset();
        deletion.close();
        await onDeleted(result.pendingFileCleanup);
      } catch (error) {
        feedback(deletionForm, error instanceof Error ? error.message : '계정을 삭제하지 못했어요.', true);
      } finally {
        deleting = false;
        deletionForm.querySelector<HTMLInputElement>('[name=currentPassword]')!.value = '';
        deletion.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => control.disabled = false);
      }
    })();
  };
  deleteButton.onclick = () => {
    deletionForm.reset();
    feedback(deletionForm, '');
    deletion.showModal();
    deletionForm.querySelector<HTMLInputElement>('[name=currentPassword]')!.focus();
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
    password.reset();
    deletionForm.reset();
    deletion.close();
    disposeLegal();
  };
}
