export interface CharacterPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}
export interface CharacterState {
  builtin?: string;
  walking?: boolean;
  direction?: number;
  gesture?: 'wave' | 'highfive' | 'pat';
  elapsed?: number;
  reduced?: boolean;
  mirrored?: boolean;
  pose?: CharacterPose;
  resting?: boolean;
  distance?: number;
  speed?: number;
  paired?: boolean;
  elevation?: number;
  carried?: boolean;
}

// 같은 광원을 사용하는 둥근 부위를 그려 겹친 형태에 부피감을 준다.
function volume(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, light: string, dark: string, tilt = 0): void {
  const shade = ctx.createRadialGradient(x - rx * .4, y - ry * .5, rx * .1, x + rx * .2, y + ry * .2, Math.max(rx, ry) * 1.25);
  shade.addColorStop(0, light);
  shade.addColorStop(1, dark);
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, tilt, 0, Math.PI * 2);
  ctx.fill();
}

// 어깨와 발끝을 연결해 팔이 몸에서 떨어진 스티커처럼 보이지 않게 한다.
function limb(ctx: CanvasRenderingContext2D, shoulderX: number, shoulderY: number, pawX: number, pawY: number, rear = false): void {
  ctx.strokeStyle = rear ? '#ac7444' : '#d99b5d';
  ctx.lineWidth = 17;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(shoulderX, shoulderY);
  ctx.quadraticCurveTo(shoulderX - 6, (shoulderY + pawY) / 2, pawX, pawY);
  ctx.stroke();
  volume(ctx, pawX, pawY, 13, 9, rear ? '#cd9966' : '#ffe0a7', rear ? '#9b653b' : '#bc804a');
}

