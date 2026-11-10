import type { CharacterState } from './character';
import type { Pet } from './types';
import { createPaintedPet, type PetAnchors } from './default-pet';
import spriteLicense from './assets/licenses/vscode-pets-MIT.txt?raw';

export const builtinCredits = `고양이·강아지: 프로젝트용 비픽셀 2D 애니메이션 원화 · 얇은 선과 은은한 명암 · 각 16자세

고퍼 2D 원화: 프로젝트용으로 생성한 얇은 선과 은은한 명암의 비픽셀 2D 일러스트 · 16자세
고퍼 원안: Renée French · CC BY 4.0
https://go.dev/wiki/Gopher
https://creativecommons.org/licenses/by/4.0/

페리스 2D 원화: 프로젝트용으로 생성한 얇은 선과 은은한 명암의 비픽셀 2D 일러스트 · 16자세
페리스 원안: Karen Rustad Tölva · CC0 1.0
https://rustacean.net/
페리스 참고 스프라이트: Marc Duiker · vscode-pets · MIT · 기존 원본/고지 보존
https://github.com/tonybaloney/vscode-pets

CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
고퍼·페리스는 원안을 비픽셀 2D로 각색했으며 원안과 참고 에셋의 출처·라이선스를 유지합니다.

${spriteLicense}`;

export const builtinPets = [
  { id: 'cat', selection: 'default', name: '고양이' },
  { id: 'dog', selection: 'builtin:dog', name: '강아지' },
  { id: 'gopher', selection: 'builtin:gopher', name: '고퍼' },
  { id: 'ferris', selection: 'builtin:ferris', name: '페리스' },
] as const;
export type BuiltinPetID = typeof builtinPets[number]['id'];

const anchors = new WeakMap<HTMLCanvasElement, PetAnchors>();

// 등록 선택값과 서버 캐릭터 ID를 변환하고 모르는 캐릭터는 기존 고양이로 표시한다.
export function builtinID(value?: string): BuiltinPetID {
  return builtinPets.find(pet => pet.id === value || pet.selection === value)?.id || 'cat';
}

// 현재 서버 펫의 기본 캐릭터를 등록 폼의 안정적인 선택값으로 복원한다.
export function petSelection(pet: Pet): string {
  return pet.design?.id || builtinPets.find(option => option.id === builtinID(pet.builtinId))!.selection;
}

const illustrated = {
  dog: createPaintedPet(new URL('./assets/builtin/dog/cel-v4.png', import.meta.url).href),
  gopher: createPaintedPet(new URL('./assets/builtin/gopher/cel-v4.png', import.meta.url).href),
  ferris: createPaintedPet(new URL('./assets/builtin/ferris/cel-v4.png', import.meta.url).href),
};

// 각 기본 펫의 2D 원화를 공통 거리 기반 보행·동작·발 기준으로 표시한다.
export function drawBuiltinPet(canvas: HTMLCanvasElement, id: Exclude<BuiltinPetID, 'cat'>, now: number, state: CharacterState): number {
  // 1. 선택한 캐릭터의 독립적인 원화·시계로 현재 자세를 그린다.
  const renderer = illustrated[id];
  const height = renderer.draw(canvas, now, state);

  // 2. 같은 프레임에서 얻은 머리·손·발 기준점을 메뉴와 상호작용에 제공한다.
  const metrics = renderer.anchors(canvas);
  if (metrics) {
    anchors.set(canvas, metrics);
  }
  return height ?? canvas.width;
}

// 직전 기본 캐릭터의 실제 표시 크기를 메뉴·이름표·네이티브 이동에 제공한다.
export function builtinAnchors(canvas: HTMLCanvasElement): PetAnchors | undefined {
  return anchors.get(canvas);
}
