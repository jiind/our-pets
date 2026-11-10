# API v1 · 실시간 펫

기본 주소는 `http://127.0.0.1:9377/api/v1`. JSON은 camelCase, 시간은 UTC Unix 밀리초, ID는 32자리 난수 16진수다. 오류는 `{"error":"설명"}`이며 알 수 없는 요청 필드는 거부한다. 인증 헤더는 `Authorization: Bearer <token>`이다. 토큰을 URL이나 일반 로그에 넣지 않는다.

`displayName`은 가입 닉네임이며 Pet의 `name`·`ownerName`과 발신·모집 정보에 동일하게 사용한다. `petName`·등록 `name` 입력은 호환 필드로 받지만 표시 닉네임을 바꿀 수 없다. Pet ID·소유자·디자인 이름은 별개다.

## HTTP

| 경로 | 요청·응답 |
| --- | --- |
| `GET /healthz` (접두사 밖) | `{status:"ok",service:"our-pets"}` |
| `POST /register` | `{username,password,displayName,invite,deviceName}` → `{token,principal}` |
| `POST /login` | `{username,password,deviceId?,deviceName?}` → `{token,principal}` |
| `POST /logout` | 현재 세션 폐기 |
| `GET /me` | 현재 사용자·기기·펫 ID 및 `petRegistered` |
| `GET /me/pet` | 본인 Pet + `registered`; 등록 전에도 조회 가능 |
| `POST /me/pet/registration` | `{designId:"default"|"builtin:dog"|"builtin:gopher"|"builtin:ferris" 또는 본인 디자인 ID}` → 200 등록된 Pet, 기존 ID 유지 |
| `GET /me/designs` | 미적용 초안을 포함한 본인 Design 배열 |
| `GET /pets` | `{id,userId,ownerName,name,design,online}[]` |
| `POST /designs` | multipart `image`, `name`, `manifest`, 선택 `draft="true"`; 등록 UI는 초안으로 저장하고 이후 등록 API로 확정 |
| `GET /designs/{id}` | 디자인 정보 |
| `GET /designs/{id}/image` | 인증된 PNG |
| `PUT /me/pet/design` | `{designId}`; 펫 ID는 유지 |
| `POST /messages` | 아래 전송 형식 → 201 `{id,petIds,status:"accepted"}` |
| `GET /messages/{id}` | 발신자만 `{id,status,recipients:[{petId,receivedAt,deviceCount}]}` 조회 |
| `GET /inbox` | 보관함이 아닌 현재 연결의 미확인 이벤트; 오프라인이면 빈 목록 |
| `POST /inbox/{id}/ack` | 수신 기기별 확인 |
| `GET /gatherings` | 모든 공개 활성 모집 및 본인 권한의 이전 메시지 모임 |
| `POST /gatherings` | `{kind:"coffee"|"smoke"|"meal"|"chat"|"walk",idempotencyKey:UUID}` → 200 현재 모집 객체 |
| `POST /gatherings/{id}/complete` | 모집자만 완료 → `{completed:true}` |
| `POST /gatherings/{id}/accept` | 공개 모집에 참여; 이전 메시지 모임은 수신 권한도 확인 |
| `POST /gatherings/{id}/leave` | 참여자는 자신의 참여 해제; 모집자는 complete 사용 |
| `GET /connectors` | 자신의 서버 샘플 연결 |
| `POST /connectors` | `{kind:"sample",config:{}}` → 201 연결만 생성; 펫 등록 필요 |
| `POST /connectors/{id}/test-events` | `{idempotencyKey:UUID}` → 202 `{status:"accepted"}`; 본인 샘플로 한 건만 생성 |
| `DELETE /connectors/{id}` | 본인 샘플 연결 삭제 → 200 `{deleted:true}` |

가입·로그인과 health·WebSocket 인증 이외에는 세션이 필요하다. CIDR·Origin 제한은 인증 전에도 적용한다. 아이디는 소문자 영문·숫자·`_`·`-` 3~32자, 비밀번호는 10~256바이트다. 표시·디자인 이름은 최대 80바이트이며 세션은 30일 만료다. 가입의 petName은 이전 클라이언트 호환용 선택 값이며 실제 펫 등록은 별도다. 가입 시 `active=0`, 등록 완료 시 `active=1`이다.

