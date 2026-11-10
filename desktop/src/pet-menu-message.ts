// 우클릭 메뉴에서 고정된 상대 또는 전체에게 보낼 메시지를 바로 입력한다.
export function mountMenuMessage(menu: HTMLElement, preview: boolean, recipient: string | undefined, send: (text: string, recipient?: string) => Promise<void>, focus: () => Promise<void>, close: () => void) {
  // 1. 화면에 보이는 입력 범위를 실제 전송 대상과 일치시킨다.
  const form = menu.querySelector<HTMLFormElement>('.pet-menu-message')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const feedback = form.querySelector<HTMLElement>('[role=status]')!;
  input.placeholder = recipient ? '이 친구에게 메시지' : '모두에게 메시지';
  input.setAttribute('aria-label', recipient ? '이 친구에게만 보낼 메시지' : '전체 펫에게 보낼 메시지');
  let offline = false;
  let busy = false;
  let disposed = false;

  // 접속과 전송 상태를 함께 반영해 오프라인 상대나 미리보기에서 발송하지 않는다.
  function setOffline(value: boolean): void {
    offline = value;
    input.disabled = preview || offline;
    input.readOnly = busy;
    submit.disabled = preview || offline || busy;
    submit.title = preview ? '메시지는 데스크톱 펫에서 보낼 수 있어요.' : '';
  }

  // 직접 입력을 누른 경우에만 창에 키보드 포커스를 주고 배경 앱의 입력을 보호한다.
  async function focusInput(): Promise<void> {
    if (disposed || menu.hidden || preview || offline) {
      return;
    }
    await focus();
    if (!disposed && !menu.hidden) {
      input.focus({ preventScroll: true });
    }
  }
  input.onpointerdown = event => {
    if (event.button === 0) {
      event.preventDefault();
      void focusInput().catch(() => {
        feedback.hidden = false;
        feedback.textContent = '입력창을 다시 눌러 주세요.';
      });
    }
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && event.isComposing) {
      event.preventDefault();
    }
  };

  // 요청 중 중복 전송을 막고 실패한 내용과 재시도 키를 같은 자리에서 유지한다.
  async function submitMessage(): Promise<void> {
    // 1. 전송할 내용을 고정하고 상대·전체 선택을 임의 목록으로 바꾸지 않는다.
    if (disposed || busy || offline || preview || !input.value.trim()) {
      return;
    }
    busy = true;
    setOffline(offline);
    submit.setAttribute('aria-busy', 'true');
    feedback.hidden = true;

    // 2. 성공하면 입력을 지우고 닫으며 실패하면 입력과 오류를 그대로 남긴다.
    try {
      await send(input.value, recipient);
      if (!disposed) {
        input.value = '';
        close();
      }
    } catch (error) {
      if (!disposed) {
        feedback.hidden = false;
        feedback.textContent = error instanceof Error ? error.message : '보내지 못했어요. 다시 전송해 주세요.';
      }
    } finally {
      busy = false;
      if (!disposed) {
        submit.removeAttribute('aria-busy');
        setOffline(offline);
      }
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    void submitMessage();
  };
  setOffline(false);

  // 정리된 메뉴에 늦은 전송 결과가 접근하지 않게 한다.
  function dispose(): void {
    disposed = true;
    form.onsubmit = null;
    input.onpointerdown = null;
    input.onkeydown = null;
  }
  return { setOffline, dispose };
}
