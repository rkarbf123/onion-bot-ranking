# 양파봇 월간 XP 기록

기존 CommonJS 봇을 유지하면서 무기한 퀴즈, 재시작 복구, 월간 SQLite 교체, GitHub JSON 업로드와 React 랭킹 웹사이트를 추가했습니다. 운영 DB 초기화, Discord 접속 및 GitHub 공개 업로드는 이번 구현 검증에서 실행하지 않았습니다.

## 확인한 기존 동작

`main.js`, `commands.js` 전체와 제공된 DB 3개를 확인했습니다.

| 파일 | 확인 결과 |
|---|---|
| `levels.db` | 사용자 786명, `users`/`settings`, 아이템 보유량 합계 0, 무결성 검사 통과 |
| `levels_backup.db` | 사용자 781명, 같은 스키마, 아이템 보유량 합계 0, 무결성 검사 통과 |
| `bot_database.db` | `id`/`money`/`last_checkin` 등을 사용하는 다른 스키마, 병합하지 않음 |

실제 운영 스키마의 `xp`, `level`에는 기본값이 없습니다. 따라서 신규 사용자 등록 시 `xp=0, level=1`을 명시합니다. 기존 `users`/`settings` 스키마는 변경하지 않았습니다.

보존한 계산식은 전체 XP `level * (level - 1) / 2 * 100 + xp`, 메시지 XP `min(10 + floor(문자열 길이/5), 50)`, 핫타임 2배, 레벨당 필요 XP `level * 100`입니다. 퀴즈 보상도 `RANDOM` 100~500 또는 `floor((level*100+xp)*(mode-1))` 그대로입니다. 원래 코드가 증가시키지 않던 `weekly_xp`도 새로 증가시키지 않습니다.

## 변경 파일과 추가 파일

- `main.js`: DB 관리자 연결, 안전한 시작 백업, 퀴즈 관리자 연결, XP 영구 이벤트 기록, 월간 스케줄러, 정상 종료 처리. 기존 `updateLevelRole()`과 호출을 제거했습니다. 이미 존재하는 Discord 역할은 건드리지 않습니다.
- `commands.js`: 수정하지 않았습니다. 명령어, 옵션, 관리자 ID, 임베드, 전용 채널 제한과 주석 처리된 상점을 보존했습니다. 도움말의 기존 상점 설명도 그대로입니다.
- `archive/`: DB/상태 관리자, 스냅샷, GitHub 업로더, 스케줄러, 프로필 조회, XP 이벤트 처리, CLI와 공통 유틸리티.
- `quiz/quizManager.js`: 지속 가능한 퀴즈와 복구.
- `website/`: React, Vite, TypeScript, Tailwind 기반 정적 웹사이트.
- `.github/workflows/pages.yml`: GitHub Pages 빌드/배포.
- `tests/`: 실제 DB 복사본 통합 테스트, 봇 핸들러 회귀 테스트, 웹사이트 DOM 테스트.
- `.env.example`, `.gitignore`, 각 `package.json`/잠금 파일, 이 문서와 `TEST_RESULTS.md`.

## 설치와 실행

Node.js 22.16 이상에서 프로젝트 루트를 작업 디렉터리로 사용합니다. 이번 작업에는 폴더 내부 `.tools/node-v22.16.0-win-x64`에 별도 런타임을 받았으며, 운영 서버는 기존 Node 설치를 사용해도 됩니다.

```sh
npm ci
npm ci --prefix website
```

`.env.example`을 참고해 직접 `.env`를 작성합니다. `DISCORD_TOKEN`, `APPLICATION_ID`를 기존 운영값으로 설정하세요. 토큰은 커밋하거나 웹사이트의 `VITE_*` 변수에 넣지 않습니다. Discord의 기존 메시지/멤버 인텐트와 채널 권한을 유지하고, 복구에 필요한 메시지 기록 읽기 권한을 확인하세요.

```sh
node main.js
```

기존 실행 방식을 유지할 수 있습니다. 한 DB 폴더에는 봇 또는 변경 작업 CLI 하나만 실행하세요. `runtime.lock`으로 새 코드끼리의 중복 실행을 막으며, PID가 종료된 잠금은 자동 회수합니다. 이전 버전 봇은 잠금을 모르므로 최초 정산 전에 반드시 직접 종료해야 합니다.

## 퀴즈와 재시작