## 메시지

```json
{
  "senderPetId": "자신의-펫-ID",
  "mode": "selected",
  "petIds": ["친구-펫-ID"],
  "kind": "text",
  "body": "커피 한 잔 같이 마실까요? ☕",
  "idempotencyKey": "클라이언트-요청-UUID"
}
```

- 일반 메시지는 `proposalKind`를 생략한다. 이모지는 일반 `text` 본문에 입력한다.
- 모집은 메시지 전송 API와 분리한다. `proposalKind`로 새 모집을 보내면 400이며 `/gatherings`를 사용한다. 이전 이벤트의 `proposalKind`는 호환 조회에만 남는다.
- `selected`는 1~1000개 입력 ID를 중복 제거하며 현재 연결된 펫에게만 보낸다. 오프라인 선택 대상은 409다. 전체 전송은 `mode:"all",petIds:[]`이며 접수 당시 연결 중인 다른 펫으로 확정한다. 발신 펫은 제외한다.
- 발신자·대상은 안정적인 Pet ID다. 자신의 펫이 아닌 발신자 지정은 거절한다.
- 본문은 공백이 아닌 1~2000 Unicode 코드 포인트다. 요청 키는 8~128바이트이며 같은 키로 내용을 바꾸면 409다.
- 답장은 `replyToMessageId`를 넣고 원본 발신 펫 한 마리를 대상으로 한다. 원본 미수신자나 다른 대상은 404, 전체 답장은 400이다.
- `kind:"interaction"`은 단일 상대에 `body:"wave"` 또는 `"highfive"`를 사용한다. `kind:"emoji"`는 호환 계약으로만 지원한다. 앱은 일반 텍스트 입력에 이모지를 포함한다.

## WebSocket

`/api/v1/ws`에 접속하고 5초 안에 `{"type":"auth","token":"..."}`를 보낸다. 기기를 연결 목록에 등록한 뒤 `{"type":"ready","deviceId":"..."}`를 반환한다. 같은 기기의 새 연결은 이전 연결만 대체하고 다른 기기는 계속 수신한다.

미등록 계정은 HTTP 메시지·모집 API에서 403을 받고 WebSocket 첫 인증 뒤 1008 `pet registration required`로 종료된다. 등록 전에는 접속 중인 펫으로 집계하지 않는다.

현재 연결 이후 생성된 유효한 메시지만 전달한다. 재접속 시 이전 연결의 미수신 메시지는 다시 보내지 않는다. 같은 연결에서의 미확인 재전송과 메시지 ID 중복 제거는 유지한다. ACK는 사용자 읽음이 아니다.

```json
{
  "id": "메시지-ID",
  "type": "message",
  "kind": "text",
  "body": "커피 한 잔? ☕",
  "sender": {
    "userId": "사용자-ID", "userName": "친구",
    "petId": "펫-ID", "petName": "루나", "designId": "디자인-ID"
  },
  "createdAt": 1790000000000,
  "expiresAt": 1790000060000
}
```

일반 메시지에는 `proposalKind`가 없고 기본 디자인에는 `designId`가 없다. 답장은 선택 필드 `replyToMessageId`를 가진다. 외부 알림은 `type:"notification",kind:"external"`과 `notification:{schemaVersion,eventId,sourceKind,connectionId,occurredAt,title,body,resource?,data?}`를 사용한다. 공급자 자격증명과 실행 명령은 포함하지 않는다.

클라이언트는 본문 보관함 대신 중복 ID와 만료 시각만 저장한 뒤 `{"type":"ack","id":"..."}`를 보낸다. 서버는 같은 연결에서 미확인 이벤트를 5초 간격으로 재전송한다. 클라이언트의 새 카드 대기는 최대 15초다. 일시 중지 중의 내용을 나중에 보관함으로 표시하지 않는다.

## 실시간 함께하기 상태

현재 모임이 변하면 같은 소켓으로 다음 스냅샷을 보낸다. 메시지 이력으로 보관하지 않는다.

```json
{
  "type": "gatherings",
  "gatherings": [{
    "id": "모집-ID",
    "hostPetId": "제안자-펫-ID",
    "kind": "coffee",
    "origin": "recruitment",
    "host": {"userId":"사용자-ID","userName":"친구","petId":"제안자-펫-ID","petName":"루나"},
    "status": "open",
    "expiresAt": 0,
    "members": [{"petId":"참여자-ID","petName":"루나","userName":"친구"}]
  }]
}
```

