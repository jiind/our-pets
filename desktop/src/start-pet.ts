import { cachedDesignImage, designImage } from './api';
import { drawPet } from './render';
import type { RegisteredPet } from './types';

type StartPet = Pick<RegisteredPet, 'userId' | 'builtinId' | 'design'> & { origin: string };
const storageKey = 'ourpets.startPet';
let imageDownload: Promise<void> | undefined;

function savedPet(): StartPet | null {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || 'null');
  } catch {
    return null;
  }
}

// 서버에 저장한 대표 펫을 기억하고 PNG는 기존 이미지 캐시를 사용한다.
export function rememberStartPet(pet: RegisteredPet, origin: string): void {
  if (!pet.registered) {
    return;
  }
  const previous = savedPet();
  const { userId, builtinId, design } = pet;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ origin, userId, builtinId, design } satisfies StartPet));
  } catch {
    return;
  }
  if (!design) {
    imageDownload = undefined;
  } else if (!imageDownload || previous?.origin !== origin || previous.design?.imageHash !== design.imageHash || previous.design.id !== design.id) {
    const download = designImage(design).then(url => URL.revokeObjectURL(url)).catch(() => {
      if (imageDownload === download) {
        imageDownload = undefined;
      }
    });
    imageDownload = download;
  }
}

export function forgetStartPet(origin: string, userId: string): void {
  const current = savedPet();
  if (current?.origin === origin && current.userId === userId) {
    localStorage.removeItem(storageKey);
    imageDownload = undefined;
  }
}

// 로그아웃했거나 서버가 꺼져 있어도 내 펫의 저장된 대기 자세를 그린다.
export async function drawStartPet(canvas: HTMLCanvasElement): Promise<void> {
  const pet = savedPet();
  if (pet?.design) {
    let url: string | null = null;
    try {
      await imageDownload;
      url = await cachedDesignImage(pet.design, pet.origin);
      if (url) {
        const image = new Image();
        image.src = url;
        await image.decode();
        drawPet(canvas, image, pet.design, 'idle', 0, { reduced: true });
        return;
      }
    } catch {
      // 이미지 캐시를 읽을 수 없는 경우 기본 원화로 표시한다.
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }
  drawPet(canvas, null, null, 'idle', 0, { builtin: pet?.builtinId, reduced: true });
}
