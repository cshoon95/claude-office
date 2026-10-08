#!/bin/bash
# 회사 맥 자동 끄기: 정해진 시각에 채팅 플래그 제거 + LAN 끄기(서버는 로컬 전용으로 재시작).
# 사용: auto-off.sh install [HH:MM] | uninstall | status | run
# 테스트용: PLIST_PATH=/tmp/x.plist auto-off.sh install 19:00 --dry-run  (launchctl·~/Library 안 건드림)
set -u
LABEL=local.soohoon.pixel-office-auto-off
STATE="$HOME/.claude-office"
LOG="$STATE/auto-off.log"
SKILL_DIR="$HOME/.claude/skills/pixel-office"
SELF="$SKILL_DIR/auto-off.sh"
PLIST="${PLIST_PATH:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DOMAIN="gui/$(id -u)"

case "${1:-status}" in
  run)
    mkdir -p "$STATE"
    rm -f "$STATE/chat"
    note="chat 끔"
    if [ -f "$STATE/lan" ]; then
      bash "$SKILL_DIR/office.sh" lan off >/dev/null 2>&1 && note="$note, LAN 끔(서버 재시작)" || note="$note, LAN 끄기 실패"
    else
      note="$note, LAN 이미 꺼짐"
    fi
    echo "$(date '+%F %T') auto-off: $note" >> "$LOG" ;;
  install)
    t="${2:-19:00}"; dry=""
    for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
    case "$t" in --dry-run) t=19:00;; esac
    [[ "$t" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || { echo "시각은 HH:MM 형식 (예: 19:00)"; exit 1; }
    h=$((10#${BASH_REMATCH[1]})); m=$((10#${BASH_REMATCH[2]}))
    [ "$h" -le 23 ] && [ "$m" -le 59 ] || { echo "시각 범위 오류"; exit 1; }
    if [ -z "$dry" ]; then
      mkdir -p "$SKILL_DIR" "$(dirname "$PLIST")"
      [ "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" = "$SELF" ] || cp "$0" "$SELF"
    else
      mkdir -p "$(dirname "$PLIST")"
    fi
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SELF</string><string>run</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>
</dict>
</plist>
PL
    plutil -lint "$PLIST" >/dev/null || { echo "plist 오류"; exit 1; }
    if [ -n "$dry" ]; then echo "dry-run: $PLIST 생성 ($h:$(printf %02d "$m"))"; exit 0; fi
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST" && echo "설치됨: 매일 $(printf %02d "$h"):$(printf %02d "$m") 에 채팅·LAN 끔" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "제거됨" ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then echo "등록됨"; else echo "등록 안 됨"; fi
    [ -f "$PLIST" ] && grep -A1 -E 'Hour|Minute' "$PLIST" | grep -o '<integer>[0-9]*' | tr -d '<integer>' | paste -sd: - | sed 's/^/시각(H:M) /'
    [ -f "$LOG" ] && { echo "최근 로그:"; tail -3 "$LOG"; } || true ;;
  *) echo "사용: auto-off.sh install [HH:MM] | uninstall | status | run"; exit 1 ;;
esac