`origin:"recruitment"`는 공개 모집이며 `kind`는 `coffee`, `smoke`, `meal`, `chat`, `walk`다. `expiresAt:0`은 자동 만료가 없다는 뜻이다. 모집은 메시지·수신자 레코드와 별도로 영속화하고 서버 재시작·연결 종료·메시지 정리 뒤에도 보존한다. 재접속은 현재 상태만 동기화한다. 좌표는 각 PC가 계산한다.

생성은 UUID 요청 키로 멱등 처리한다. 같은 키의 다른 종류는 409, 같은 종류의 이미 열린 내 모집은 같은 객체다. 완료한 키를 재시도하면 닫힌 원본 객체가 반환되므로 새 모집에는 새 키를 사용한다. 모집자만 `complete`할 수 있고 참가자는 `leave`로 자신만 취소한다. 한 펫은 한 모임에만 참여하며 활성 모집을 다른 동작으로 자동 해제하지 않는다. 이전 `origin:"message"` 모임은 기존 수신 권한·30분 만료·마지막 기기 종료·서버 재시작 종료 규칙을 유지한다.

## 로컬 IPC

| 명령 | 책임 |
| --- | --- |
| `desktop_state` | `{visible,showOthers,petSize}` |
| `set_desktop_preferences` | 선택적인 `visible`, `showOthers`, `petSize` 변경 |
| `pet_control` | `show`, `hide`, `toggle`, `others`, `restore`, `settings`, `quit` |
| `sync_peers` | 접속 중인 친구 ID만 받아 실제 창 생성·제거 |
| `set_pet_registered` | `{registered:boolean}`; 등록·로그아웃 게이트. 사용자 표시 옵션과 분리 |
| `sync_gatherings` | `{localPetId,groups}`로 모임의 고정·옆자리 배치 연결 |
| `local_list_sources` | 설정 창에서 자신의 개인 연결 조회 |
| `local_save_source` | `{draft:{id?,name,config,appToken?}}` |
| `local_enable_source` | `{id,enabled}` |
| `local_remove_source` | 연결·자격증명 삭제 |
| `local_refresh_codex` | 설정 창 전용 `{id}`; 연결된 Codex의 수동 재조회, 공개 `CodexUsage` 반환 |
| `local_refresh_claude` | 설정 창 전용 `{id}`; 최근 Claude 상태줄 전달값 확인, 원격 재조회 없음 |
| `local_claude_bridge_info` | 설정 창 전용; 설치 여부·설정 경로·세션 지문과 공개 사용량 조회 |
| `local_configure_claude_bridge` | 설정 창 전용 `{enabled}`; 명시적 상태줄 적용·복원 |
| `local_notifications` | 내 펫 창에서 `pending:true`일 때 현재 임시 알림만 조회 |
| `local_ack_notification` | 내 펫이 받은 임시 본문 삭제 |

Docker·Slack·Codex 연결은 LAN 서버에 등록하지 않는다. Slack 개인 토큰은 OS 보안 저장소에만 보관한다. Codex는 CLI 로그인에 위임하며 인증 파일을 직접 읽거나 토큰을 전달하지 않는다. `desktop-preferences-changed`는 앱과 트레이 상태를 맞추고 `pet-motion`은 실제 걸음·방향만 해당 창에 보낸다. `dismiss-pet-menu`는 배경 클릭으로 메뉴만 닫는다. 비포커스 투명 창과 뒤쪽 앱 입력을 유지한다.

Codex 설정은 `{kind:"codex", executable:"codex", mode:"interval", usagePercent:10, pollSeconds:60, notifyExhausted:true, notifyRecovered:true, notifyOnRefresh:true}`다. `mode`는 `interval|once`, 사용률은 1~100 정수, 조회 간격은 30~3600 정수다. 실행 파일은 `codex` 또는 절대 경로만 받고 추가 명령 인자는 받지 않는다. 설정 창만 연결을 관리·재조회하며 친구 펫은 호출할 수 없다.

