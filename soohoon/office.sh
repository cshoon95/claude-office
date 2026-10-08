#!/bin/bash
# pixel-office → claude-office(paulrobello/claude-office, 수훈 커스텀)를 켜고 끈다.
# 사용: office.sh open | start | status | stop | seed | task … | lan on|off|url
#   설치 위치 ~/src/etc/claude-office, 서버 :8000 (UI 포함), 로그 ~/.claude-office/backend.log(600 권한)
#   seed: 훅 설치 전에 시작된(=session_start가 없는) 열린 세션들을 사이드바에 올린다
#   lan:  집 맥북 전용. 같은 와이파이의 휴대폰에서 보기. 토큰(설정 파일의 API 키)이 있어야 들어올 수 있다.
#   notify on|off|test: "확인 필요"가 되면 휴대폰으로 푸시(ntfy). 토픽은 설정 파일의 CLAUDE_OFFICE_NTFY_TOPIC
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 설치 위치: 수훈 맥은 ~/src/etc/claude-office, 한 줄 설치(soohoon/install.sh)는 ~/.claude-office/app
APP="${CLAUDE_OFFICE_DIR:-$([ -d "$HOME/src/etc/claude-office" ] && echo "$HOME/src/etc/claude-office" || echo "$HOME/.claude-office/app")}"
PORT=8000
STATE="$HOME/.claude-office"
LOG="$STATE/backend.log"
CFG="$HOME/.claude/claude-office-config.env"
URL="http://localhost:$PORT/"
cmd="${1:-open}"