1. 1~50 두 수와 기존 `+`, `-`, `*` 문제를 출제합니다. 문제/정답/메시지 ID는 비공개 `archive/system_state.db`에 저장합니다.
2. Collector에 시간 제한을 두지 않습니다. 공백을 제거한 정답 문자열, 해당 채널, 봇 제외, 퀴즈 메시지 이후의 첫 정답만 인정합니다.
3. 정답 처리 시각과 첫 정답자를 먼저 영구 기록합니다. XP 지급과 `COOLDOWN` 변경, 이벤트 처리 완료를 하나의 SQLite 트랜잭션으로 커밋합니다.
4. 다음 출제 목표 시각은 `answeredAt + 300000`입니다. 정답자가 없으면 다음 문제를 예약하지 않습니다.
5. 재시작 시 원래 메시지를 확인하고 Collector를 복구합니다. 대기 중이면 남은 시간만 기다리며, 목표 시각이 지났으면 즉시 실행을 예약합니다. 미완료 보상 이벤트는 한 번만 재처리합니다.

오프라인 중 작성된 정답을 메시지 기록에서 소급 채점하지 않습니다. 이 프로세스 시작 이후의 실시간 이벤트만 인정합니다. 기간 귀속은 Discord 메시지 작성 시각 대신 **봇에서 정답을 인정한 처리 시각**을 기준으로 합니다.

네트워크 전송과 SQLite 커밋은 단일 트랜잭션이 아니므로 출제 전에 nonce를 저장하고 Discord `enforceNonce`와 기록 조회로 중복 출제를 줄입니다. 오래된 전송의 성공 여부를 확인할 수 없으면 새 문제를 보내지 않고 보류합니다. 봇을 멈추고 채널에서 실제 문제를 확인한 뒤 연결할 수 있습니다.

```sh
node archive/cli.js status
node archive/cli.js quiz-attach --message-id MESSAGE_ID --confirm QUIZ_ID --bot-stopped
```

문제가 전혀 전송되지 않았음을 확인한 경우:

```sh
node archive/cli.js quiz-reset --confirm QUIZ_ID --verified-no-message --bot-stopped
```

원래 메시지가 삭제되었음을 확인한 경우에는 `--verified-message-deleted`를 사용합니다. 이미 정답자가 확정된 문제는 이 명령으로 초기화할 수 없습니다. 채널 장애는 30초 간격으로 재시도합니다.

XP 보상은 영구 기록되지만 Discord 알림 자체는 장애 시 누락될 수 있습니다. XP 중복 지급을 피하기 위해 보상 알림을 무조건 재발송하지 않습니다. 300초는 예약 기준이며 프로세스 중단, 이벤트 루프 지연, Discord 장애가 있으면 실제 전송은 늦어질 수 있습니다.

## DB 교체와 월간 자동 정산

최초 정산을 완료해야 자동 월간 정산이 활성화됩니다. 매월 1일 00:00:00 `Asia/Seoul`에 마감하며, 모든 XP 쓰기 앞에서도 기간 경계를 확인합니다. 정산과 XP 변경은 같은 이벤트 루프에서 동기로 수행하므로 DB 전환 중 다른 XP 쓰기가 끼어들지 않습니다.

메시지 XP, 퀴즈 정답, 3분 주기 수확 이벤트를 별도 상태 DB에 먼저 기록합니다. 미완료 이벤트를 처리 시각 순으로 재실행하며 XP와 처리 완료 기록을 함께 커밋합니다. 이미 처리한 메시지/퀴즈/수확 이벤트 ID는 다시 지급하지 않습니다. 핫타임, 아이템별 생산량과 생산 주기는 기존과 같습니다.

정산 절차:

1. 이전 기간의 미완료 XP 이벤트를 처리합니다.
2. SQLite `VACUUM INTO`로 `archive/backups/levels_YYYY-MM.old.db`를 만듭니다. 모든 테이블을 보존하고 `integrity_check`, 스키마와 테이블 데이터의 SHA-256 지문을 비교합니다.
3. 전체 사용자 스냅샷은 `archive/private/`, 공개 허용 사용자만 포함한 JSON은 `archive/snapshots/`에 각각 보존합니다. 전체 XP 내림차순, 동점은 `user_id` 문자열 오름차순, 순위는 1부터 연속입니다.
4. 별도 후보 DB를 만들고 XP/weekly_xp/아이템은 0, 레벨은 1로 설정합니다. 사용자 등록, 설정 및 다른 테이블은 보존합니다.
5. 후보 DB를 검증하고 전환 의도를 영구 기록한 뒤 기존 핸들을 닫습니다. 기존 실제 파일은 `levels_YYYY-MM.source.db`로도 보존하고 후보 파일을 `levels.db`로 전환합니다.
6. 새 핸들을 열어 기존 명령어의 DB 프록시가 새 DB를 사용하게 합니다. 캐시된 프록시 Statement도 새 핸들을 사용합니다. 완료 상태와 다음 기간 시작 시각을 저장합니다.
7. 공개 업로드는 별도로 진행합니다. 업로드 실패가 다음 달 XP 집계를 막지 않으며, 1분 간격으로 재시도합니다.