Codex 연결 조회에는 선택적으로 `codexUsage:{checkedAt,ordinaryUsageAllowed,windows:[{key,label,usedPercent,resetsAt,windowDurationMins}]}`가 포함된다. `checkedAt`은 밀리초, `resetsAt`은 공급자 Unix 초이며 나머지 선택적 수치는 null일 수 있다. 사용 가능 여부 null을 true로 추정하지 않는다. `local-sources-updated`는 설정 창에만 원문 없는 갱신 신호를 보내고, 설정 화면은 `local_list_sources`로 공개 값만 다시 읽는다. 개인 알림의 `sourceKind`에는 `codex`가 추가되며 말풍선·OS 알림·ACK는 기존 경로를 사용한다. 임계치 상태와 이벤트는 같은 로컬 SQLite 트랜잭션으로 기록한다. 개인 사용량 정보는 LAN 서버에 저장하지 않는다.

현재 PC의 전송 성공 표시인 `outgoing-message`는 서버 수신자·받은 이력에 자신을 추가하지 않는다. 이벤트에 `outgoing:{mode,recipientCount}`와 `id:"sent:<messageId>"`를 사용한다.

등록 펫의 기존 현재 공유 외형 ID는 이름 수정 시 그대로 유지할 수 있다. 신규 등록·외형 변경에서 새로 고르는 ID는 본인 디자인이어야 한다. 기존 `PUT /me/pet/design`의 공유 디자인 적용 호환 API는 유지한다. `draft=true`는 등록 펫에도 즉시 적용하지 않으며, 미등록 펫은 일반 업로드에서도 디자인만 저장한다.

로컬 이벤트 `pet-hover`는 해당 펫 창에 실제 입력 영역 위의 포인터 상태(bool)가 바뀔 때만 전달한다. 이름표 표시용이며 LAN WebSocket 이벤트나 별도 입력 후킹이 아니다. 이름표는 입력 영역에서 제외한다.

## 모집 실시간 활동 이벤트

WebSocket의 `gathering_activity`는 모집 현재 상태인 `gatherings`와 별개인 일회성 이벤트다. `id`, `action`, `actor`(공개 사용자·펫 정보), `gathering`(변경 시점 모집·참여자), `createdAt`, `expiresAt`을 포함한다. 기존 메시지 ACK·읽음 상태와 분리한다.

| action | 전송 대상 |
| --- | --- |
| started | 모집자 펫을 제외한 현재 접속 펫의 모든 기기 |
| joined | 모집자 펫의 현재 접속 기기 |
| completed | 완료 트랜잭션 시점 참여자 펫의 현재 접속 기기 |

실제 생성·신규 참여·최초 완료 커밋 뒤에만 발행하고 멱등 재요청에는 새 이벤트를 만들지 않는다. 이벤트 만료는 15초이며 재접속·과거 상태 조회에서는 재생하지 않는다. 기기별 전송 큐는 128건으로 제한하고 넘친 모집 알림은 버려 필수 메시지 전달을 막지 않는다.

## 수동 샘플 연결

연결 추가·목록 조회·상태 새로고침·서버 재시작은 알림을 생성하지 않는다. 발송 요청만 공통 알림 저장·WebSocket·펫 말풍선·OS 알림 경로를 사용한다. 연결 ID와 요청 키로 중복을 제거하며 같은 연결의 동일 키 재시도는 한 건으로 유지한다. 키는 8~128바이트다. 다른 사용자의 발송·삭제와 삭제된 연결의 발송은 404다. 샘플 기능이 꺼지면 발송은 거부하되 기존 연결 삭제는 허용한다.

기존 intervalSeconds 값은 호환해서 읽지만 자동 주기에 사용하지 않는다. fail=true는 수동 발송 시 503을 반환하는 장애 옵션이며 알림을 자동 재시도하지 않는다. 삭제는 설정·자격 참조·구독을 지우고 목록·복원·미전달 조회에서 제외한다. 이미 전송 중인 이벤트의 수신 확인 관계만 보관 정책까지 유지하며 다음 정리에서 이벤트와 삭제 표식을 제거한다.

## 기본 캐릭터 선택