port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }
listening() { [ -n "$(port_pid)" ]; }
# 8000번을 쓰는 게 claude-office(uvicorn app.main:app)인지 — 남의 개발 서버를 끄거나 착각하지 않게
ours() { local p; p="$(port_pid)"; [ -n "$p" ] && ps -o command= -p "$p" | grep -q "app.main:app"; }
lan_token() { [ -r "$CFG" ] && sed -n 's/^CLAUDE_OFFICE_API_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$CFG" | head -1; }
cfg_get() { [ -r "$CFG" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$CFG" | head -1; }
cfg_set() {  # 설정 파일에 KEY="값" 을 넣거나 바꾼다(값이 비면 줄을 지운다)
  python3 - "$CFG" "$1" "${2:-}" <<'EOF'
import os, re, sys
p, k, v = sys.argv[1:4]
s = open(p).read() if os.path.exists(p) else ""
s = re.sub(rf"^{k}=.*\n?", "", s, flags=re.M)
if v:
    s = s.rstrip("\n") + ("\n" if s else "") + f'{k}="{v}"\n'
open(p, "w").write(s)
os.chmod(p, 0o600)
EOF
}
lan_host() { echo "$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"; }

start() {
  if listening; then
    ours || { echo "8000번 포트를 다른 프로그램이 쓰고 있어요(pid $(port_pid)). 그걸 먼저 정리해 주세요." >&2; exit 1; }
    return
  fi
  [ -d "$APP/backend/static" ] || { echo "claude-office가 설치·빌드돼 있지 않음: $APP (wiki 오피스-집-맥북-설치 문서 참고)" >&2; exit 1; }
  mkdir -p "$STATE"; touch "$LOG"; chmod 600 "$LOG"   # 로그에 자동 API 키가 찍히므로 나만 읽게
  # LAN 모드(~/.claude-office/lan 파일이 있으면): 0.0.0.0 으로 열되, 사설망 + 토큰 쿠키가 있어야 들어온다.
  local host=127.0.0.1 lan="" token=""
  if [ -f "$STATE/lan" ]; then
    token="$(lan_token)"
    [ -n "$token" ] || { echo "LAN 토큰이 없어요($CFG 의 CLAUDE_OFFICE_API_KEY). hooks/install.sh 를 다시 실행해 주세요." >&2; exit 1; }
    host=0.0.0.0; lan=1
  fi
  # 셸과 완전히 분리해서 띄움(Claude Code Bash 도구가 기다리다 멈추지 않게)
  CO_TOKEN="$token" CLAUDE_OFFICE_NTFY_TOPIC="$(cfg_get CLAUDE_OFFICE_NTFY_TOPIC)" \
  CLAUDE_OFFICE_NTFY_SERVER="$(cfg_get CLAUDE_OFFICE_NTFY_SERVER)" CLAUDE_OFFICE_NTFY_CLICK="$(cfg_get CLAUDE_OFFICE_NTFY_CLICK)" \
  python3 - "$APP/backend" "$LOG" "$PORT" "$host" "$lan" <<'EOF'
import os, subprocess, sys
cwd, log, port, host, lan = sys.argv[1:6]
env = {**os.environ, "SERVE_STATIC": "1", "CLAUDE_OFFICE_ALLOW_LAN": lan,
       "CLAUDE_OFFICE_LAN_TOKEN": os.environ.get("CO_TOKEN", "")}
for k in ("CLAUDE_OFFICE_NTFY_TOPIC", "CLAUDE_OFFICE_NTFY_SERVER", "CLAUDE_OFFICE_NTFY_CLICK"):
    if not env.get(k):
        env.pop(k, None)  # 빈 값이면 끈 것으로
env.pop("CO_TOKEN", None)
subprocess.Popen(["uv", "run", "uvicorn", "app.main:app", "--host", host, "--port", port], cwd=cwd, env=env,
                 stdin=subprocess.DEVNULL, stdout=open(log, "ab"), stderr=subprocess.STDOUT,
                 start_new_session=True, close_fds=True)
EOF
  for _ in $(seq 1 40); do listening && break; sleep 0.5; done
  listening || { echo "시작 실패 — $LOG" >&2; exit 1; }
  echo "켜짐 → $URL"
  python3 "$HERE/task.py" sync >/dev/null 2>&1 || true   # 직접 등록한 캐릭터 다시 띄우기
}

stop() {
  if ! listening; then echo "이미 꺼짐"; return; fi
  ours || { echo "8000번은 claude-office가 아니라서 끄지 않았어요(pid $(port_pid))." >&2; return 1; }
  local p; p="$(port_pid)"
  kill "$p" 2>/dev/null || true
  # 포트가 실제로 풀릴 때까지 기다린다(곧바로 start 하면 '이미 켜짐'으로 착각하고 꺼진 채 끝나는 문제 방지)
  for _ in $(seq 1 40); do listening || break; sleep 0.25; done
  if listening; then kill -9 "$p" 2>/dev/null || true; sleep 0.5; fi
  echo "중지"
}

seed() {
  python3 - <<'EOF'
import json, os, glob, time, subprocess
now, n = time.time(), 0
for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if now - os.path.getmtime(f) > 3 * 3600: continue
    sid, cwd = os.path.basename(f)[:-6], None
    with open(f, "rb") as fh:
        for line in fh.read(200000).splitlines():
            try: d = json.loads(line)
            except Exception: continue
            if d.get("cwd"): cwd = d["cwd"]; break
    if cwd:
        try:
            subprocess.run(["claude-office-hook", "session_start"], input=json.dumps({"session_id": sid, "hook_event_name": "SessionStart",
                           "cwd": cwd, "transcript_path": f, "source": "resume"}), text=True, capture_output=True, timeout=20); n += 1
        except FileNotFoundError:
            print("claude-office-hook 을 찾지 못했어요(PATH)"); break
print(f"세션 {n}개 등록")
EOF
}

case "$cmd" in
  open) start; open "$URL" ;;
  start) start ;;
  seed) start; seed ;;
  status) if ours; then echo "실행 중 → $URL (pid $(port_pid))$([ -f "$STATE/lan" ] && echo ' · LAN 켜짐')"; elif listening; then echo "8000번을 다른 프로그램이 사용 중"; else echo "꺼짐"; fi ;;
  stop) stop ;;
  restart) stop || true; start ;;
  lan)  # office.sh lan on|off|url — 집 맥북 전용
    case "${2:-}" in
      on) mkdir -p "$STATE"; touch "$STATE/lan"; stop >/dev/null || true; start
          echo "휴대폰(같은 와이파이)에서 처음 한 번 이 주소로 여세요(토큰 포함, 남에게 공유 금지):"
          echo "  http://$(lan_host):$PORT/?token=$(lan_token)" ;;
      off) rm -f "$STATE/lan"; stop >/dev/null || true; start; echo "LAN 끔 — 이 맥에서만 열림" ;;
      url) [ -f "$STATE/lan" ] || { echo "LAN 꺼짐 (office.sh lan on)"; exit 1; }
           echo "http://$(lan_host):$PORT/?token=$(lan_token)" ;;
      *) [ -f "$STATE/lan" ] && echo "LAN 켜짐 (office.sh lan url 로 휴대폰 주소)" || echo "LAN 꺼짐 (office.sh lan on)";;
    esac ;;
  task) shift; python3 "$HERE/task.py" "$@" ;;   # office.sh task add "이름" 진행 "메모"
  notify)  # office.sh notify on|off|test — "확인 필요" 휴대폰 푸시(ntfy.sh, 계정 없음)
    case "${2:-}" in
      on) t="$(cfg_get CLAUDE_OFFICE_NTFY_TOPIC)"
          [ -n "$t" ] || { t="pixel-office-$(openssl rand -hex 12)"; cfg_set CLAUDE_OFFICE_NTFY_TOPIC "$t"; }
          stop >/dev/null || true; start >/dev/null
          echo "푸시 켬. 휴대폰에 ntfy 앱을 깔고 이 토픽을 구독하세요(남에게 알려 주지 마세요):"
          echo "  $t" ;;
      off) cfg_set CLAUDE_OFFICE_NTFY_TOPIC ""; stop >/dev/null || true; start >/dev/null; echo "푸시 끔" ;;
      test) t="$(cfg_get CLAUDE_OFFICE_NTFY_TOPIC)"; [ -n "$t" ] || { echo "꺼져 있음 (office.sh notify on)"; exit 1; }
            s="$(cfg_get CLAUDE_OFFICE_NTFY_SERVER)"; s="${s:-https://ntfy.sh}"
            curl -fsS -H "Content-Type: application/json" -d "{\"topic\":\"$t\",\"title\":\"픽셀 오피스 테스트\",\"message\":\"알림이 잘 와요\"}" "$s" >/dev/null && echo "보냄" ;;
      *) [ -n "$(cfg_get CLAUDE_OFFICE_NTFY_TOPIC)" ] && echo "푸시 켜짐" || echo "푸시 꺼짐 (office.sh notify on)" ;;
    esac ;;
  *) echo "usage: office.sh open|start|restart|status|stop|seed|task|lan|notify" >&2; exit 1 ;;
esac
