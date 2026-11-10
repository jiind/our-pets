const characterArtStyle = `그림체 기준:
- 손으로 그린 2D 애니메이션 원화처럼 표현해 주세요. 픽셀아트는 사용하지 마세요.
- 윤곽은 가늘고 끝이 자연스럽게 가늘어지는 유색 선으로 그려 주세요. 따뜻한 털에는 적갈색, 푸른 몸에는 짙은 청록색처럼 캐릭터 색에 어울리게 하고 두껍고 균일한 검은 테두리는 피하세요.
- 귀 안쪽·볼 아래·배 아래·꼬리와 팔다리가 겹치는 곳에는 주된 그림자색 하나와 절제한 보조 명암을 넣어 주세요. 먼 쪽 다리는 살짝 어둡게, 이마·등·눈의 하이라이트는 작고 은은하게 표현해 주세요.
- 색 면이 깨끗한 셀 명암을 기본으로 경계 일부만 부드럽게 연결해 적당한 부피감을 주세요. 약 160px 높이에서도 얼굴과 실루엣이 읽혀야 해요.
- 사실적인 털 한 올 묘사·거친 질감·광택 플라스틱·점토·봉제인형·강한 테두리 조명·과도한 입체 음영은 넣지 마세요. 스티커 같은 두꺼운 외곽선이나 흰 테두리도 넣지 마세요.`;

export const singleImagePrompt = `데스크톱 펫의 외형 기준으로 사용할 캐릭터 PNG 한 장을 만들어 주세요. 먼저 이 한 자세의 외형을 확정한 뒤 같은 이미지를 참고해 애니메이션으로 확장할 예정이에요.

캐릭터: [원하는 캐릭터의 생김새·색상·특징을 적어 주세요]

${characterArtStyle}

자세와 출력 규격:

- 캐릭터 한 마리의 전신을 오른쪽을 바라보는 옆모습 또는 살짝 비스듬한 모습으로 그려 주세요.
- 머리·몸·팔·다리·꼬리가 자연스럽게 연결되고, 작은 크기에서도 표정과 실루엣이 잘 보여야 해요.
- 귀·발·꼬리가 잘리지 않도록 사방에 투명한 여백을 조금 남겨 주세요.
- 바닥을 딛고 편안히 서 있는 중립 자세로 그려 주세요. 네 발 동물은 네 다리의 연결과 접지가 자연스러워야 해요.
- 배경이 실제로 투명한 RGBA PNG로 출력해 주세요. 흰 배경이나 체크무늬를 그려 넣지 마세요.
- 이미지 크기는 1024 × 1024px로 맞춰 주세요.
- 배경·바닥·바닥 그림자·소품·텍스트·로고·테두리·워터마크는 넣지 마세요.
- 여러 자세나 격자를 넣지 말고 캐릭터 한 장만 만들어 주세요.`;

export const animatedImagePrompt = `첨부한 한 자세의 캐릭터 원화를 기준으로 데스크톱 펫의 스프라이트 시트 PNG를 만들어 주세요. 첨부 이미지는 캐릭터 정체성과 그림체의 기준이에요. 얼굴·몸 비율·색·무늬·팔다리 수·선의 굵기·명암 방식을 유지하고 자세만 바꿔 주세요.

캐릭터: [원하는 캐릭터의 생김새·색상·특징을 적어 주세요]

${characterArtStyle}

출력 규격:
- 정확히 1024 × 1024px의 투명 RGBA PNG 한 장 안에 4열 × 4행, 총 16칸을 배치해 주세요.
- 각 칸은 256 × 256px이며 칸마다 같은 캐릭터의 전신 한 개만 그려 주세요.
- 번호는 왼쪽 위 0번부터 가로 방향으로 세지만 번호·격자선·설명은 이미지에 그리지 마세요.
- 모든 칸에서 캐릭터의 크기·비율·색상·얼굴·카메라 방향·광원 방향을 일정하게 유지해 주세요.
- 오른쪽을 바라보고, 발을 딛는 높이는 각 칸 높이의 약 88%로 일정하게 맞춰 주세요.
- 팔·다리·귀·꼬리가 칸을 벗어나지 않게 투명 여백을 남겨 주세요.

동작과 칸 순서:
- 첫째 줄 0,1,2,3: 대기. 편안히 서기, 작은 숨쉬기, 눈 깜빡이기, 다시 서기.
- 둘째·셋째 줄 4,5,6,7,8,9,10,11: 오른쪽 걷기 8단계. 접지·체중 이동·발 떼기·앞으로 내딛기를 구분하고 네 발 동물은 앞뒤 다리가 협응하게 그려 주세요. 지지하는 발은 바닥 높이를 유지하고 몸의 상하 변화는 작게 하세요. 마지막 칸에서 첫 걷기 칸으로 자연스럽게 이어지는 반복 보행을 만들고 같은 자세를 복제하지 마세요.
- 넷째 줄 12,13,14,15: 반응. 손 또는 앞발 올리기, 가볍게 인사하기, 즐거운 표정, 원래 자세로 돌아오기.

배경은 실제 알파 투명으로 만들고 흰 바탕이나 체크무늬를 그려 넣지 마세요. 배경·바닥·바닥 그림자·다른 캐릭터·소품·텍스트·로고·워터마크는 넣지 마세요.`;