Pet·메시지 발신자·모집자 공개 정보에 builtinId를 포함한다. 값은 cat/dog/gopher/ferris이며 사용자 PNG를 선택하면 design이 우선한다. 등록·외형 적용의 designId에 default 또는 builtin:cat/dog/gopher/ferris를 넣으면 같은 펫의 사용자 이미지 참조를 비우고 기본 캐릭터만 바꾼다. Pet ID·기기·수신 관계는 유지한다. `pets.builtin_id`의 기본값은 `cat`이며 사용자 PNG와 메시지 스냅샷은 별도로 보관한다. 기본 이미지·애니메이션은 앱 번들에 있으므로 런타임 다운로드나 인터넷이 필요하지 않다. 다른 PC에도 해당 기본 캐릭터 ID를 지원하는 앱이 필요하다.

## Claude 개인 연결

Claude 설정은 {kind:"claude",sessionKey:"<SHA-256 세션 지문>",mode:"interval",usagePercent:10,notifyExhausted:true,notifyRecovered:true,notifyOnRefresh:true}다. mode는 interval 또는 once, 사용 기준은 1~100 정수다. 연결 목록의 claudeUsage는 기존 codexUsage와 같은 공개 사용량 구조를 사용하되 ordinaryUsageAllowed는 null이며 checkedAt은 실제 상태줄 수신 시각이다. UI는 usedPercent를 100에서 빼 잔여량으로 표시한다. 원본 세션 ID·인증정보·이전 명령은 공개하지 않는다.

local_claude_bridge_info는 {installed,settingsPath,sessions:[{sessionKey,usage}]}를 반환한다. 브리지 적용·복원은 설정 창에서만 가능하고 현재 앱 데이터 경로에 고정한다. 일반 웹뷰나 친구 펫 창이 경로를 지정하거나 인증 파일을 요청할 수 없다. 원본 데이터는 PC 내부에 보관한다.

## 펫 메뉴와 두 펫의 상호작용

메시지 서버의 selected 목록 계약은 호환을 위해 유지하며 앱 UI는 내 펫의 mode=all 또는 클릭한 상대의 mode=selected, petIds=[그 상대 ID]만 생성한다. 답장도 발신 상대 한 명을 사용한다. 기존 멱등성 키와 outgoing-message 확인을 재사용한다. 메뉴에는 N명 선택·같이 보내기가 없다.

pair-reaction은 선택적으로 leftID를 포함해 현재 PC의 실제 좌우 배치에 따라 양쪽 캐릭터가 마주보게 한다. 인사·하이파이브 모두 toID의 수신 펫을 고정하고 fromID의 발신 펫이 접근·복귀한다. 발신·수신 PC에서 역할은 바뀌지 않으며 두 펫의 포즈는 같은 시계를 사용한다. 내 펫 메뉴에는 인사·하이파이브를 표시하지 않는다.

## 발신자 펫의 메시지 말풍선

우클릭 메뉴의 입력·전송은 맨 아래에 위치한다. 내 펫은 전체, 친구 펫은 해당 한 명으로 전송 범위를 유지한다. 메시지 수신자와 발신 펫의 안정적인 ID 관계는 서버 계약을 바꾸지 않는다.

register_message_bubbles({ready})는 친구 창이 자기 수신기의 준비 여부만 등록한다. route_message_bubble({recipientPetId,senderPetId,message})는 대표 펫 창 전용이다. 현재 텍스트의 발신 ID·만료·크기·발신 확인 여부를 검증한 뒤 같은 PC의 준비된 peer-<senderPetId> 창에만 sender-message-bubble({recipientPetId,message})을 전달한다. 친구 창도 현재 수신자 ID와 표시 중인 발신 ID를 다시 확인한다. 외부 연결 알림은 이 경로로 보내지 않는다.

수신 기기의 대표 펫은 OS 알림을 한 번만 요청하고 발신자 창은 말풍선만 표시한다. 숨김·오프라인·창 한도·준비 전 등으로 발신자 창이 없으면 OS 알림만 유지한다. 수신자 펫의 카드로 옮기거나 숨겨진 발신자를 강제로 표시하지 않는다. 최근 메시지 ID를 창별 메모리에서 중복 제거하고 만료 이벤트를 다시 표시하지 않는다. 답장은 말풍선의 발신 상대에게 보내며, 서버 수신 대상·ACK·기기별 수신 정책은 유지한다. 기존 OS 알림 끄기·운영체제 권한을 존중한다.
