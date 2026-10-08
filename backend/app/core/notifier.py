"""(로컬 커스텀) 세션이 "확인 필요"(needs_you)로 들어가면 휴대폰에 푸시.

ntfy(https://ntfy.sh) 에 HTTP POST 한 번 — 계정 필요 없음. 휴대폰 ntfy 앱에서
같은 토픽을 구독하면 알림이 온다. 토픽 이름이 곧 비밀번호이므로 길고 무작위로 정한다.

환경변수(서버 기동 시 office.sh 가 넘겨준다):
- CLAUDE_OFFICE_NTFY_TOPIC  : 있으면 켜짐, 없으면 꺼짐(네트워크 접근 없음)
- CLAUDE_OFFICE_NTFY_SERVER : 기본 https://ntfy.sh
- CLAUDE_OFFICE_NTFY_CLICK  : 알림을 눌렀을 때 열 주소(선택)

needs_you 로 "들어갈 때" 한 번만 보낸다(머무는 동안 반복 X). 세션당 60초에 한 번까지.
보내기는 fire-and-forget — 이벤트 처리를 막지 않고, 실패는 로그만 남긴다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEBOUNCE_S = 60.0
TIMEOUT_S = 3.0
BODY_MAX = 200
DEFAULT_BODY = "Claude 가 답을 기다려요"

_last_bucket: dict[str, str] = {}
_last_sent: dict[str, float] = {}
_names: dict[str, str] = {}
_tasks: set[asyncio.Task[None]] = set()


def _topic() -> str:
    return os.environ.get("CLAUDE_OFFICE_NTFY_TOPIC", "").strip()


def _is_claude_session(session_id: str) -> bool:
    """Claude Code 세션 id 는 UUID. 직접 추가한 캐릭터(manual)는 알리지 않는다."""
    try:
        uuid.UUID(session_id)
    except ValueError:
        return False
    return True


def on_session_update(
    session_id: str,
    bucket: str,
    *,
    name: str | None = None,
    pending_question: str | None = None,
) -> None:
    """이벤트 처리 직후 호출. needs_you 로 바뀌는 순간에만 푸시를 예약한다."""
    if name:
        _names[session_id] = name
    prev = _last_bucket.get(session_id)
    _last_bucket[session_id] = bucket
    if bucket != "needs_you" or prev == "needs_you":
        return
    if not _topic() or not _is_claude_session(session_id):
        return
    now = time.monotonic()
    last = _last_sent.get(session_id)
    if last is not None and now - last < DEBOUNCE_S:
        return
    _last_sent[session_id] = now

    title = f"확인 필요 · {_names.get(session_id) or session_id[:8]}"
    body = (pending_question or DEFAULT_BODY).strip()
    if len(body) > BODY_MAX:
        body = body[: BODY_MAX - 1] + "…"
    try:
        task = asyncio.get_running_loop().create_task(_send(title, body))
    except RuntimeError:
        return  # 이벤트 루프 밖(동기 테스트 등) — 조용히 건너뛴다
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _send(title: str, body: str) -> None:
    server = os.environ.get("CLAUDE_OFFICE_NTFY_SERVER", "").strip() or "https://ntfy.sh"
    # JSON 으로 보내야 제목의 한글이 헤더 인코딩 문제 없이 간다
    payload: dict[str, Any] = {"topic": _topic(), "title": title, "message": body, "tags": ["bell"]}
    click = os.environ.get("CLAUDE_OFFICE_NTFY_CLICK", "").strip()
    if click:
        payload["click"] = click
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            resp = await client.post(server.rstrip("/") + "/", json=payload)
            resp.raise_for_status()
    except Exception as e:  # 알림 실패가 사무실을 멈추면 안 된다
        logger.warning("ntfy push failed: %s", e)