// 발을 딛는 보행·독립적인 고개·꼬리·눈과 연결된 앞발로 기본 캐릭터를 표현한다.
export function drawCharacter(ctx: CanvasRenderingContext2D, size: number, time: number, state: CharacterState = {}): void {
  // 1. 바닥 접촉과 걸음 주기를 정하고 몸의 이동과 발의 지지 동작을 나눈다.
  const reduced = state.reduced || time === 0;
  const resting = !!state.resting && !state.gesture;
  const walking = !!state.walking && !reduced && !state.gesture && !resting;
  const stride = time / 155;
  const gait = walking ? Math.sin(stride) : 0;
  const liftLeft = walking ? Math.max(0, -Math.sin(stride)) * 9 : 0;
  const liftRight = walking ? Math.max(0, Math.sin(stride)) * 9 : 0;
  const breath = reduced ? 0 : Math.sin(time / 1200) * 1.2;
  const elapsed = state.elapsed || 0;
  const greeting = state.gesture === 'wave' || state.gesture === 'highfive';
  const hand = reduced ? .8 : state.gesture === 'wave' ? Math.sin(elapsed / 130) * .22 + .8 : state.gesture === 'highfive' ? Math.min(1, elapsed / 800) : 0;
  const jump = state.gesture === 'highfive' ? Math.min(0, state.pose?.y || 0) * .6 : 0;
  const bodyY = 112 + breath + (resting ? 7 : 0) + (walking ? -Math.abs(gait) * 1.6 : 0) + jump;
  const faceLook = reduced ? 0 : walking ? 4 : Math.sin(time / 2300) * 2.5;
  ctx.save();
  ctx.scale(size / 200, size / 200);
  ctx.translate(0, 3);

  // 2. 접지 그림자와 몸 뒤 꼬리·뒷발을 먼저 그려 깊이 순서를 유지한다.
  if (!state.elevation) {
    ctx.fillStyle = 'rgba(35,43,34,.18)';
    ctx.beginPath();
    ctx.ellipse(102, 195, 48 + jump * .4, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const facing = state.gesture === 'highfive' ? !state.mirrored : (state.direction || 1) > 0;
  if (!facing) {
    ctx.translate(200, 0);
    ctx.scale(-1, 1);
  }
  const tailSway = reduced ? 0 : Math.sin(time / (walking ? 250 : 650)) * 8;
  ctx.strokeStyle = '#a56a3e';
  ctx.lineWidth = 17;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(65, 142 + jump);
  ctx.bezierCurveTo(33, 153 + jump, 22 + tailSway, 125 + jump, 33 + tailSway, 105 + jump);
  ctx.stroke();
  ctx.strokeStyle = '#e8af6e';
  ctx.lineWidth = 11;
  ctx.stroke();
  limb(ctx, 86, bodyY + 28, 80 - gait * 9, 187 - liftRight + jump, true);
  limb(ctx, 122, bodyY + 28, 132 + gait * 8, 188 - liftLeft + jump, true);
  volume(ctx, 103, bodyY + 18, 38 * (state.pose?.scaleX || 1), (49 + breath) * (state.pose?.scaleY || 1), '#ffe0a5', '#bd8048', -.12);
  volume(ctx, 113, bodyY + 24, 24, 31, '#ffedc9', '#dfb37b', -.12);

  // 3. 고개와 귀는 몸과 다른 회전으로 반응하고 눈은 주기적으로 깜빡인다.
  ctx.save();
  ctx.translate(104 + faceLook, bodyY - 46);
  ctx.rotate((state.pose?.rotation || 0) * .004 + (walking ? -gait * .025 : state.gesture === 'pat' ? Math.sin(elapsed / 180) * .06 : Math.sin(time / 3100) * .025));
  ctx.fillStyle = '#c78b50';
  ctx.beginPath();
  ctx.moveTo(-39, -13);
  ctx.quadraticCurveTo(-50, -44, -34, -58);
  ctx.lineTo(-11, -28);
  ctx.lineTo(16, -29);
  ctx.quadraticCurveTo(32, -60, 40, -57);
  ctx.lineTo(42, -10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e9b1a0';
  ctx.beginPath();
  ctx.moveTo(-34, -26);
  ctx.lineTo(-34, -47);
  ctx.lineTo(-21, -27);
  ctx.moveTo(23, -28);
  ctx.lineTo(35, -47);
  ctx.lineTo(35, -22);
  ctx.fill();
  volume(ctx, 1, 0, 46, 37, '#ffdfa2', '#ca8c4f', -.05);
  ctx.strokeStyle = '#b77a43';
  ctx.lineWidth = 5;
  for (const x of [-12, 0, 12]) {
    ctx.beginPath();
    ctx.moveTo(x - 2, -31);
    ctx.lineTo(x + 1, -21);
    ctx.stroke();
  }
  const blink = resting || (!reduced && time % 5200 > 5020);
  for (const x of [-16, 23]) {
    volume(ctx, x + 2, 1, 8, blink ? 1.5 : 10, '#5f4935', '#292c26');
    if (!blink) {
      volume(ctx, x, -3, 2.5, 3, '#fffdf4', '#fffdf4');
    }
  }
  volume(ctx, 9, 19, 25, 13, '#fff0d0', '#eed1a0');
  volume(ctx, 9, 12, 5, 3.5, '#cf8b7e', '#a55e58');
  ctx.strokeStyle = '#765540';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(9, 15);
  ctx.lineTo(9, 20);
  ctx.quadraticCurveTo(2, 25, -2, 20);
  ctx.moveTo(9, 20);
  ctx.quadraticCurveTo(16, 25, 20, 20);
  ctx.stroke();
  ctx.restore();

  // 4. 앞발은 바닥을 지지하거나 어깨에서 들어 올려 인사·하이파이브를 한다.
  limb(ctx, 82, bodyY + 8, 77 + gait * 10, 188 - liftLeft + jump);
  if (greeting) {
    const pawX = 133 + hand * 22;
    const pawY = bodyY - 5 - hand * 46;
    limb(ctx, 130, bodyY + 1, pawX, pawY);
    if (state.gesture === 'highfive' && elapsed > 1100 && elapsed < 1900) {
      ctx.strokeStyle = '#d19a29';
      ctx.lineWidth = 2;
      for (const [x, y] of [[-13, -15], [0, -19], [14, -12]]) {
        ctx.beginPath();
        ctx.moveTo(pawX + x, pawY + y);
        ctx.lineTo(pawX + x * 1.5, pawY + y * 1.5);
        ctx.stroke();
      }
    }
  } else {
    limb(ctx, 128, bodyY + 5, 132 - gait * 10, 188 - liftRight + jump);
  }
  ctx.restore();
}
