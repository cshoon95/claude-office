---
name: pixel-office
description: 픽셀 오피스(claude-office — Claude Code 세션을 보스·직원 캐릭터가 일하는 픽셀 사무실로 보여주는 앱)를 켜고·열고·끈다. "픽셀 오피스 열어줘", "오피스 켜줘/꺼줘/상태", "세션 안 보여" 요청 시 사용.
---

# pixel-office (= claude-office)

`bash ~/.claude/skills/pixel-office/office.sh <명령>`

| 명령 | 하는 일 |
|---|---|
| `open` (기본) | 서버를 켜고 `http://localhost:8000/` 을 연다 |
| `start` / `stop` / `status` | 서버 켜기·끄기·상태 |
| `seed` | 훅 설치 전에 시작돼 사이드바에 안 보이는 열린 세션(최근 3시간)을 등록 |

## 내가 직접 관리하는 일 (Claude Code 세션이 아니어도)
`bash ~/.claude/skills/pixel-office/office.sh task <명령>` (= `python3 task.py`)

| 명령 | 하는 일 |
|---|---|
| `add "이름" [진행\|대기\|완료] ["메모"]` | 일을 등록 → 오피스에 📌 캐릭터로 출근. 메모가 말풍선 |
| `set "이름" 상태 ["메모"]` | 상태·메모 변경 (진행=WORKING 책상, 대기=NEEDS YOU, 완료=DONE 소파) |
| `done "이름"` / `rm "이름"` | 완료 처리 / 오피스에서 빼기 |
| `list` | 목록 |

- 사용자가 "오피스에 ○○ 진행 중으로 넣어줘", "○○ 대기로 바꿔줘", "○○ 끝났어" 라고 하면 이 명령으로 처리한다.
- 저장 `~/.claude-office/manual-tasks.json`. 서버를 켤 때(`start`/`open`) 자동으로 다시 띄운다.
- 할일·마감의 원본은 worklog. 여기는 "지금 내가 붙잡고 있는 일"을 눈에 보이게 하는 용도.

## 알아둘 것
- 앱: [paulrobello/claude-office](https://github.com/paulrobello/claude-office) (MIT), 설치 위치 `~/src/etc/claude-office`. 백엔드 FastAPI(uv) 하나가 UI(정적 빌드)까지 서빙, `127.0.0.1:8000`.
- 훅: `~/.claude/settings.json`에 `claude-office-hook <event>` 11개. 설정 `~/.claude/claude-office-config.env`(프로젝트 이름 접두사 정리 `CLAUDE_OFFICE_STRIP_PREFIXES`, API 키 — 공유 금지).
- 세션이 사이드바에 뜨려면 `session_start`가 필요 → 새로 켠 세션은 자동, 이미 열려 있던 세션은 `seed`.
- 세션 2개 이상이면 Command Center(모든 세션의 보스를 한 사무실에, Needs-you/Working/Done 열)가 열린다.
- 예전 Pixel Agents·현황판(3131/3132)은 훅을 빼고 껐다. 파일은 남아 있음(`board.mjs`, `office.js` 등).
- 문서: soohoon-wiki `wiki/personal/dev/픽셀-오피스.md`

## 데스크톱 창(항상 위)
- `~/Applications/Pixel Office.app` — 오피스를 항상 위에 떠 있는 창으로. 서버가 꺼져 있으면 켜고 자동 재접속.
- 메뉴 보기: 항상 위에 ⌘T · 새로고침 ⌘R · 브라우저에서 열기 ⌘O. 창 위치·크기 기억.
- 다시 빌드: `bash <wiki>/tools/pixel-office/app/build-app.sh`

## 알림·보안·업데이트
- `office.sh notify on|off|test` — "확인 필요"가 되면 휴대폰 푸시(ntfy 앱에서 출력된 토픽 구독). 토픽은 설정 파일에만, 공유 금지
- `bash ~/.claude/skills/pixel-office/auto-off.sh install 19:00` — 매일 그 시각 휴대폰 채팅·LAN 끄기(회사 컴퓨터용). `status`/`uninstall`
- Tailscale: LAN 모드에서 100.64.0.0/10·`*.ts.net` 주소도 허용(토큰은 그대로 필요)
- 최신 버전으로 업데이트: 한 줄 설치 명령을 다시 실행(curl … soohoon/install.sh | bash)
