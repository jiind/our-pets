# 기본 캐릭터와 출처

기본 펫은 고양이·강아지·고퍼·페리스다. 앱 번들의 `cel-v4.png`를 사용하며 얇은 유색 선과 절제한 명암의 비픽셀 2D 스프라이트다. 각 PNG는 투명 배경 4열 × 4행, 16자세로 구성한다.

| 캐릭터 | 원화 | 제작 프롬프트 |
| --- | --- | --- |
| 고양이 | [cat/cel-v4.png](../desktop/src/assets/builtin/cat/cel-v4.png) | [프롬프트](../desktop/src/assets/builtin/cat/cel-v4.prompt.txt) |
| 강아지 | [dog/cel-v4.png](../desktop/src/assets/builtin/dog/cel-v4.png) | [프롬프트](../desktop/src/assets/builtin/dog/cel-v4.prompt.txt) |
| 고퍼 | [gopher/cel-v4.png](../desktop/src/assets/builtin/gopher/cel-v4.png) | [프롬프트](../desktop/src/assets/builtin/gopher/cel-v4.prompt.txt) |
| 페리스 | [ferris/cel-v4.png](../desktop/src/assets/builtin/ferris/cel-v4.png) | [프롬프트](../desktop/src/assets/builtin/ferris/cel-v4.prompt.txt) |

[고양이 기준 원화](../desktop/src/assets/builtin/cat/cel-v4-master.png)와 [기준 프롬프트](../desktop/src/assets/builtin/cat/cel-v4-master.prompt.txt)는 그림체 기준이다. 원화는 image_gen으로 생성·편집했으며 고퍼·페리스의 원안 출처와 이용 조건을 별도로 고지한다.

## 렌더링과 제작 규칙

동작 선택은 `desktop/src/default-pet.ts`와 `desktop/src/builtin-pets.ts`가 관리한다. 실제 이동 거리로 걷기 프레임을 진행하고 공통 불투명 범위·발·머리·손 기준점을 사용한다. 프레임마다 크기를 다시 맞추지 않는다. 그림은 선택한 캐릭터만 디코딩하고 투명도 정리는 렌더링 메모리에서 처리한다.

새 기본 캐릭터는 동일한 격자·발 기준·동작 순서와 그림체를 유지한다. 원본 PNG·정확한 프롬프트·참고 입력·출처·라이선스·SHA-256을 함께 관리한다. 사용자 PNG 등록 규격은 [펫 디자인](pet-design.md)을 따른다.

## 원안과 참고 에셋의 이용 조건

| 자료 | 출처·이용 조건 |
| --- | --- |
| 고양이·강아지 실행 원화 | 프로젝트용 생성 캐릭터 |
| Go Gopher 원안 | [Renée French](https://go.dev/wiki/Gopher), CC BY 4.0. 비픽셀 2D로 각색했으며 원작자·라이선스·변경 내용을 고지 |
| Ferris 원안 | [Karen Rustad Tölva](https://rustacean.net/), CC0 1.0 |
| 보관 중인 강아지 참고 스프라이트 | [Jason of GDN, Dog Spritesheets](https://opengameart.org/content/dog-spritesheets), CC0 |
| 보관 중인 고퍼 참고 스프라이트 | [Egon Elbre, gophers](https://github.com/egonelbre/gophers), CC0. 고퍼 원안의 출처 고지도 유지 |
| 보관 중인 페리스 참고 스프라이트 | Marc Duiker, [vscode-pets](https://github.com/tonybaloney/vscode-pets), MIT. 원안은 CC0이며 프로젝트 저작권 고지도 유지 |

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), [MIT 원문](../desktop/src/assets/licenses/vscode-pets-MIT.txt)을 보존한다. 참고 스프라이트는 현재 실행 원화와 구분한다.

배포 고지는 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md), 파일별 출처와 지문은 [provenance.json](../desktop/src/assets/builtin/provenance.json)을 기준으로 관리한다. `scripts/prepare_notices.py`가 필요한 원문·출처 문서를 패키지 리소스로 준비한다. 팬 스프라이트의 공개 여부나 소스코드 라이선스를 원본 캐릭터의 재배포 허락으로 간주하지 않는다.
