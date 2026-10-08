#!/bin/bash
# 픽셀 오피스(claude-office 수훈 커스텀) 한 줄 설치 — 다른 사람 Mac 용.
#   curl -fsSL https://raw.githubusercontent.com/cshoon95/claude-office/local/soohoon-fun/soohoon/install.sh | bash
#   옵션은 bash -s -- 뒤에:  --lan(휴대폰 같은 와이파이 접속) --chat(화면 채팅창으로 Claude 에게 일 시키기) --no-app
# 하는 일: 도구 확인(git·node·uv) → claude-office(커스텀 브랜치) 받기/업데이트 → 빌드 → Claude Code 훅
#          → /pixel-office 스킬 → 서버 켜기 → 항상 위 창 앱(Pixel Office.app). 다시 실행하면 최신 버전으로 업데이트.
set -euo pipefail
REPO="https://github.com/cshoon95/claude-office.git"
BRANCH="local/soohoon-fun"
APP="${CLAUDE_OFFICE_DIR:-$([ -d "$HOME/src/etc/claude-office" ] && echo "$HOME/src/etc/claude-office" || echo "$HOME/.claude-office/app")}"
LAN=0; CHAT=0; MKAPP=1; START=1
for a in "$@"; do
  case "$a" in
    --lan) LAN=1 ;; --chat) CHAT=1 ;; --no-app) MKAPP=0 ;; --no-start) START=0 ;;
    *) echo "모르는 옵션: $a (--lan | --chat | --no-app)" >&2; exit 1 ;;
  esac
done
step() { printf '\n▶ %s\n' "$*"; }
need() { echo "❌ $1" >&2; exit 1; }

step "① 도구 확인"
[ "$(uname)" = Darwin ] || need "macOS 전용이에요."
command -v git >/dev/null || need "git 이 없어요. 터미널에서 xcode-select --install 을 먼저 실행해 주세요."
command -v claude >/dev/null || echo "⚠️  claude(Claude Code) 명령이 안 보여요. 설치돼 있지 않으면 캐릭터가 나오지 않아요."
if ! command -v uv >/dev/null || ! command -v node >/dev/null; then
  command -v brew >/dev/null || need "Homebrew 가 필요해요. https://brew.sh 의 첫 줄을 터미널에 붙여 넣어 설치한 뒤 다시 실행해 주세요."
  command -v uv >/dev/null || brew install uv
  command -v node >/dev/null || brew install node
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || need "Node 20 이상이 필요해요: brew upgrade node"
echo "node $(node -v) · $(uv --version)"

step "② claude-office 받기 → $APP"
if [ -d "$APP/.git" ]; then
  cd "$APP"
  # 내가 고친 게 있으면 지우지 않고 보관
  if [ -n "$(git status --porcelain)" ]; then
    tag="pixel-office-$(date +%Y%m%d-%H%M%S)"; git stash push -u -q -m "$tag" && echo "고친 내용을 stash 에 보관: $tag"
  fi
  git remote get-url soohoon >/dev/null 2>&1 || git remote add soohoon "$REPO"
  git fetch -q soohoon "$BRANCH"
  git checkout -q -B "$BRANCH" "soohoon/$BRANCH"
else
  [ -e "$APP" ] && need "$APP 가 이미 있는데 git 저장소가 아니에요. 옮기거나 지운 뒤 다시 실행해 주세요."
  mkdir -p "$(dirname "$APP")"
  git clone -q --branch "$BRANCH" --single-branch "$REPO" "$APP"
  cd "$APP"
  git remote rename origin soohoon
fi
git log --oneline -1

step "③ 빌드 (처음엔 몇 분 걸려요)"
(cd backend && uv sync -q) && (cd hooks && uv sync -q)
(cd frontend && npm install --no-audit --no-fund --loglevel=error && npm run build >/dev/null && rm -rf ../backend/static && cp -r out ../backend/static)
echo "빌드 완료"