// 캐릭터 생성용 프롬프트 선택과 복사를 PNG 추가 모달에 연결한다.
export function mountCharacterPrompts(root: HTMLElement): () => void {
  // 1. 업로드 방식과 일치하는 두 가지 문구를 선택하고 읽기 전용으로 표시한다.
  const select = root.querySelector<HTMLSelectElement>('[data-character-prompt-kind]')!;
  const text = root.querySelector<HTMLTextAreaElement>('[data-character-prompt-text]')!;
  const hint = root.querySelector<HTMLElement>('[data-character-prompt-hint]')!;
  const status = root.querySelector<HTMLElement>('[data-character-prompt-status]')!;
  const copy = root.querySelector<HTMLButtonElement>('[data-copy-character-prompt]')!;
  let disposed = false;
  let copying = false;

  // 선택한 PNG 유형에 맞는 프롬프트와 실제 등록 설정을 함께 보여 준다.
  function update(): void {
    // 1. 선택 종류와 복사할 본문을 같은 기준으로 갱신한다.
    text.value = select.value === 'animated' ? animatedImagePrompt : singleImagePrompt;
    text.defaultValue = text.value;

    // 2. 생성 순서와 실제 업로드에 필요한 칸 설정을 안내한다.
    hint.textContent = select.value === 'animated' ? '이미지 생성 시 확정한 한 자세의 PNG를 첨부하세요. 결과가 1024 × 1024px이면 아래 너비·높이는 각각 256, 대기는 0,1,2,3, 걷기는 4,5,6,7,8,9,10,11, 반응은 12,13,14,15로 설정하세요. 실제 PNG 크기가 다르면 정확히 나뉘는 칸 크기로 맞춰야 해요. 이 번호는 사용자 등록용이며 기본 펫 원화의 동작 배치와는 달라요.' : '한 자세의 외형을 먼저 확정하세요. 이 PNG를 그대로 등록할 때는 애니메이션 설정을 비워 두세요. 동작이 필요하면 이 이미지를 첨부하고 스프라이트 시트 프롬프트를 사용하세요.';
    status.textContent = '';
  }
  select.onchange = update;

  // 추가 완료 후 폼이 초기화되면 선택 종류와 프롬프트를 함께 복구한다.
  function resetPrompt(): void {
    queueMicrotask(() => {
      if (!disposed) {
        update();
      }
    });
  }
  root.addEventListener('reset', resetPrompt);

  // 사용자가 누른 프롬프트만 복사하고 지원하지 않는 환경에서는 직접 선택을 제공한다.
  async function copyPrompt(): Promise<void> {
    // 1. 선택한 문자열을 고정하고 중복 복사를 막는다.
    if (disposed || copying) {
      return;
    }
    copying = true;
    copy.disabled = true;
    const value = text.value;

    // 2. 클립보드 쓰기 실패 시 선택된 텍스트를 사용자가 직접 복사할 수 있게 한다.
    try {
      await navigator.clipboard.writeText(value);
      if (!disposed) {
        status.textContent = '프롬프트를 복사했어요.';
      }
    } catch {
      if (!disposed) {
        text.focus();
        text.select();
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        status.textContent = copied ? '프롬프트를 복사했어요.' : '선택한 프롬프트를 직접 복사해 주세요.';
      }
    } finally {
      copying = false;
      if (!disposed) {
        copy.disabled = false;
      }
    }
  }
  copy.onclick = () => void copyPrompt();
  update();

  // 화면을 나간 후 늦은 복사 결과가 이전 UI를 갱신하지 못하게 한다.
  return () => {
    disposed = true;
    select.onchange = null;
    copy.onclick = null;
    root.removeEventListener('reset', resetPrompt);
  };
}