`PENDING`, `BACKED_UP`, `SNAPSHOTTED`, `SWITCHING`, `UPLOAD_PENDING`, `COMPLETED`, `FAILED`와 별도 업로드 상태를 기록합니다. 전환 중 종료되면 다음 실행에서 검증된 후보/기존 파일을 확인하고 완료되지 않은 부분만 복구합니다. 후보 DB의 내용이 예상과 다르거나 소유를 확인할 수 없는 파일이 있으면 덮어쓰지 않고 중단합니다. old DB는 자동 삭제하지 않습니다.

XP와 퀴즈 상태를 함께 커밋하기 위해 운영 DB와 ATTACH한 상태 DB에 `journal_mode=DELETE`, `synchronous=FULL`을 사용합니다. 다중 DB 원자성에 관한 [SQLite 공식 문서](https://www.sqlite.org/lang_attach.html)를 따릅니다. 외부 프로그램이 이 파일들에 동시에 쓰거나 WAL로 바꾸지 않도록 하세요. 이 파일들은 로컬 디스크에서 사용하며, 실행 중인 DB의 일반 파일 복사나 동기화 서비스 복제에 일관성을 의존하지 않습니다.

23:59:58에 인정한 정답은 이전 기간, 00:03에 인정한 정답은 새 기간으로 기록됩니다. 진행 중인 문제와 남은 5분 대기는 DB 교체와 무관하게 유지됩니다. 최초 기간 이후의 시작은 최초 DB 전환 완료 시각이며, 정상적인 월간 정산은 매월 1일 00:00의 경계를 사용합니다. `snapshotAt`과 `switchedAt`은 실제 처리 시각을 별도로 기록하고 `periodEnd`는 미포함 경계로 정의합니다.

봇이 월 경계에 꺼져 있었다면 저장된 XP만으로 누락된 월별 내역을 복원할 수 없습니다. 이 경우 직전 기간을 실제 재개 시각까지의 지연 정산으로 저장하고 `scheduledPeriodEnd`/`accuracy=delayed-extraction`을 표시합니다. 존재하지 않는 월별 내역을 만들어내지 않습니다.

## GitHub 토큰과 공개 범위

대상 저장소에만 접근 가능한 fine-grained PAT를 발급하고 **Contents: Read and write** 권한만 부여합니다. 봇의 JSON 업로드에는 Actions/Workflows 쓰기 권한을 요구하지 않습니다. 배포 워크플로 파일은 관리자 계정으로 별도로 저장소에 올립니다. Contents API 권한과 검증 형식은 [GitHub 공식 문서](https://docs.github.com/en/rest/repos/contents)를 참고하세요.

```dotenv
GITHUB_TOKEN=직접_입력
GITHUB_OWNER=소유자
GITHUB_REPO=저장소
GITHUB_BRANCH=main
GITHUB_DATA_PATH=website/public/data
ARCHIVE_PUBLIC_UPLOAD=false
ARCHIVE_PUBLIC_USER_IDS=공개를_허용한_사용자ID들
ARCHIVE_PUBLIC_GUILD_IDS=
ARCHIVE_EXCLUDED_USER_IDS=
```

ID는 쉼표로 구분합니다. 공개 승인 전에는 `ARCHIVE_PUBLIC_UPLOAD=false`를 유지합니다. 범위가 비어 있으면 모든 사용자를 공개 대상에서 제외하며 업로드 사전 검증도 통과하지 않습니다. 제외 목록이 허용 목록보다 우선합니다. 대규모 범위는 비공개 파일 `archive/private/scope.json`의 `{"userIds":["..."],"guildIds":["..."]}`를 `ARCHIVE_SCOPE_FILE`로 지정할 수 있습니다.

서버 ID를 지정하면 해당 서버 멤버로 확인된 사용자만 포함합니다. 최초 CLI 정산은 Discord REST로 멤버를 확인하므로 Discord 토큰과 멤버 인텐트/권한이 필요합니다. 월간 정산은 연결된 봇의 멤버 캐시를 사용하므로 정확한 고정 공개 명단이 필요하면 `userIds`를 권장합니다. 이름/프로필을 얻지 못하면 사용자 ID 기반 대체 표시를 사용하고 계속 진행합니다.

서버, 사용자 범위를 검토한 후 최종 공개 승인에 따라 `ARCHIVE_PUBLIC_UPLOAD=true`로 바꿉니다. 공개 JSON에는 XP·순위·이름·ID·선택적 Discord 프로필 이미지와 기간 메타데이터만 포함합니다. DB, 토큰, 퀴즈 정답, 비공개 전체 스냅샷은 업로드하지 않습니다.

동일한 기록이 있으면 내용이 같은 경우만 성공으로 처리합니다. 내용이 다르면 자동 교체하지 않습니다. 업로드한 아카이브를 Contents API로 다시 읽어 비교한 후 `index.json`을 갱신하고 다시 검증합니다. 네트워크/서버/Rate Limit 오류는 제한된 지수 지연으로 재시도하고, 인증 및 충돌 오류는 별도 상태로 기록합니다.

## 최초 정산

**아래 commit 명령은 실제 공개 업로드와 운영 XP 초기화를 수행합니다. 사용자의 최종 승인 후에만 실행하세요. 이번 작업에서는 dry-run만 실행했습니다.**

현재 DB에는 XP의 일별 변경 이력이 없어 2026년 11월 15일 당시의 완전한 기록이라고 증명할 수 없습니다. 파일 수정 시각을 근거로 과거 스냅샷이라고 단정하지 않았습니다. 최초 기록 제목은 요청한 `2026년 2월 18일 ~ 11월 15일 랭킹`이며 실제 추출 시각과 `accuracy=actual-extraction`을 별도로 저장합니다. 검증된 과거 백업을 선택하는 자동 기능은 없으며, 현재 운영 DB와 과거 백업을 임의로 섞지 않습니다.

```sh
node archive/cli.js initial --dry-run
```

dry-run은 운영 DB를 읽기 전용으로 열고 대상 기간, 지문, 사용자 수와 상위 10명을 출력합니다. 파일, 상태 DB, 백업, JSON을 생성하거나 변경하지 않고 네트워크로 업로드하지 않습니다. 현재 공개 범위의 이름/서버 멤버 캐시가 없으므로 서버 기반 공개 예상 인원은 보수적으로 0일 수 있습니다.

승인 후 기존 봇을 완전히 멈추고 `.env`의 공개 설정과 대상 저장소를 확인한 뒤 실행합니다.

```sh
node archive/cli.js initial --commit --confirm 2026-initial --bot-stopped --accept-extraction-time
node archive/cli.js status
node archive/cli.js verify
node main.js
```

최초 정산은 검증된 백업과 로컬 스냅샷을 만든 후 공개 JSON/목록의 원격 검증까지 성공해야 DB를 전환합니다. 실패 시 기존 XP를 유지합니다. 동일한 명령으로 재시도할 수 있으며 이미 완료한 초기 정산은 다시 실행하지 않습니다. 재시도 전에 원본 DB를 임의로 수정하면 안전을 위해 중단합니다.

월간 상태 점검과 수동 복구:

```sh
node archive/cli.js status
node archive/cli.js monthly --dry-run
node archive/cli.js verify
node archive/cli.js retry-upload --bot-stopped
```

수동 월간 commit은 `--commit --confirm YYYY-MM --bot-stopped --accept-extraction-time`이 필요하며 아직 끝나지 않은 월은 거부합니다. 일반적인 운영에서는 봇 내 스케줄러가 처리합니다.

## old DB 보관과 복원

백업은 영구 보관하고 같은 이름을 덮어쓰지 않습니다. DB 전환 실패·업로드 실패에도 보존합니다. 시작 시 `levels_backup.db`를 만드는 기존 기능도 `VACUUM INTO`와 검증으로 안전하게 유지했습니다. 이 시작 백업은 매번 갱신되며 영구 old DB와 독립적입니다.

```sh
node archive/cli.js verify
node archive/cli.js restore --from archive/backups/levels_2026-11.old.db --to recovery/levels.db --bot-stopped
```

restore는 새 경로에만 검증된 복원 복사본을 생성합니다. 기존 파일이 있으면 거부하고 운영 DB는 자동 교체하지 않습니다. 실제 운영 복원은 봇을 종료한 후 현재 `levels.db`, `archive/system_state.db`, 전체 archive 폴더를 별도로 보관한 다음 진행하세요. 월간 파일 교체 장애는 이 수동 복원 대신 기존 상태 파일을 유지하고 정상 재시작하여 복구하는 편이 안전합니다.

기간 전체를 과거로 되돌리는 경우 DB만 바꾸면 현재 정산/보상 기록과 충돌합니다. 반드시 같은 시점의 상태 DB와 쌍으로 복원하고, 이후에 확정·공개한 기록 및 처리된 XP 이벤트를 검토해야 합니다. DB만 임의로 덮어쓰는 자동 롤백은 제공하지 않습니다.

## 공개 제외와 이미 공개한 기록 삭제

신규 기록에서 제외하려면 `ARCHIVE_EXCLUDED_USER_IDS`에 ID를 추가합니다. 기존 공개 기록의 비공개 요청은 서버 관리자가 받아 대상 월별로 다음 명령을 실행합니다.

```sh
node archive/cli.js redact --archive 2026-11 --user-id USER_ID --commit --confirm 2026-11 --bot-stopped
```

이 명령은 공개 업데이트 승인과 `ARCHIVE_PUBLIC_UPLOAD=true`가 필요합니다. 지정 사용자를 로컬 공개 스냅샷과 원격 JSON에서 제거하고 공개 순위를 재배정하며 `index.json`도 수정합니다. 다른 사용자의 XP나 이름을 변경할 수 없습니다. 일반 업로드의 불변 기록 보호를 개인정보 제거에 한해 명시적으로 우회합니다. 비공개 old DB와 원본 전체 스냅샷은 보존합니다.

원격 JSON 갱신 후 Pages 재배포 성공도 확인하세요. Git 커밋 이력, 기존 배포 아티팩트, 캐시, 외부 복제본은 이 명령만으로 지워지지 않습니다. 완전 삭제가 필요한 요청은 저장소 관리자가 [GitHub의 이력 제거 절차](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)를 검토하고 기존 배포·캐시도 별도로 처리해야 합니다. 이력 강제 변경을 자동으로 실행하지 않습니다.

## GitHub Pages 배포

웹사이트는 백엔드 없이 `public/data/index.json`과 해당 아카이브 JSON만 읽습니다. 소스의 빈 index는 가짜 순위를 표시하지 않습니다. 다크 테마, 최초/최신 바로가기, 연도별 목록, 월 선택, 이름/ID 검색, 순위 정렬, 25명 단위 페이지 이동, 대체 프로필, 로딩/오류/빈 화면을 제공합니다. `#2026-11` 형식으로 이동하므로 GitHub Pages 새로고침에서 별도 서버 라우팅이 필요 없습니다.

```sh
npm run build --prefix website
npm run dev --prefix website
```

배포 승인 후 소스와 잠금 파일 및 `.github/workflows/pages.yml`을 GitHub 저장소의 `main` 브랜치에 올립니다. DB, `.env`, archive 비공개 파일, `.tools`는 올리지 않습니다. 저장소 **Settings → Pages → Source: GitHub Actions**를 선택하고 제공된 워크플로를 실행합니다. 워크플로가 `website/dist`만 배포합니다. [GitHub 공식 Pages 워크플로 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)를 참고하세요.

기본 주소는 `https://OWNER.github.io/REPO/`이며 Vite의 상대 base를 사용합니다. 대상 데이터 저장소와 웹사이트 소스/워크플로 저장소는 같아야 합니다. 브랜치를 `main` 이외로 쓰면 워크플로 트리거도 함께 바꾸세요. JSON 업로드 뒤 Pages 배포가 비동기로 완료될 때까지 사이트에는 직전 데이터가 보일 수 있습니다.

## 검증과 제한

```sh
npm test
npm run build --prefix website
```

세부 결과는 `TEST_RESULTS.md`에 정리했습니다. 모든 DB 변경 테스트는 임시 폴더의 운영 DB 복사본에서 수행했습니다. 운영 DB 3개와 `commands.js`의 원본 바이트가 유지되었는지 SHA-256으로 확인했습니다.

실제 Discord 인증, 운영 서버에서 장기 실행, 실제 GitHub 쓰기/Pages 배포, 실제 브라우저의 모바일 시각 검증은 수행하지 않았습니다. 브라우저 연결을 사용할 수 없어 UI는 DOM 상호작용과 빌드로 검증했습니다. 상태 DB와 이벤트 기록은 자동 삭제하지 않으므로 디스크 용량을 관리하세요. 현재 Contents API의 base64 응답으로 원격 검증할 수 없는 큰 JSON은 업로드 완료로 인정하지 않으며, 규모가 커질 경우 파일 분할 또는 별도 검증 경로가 필요합니다.