step "④ Claude Code 연결(훅)"
mkdir -p ~/.claude
[ -f ~/.claude/settings.json.bak-before-claude-office ] || cp ~/.claude/settings.json ~/.claude/settings.json.bak-before-claude-office 2>/dev/null || true
# 다시 설치할 때: 전에 전체 경로로 바꿔 둔 명령을 원래 이름으로 돌려놔야 훅 설치기가 중복을 알아본다
[ -f ~/.claude/settings.json ] && python3 - "$HOME/.claude/settings.json" "$HOME/.local/bin/claude-office-hook" <<'EOF'
import sys
p, full = sys.argv[1:3]
s = open(p).read()
open(p, "w").write(s.replace(f'"{full} ', '"claude-office-hook '))
EOF
(cd hooks && ./install.sh >/dev/null) && echo "훅 설치 완료 (원래 설정 백업: ~/.claude/settings.json.bak-before-claude-office)"
# ~/.local/bin 이 PATH 에 없으면 Claude Code 가 훅 명령을 못 찾는다 → 설정에 전체 경로로 적는다
if ! command -v claude-office-hook >/dev/null && [ -x "$HOME/.local/bin/claude-office-hook" ]; then
  python3 - "$HOME/.claude/settings.json" "$HOME/.local/bin/claude-office-hook" <<'EOF'
import sys
p, full = sys.argv[1:3]
s = open(p).read()
open(p, "w").write(s.replace('"claude-office-hook ', f'"{full} '))
EOF
  echo "훅 명령을 전체 경로로 적었어요(~/.local/bin 이 PATH 에 없어서)"
fi
CFG=~/.claude/claude-office-config.env
# 캐릭터 이름을 짧게: Claude Code 는 폴더 경로의 영문·숫자 밖 글자를 '-' 로 바꿔 이름 짓는다
python3 - "$CFG" "$HOME" <<'EOF'
import os, re, sys
p, home = sys.argv[1:3]
h = re.sub(r"[^A-Za-z0-9]", "-", home)
s = open(p).read() if os.path.exists(p) else ""
new = f'CLAUDE_OFFICE_STRIP_PREFIXES="{h}--claude-office-,{h}-src-,{h}-Desktop-,{h}-Documents-,{h}-Projects-,{h}-projects-,{h}-"'
pat = r"^CLAUDE_OFFICE_STRIP_PREFIXES=.*$"
s = re.sub(pat, new, s, flags=re.M) if re.search(pat, s, flags=re.M) else s.rstrip("\n") + ("\n" if s else "") + new + "\n"
open(p, "w").write(s)
EOF
chmod 600 "$CFG"

step "⑤ /pixel-office 스킬 (\"픽셀 오피스 열어줘\" 라고 말하면 Claude 가 알아들어요)"
mkdir -p ~/.claude/skills/pixel-office
cp soohoon/office.sh soohoon/task.py soohoon/SKILL.md soohoon/auto-off.sh ~/.claude/skills/pixel-office/
chmod +x ~/.claude/skills/pixel-office/office.sh

mkdir -p ~/.claude-office
if [ "$LAN" = 1 ]; then touch ~/.claude-office/lan; else rm -f ~/.claude-office/lan; fi
if [ "$CHAT" = 1 ]; then touch ~/.claude-office/chat; fi
if [ "$START" = 1 ]; then
  step "⑥ 서버 켜기"
  CLAUDE_OFFICE_DIR="$APP" bash ~/.claude/skills/pixel-office/office.sh restart
fi

if [ "$MKAPP" = 1 ]; then
  step "⑦ 항상 위에 떠 있는 창 앱 (Pixel Office.app)"
  if command -v swiftc >/dev/null; then
    CLAUDE_OFFICE_DIR="$APP" bash soohoon/app/build-app.sh || echo "앱 만들기 실패 — 브라우저로 쓰면 돼요"
  else
    echo "swiftc 가 없어 건너뜀 (xcode-select --install 뒤 다시 실행하면 만들어져요)"
  fi
fi

echo
echo "✅ 설치 완료!"
echo "  화면:   http://localhost:8000/   (위쪽 COMMAND → 모든 세션)"
[ -d "$HOME/Applications/Pixel Office.app" ] && echo "  창 앱:  ~/Applications/Pixel Office.app  (항상 위 ⌘T · 새로고침 ⌘R)"
[ "$LAN" = 1 ] && echo "  휴대폰: bash ~/.claude/skills/pixel-office/office.sh lan url 주소를 같은 와이파이에서 한 번 열기(토큰 포함 — 남에게 보내지 마세요)"
[ -e ~/.claude-office/chat ] && echo "  채팅창: 켜짐 — 채팅으로 시킨 Claude 는 모든 권한으로 돌아요. 끄기: rm ~/.claude-office/chat"
echo "  👉 Claude Code 를 한 번 껐다 켜면 캐릭터가 출근해요."
if [ "$START" = 1 ]; then
  if [ -d "$HOME/Applications/Pixel Office.app" ]; then open "$HOME/Applications/Pixel Office.app"; else open "http://localhost:8000/" || true; fi
fi
