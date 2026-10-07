"""(로컬 커스텀) 사용자가 직접 추가하는 캐릭터 — Claude Code 세션이 아닌 일도 Command Center에 띄운다.

저장·이벤트 발행은 ~/.claude/skills/pixel-office/task.py 가 맡는다(CLI와 같은 파일을 쓰므로 어디서 바꿔도 같다).
상태: needs_you · working · done · ended
"""

import asyncio
import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/manual", tags=["manual"])

TASK_PY = Path(os.environ.get("CLAUDE_OFFICE_TASK_PY", Path.home() / ".claude/skills/pixel-office/task.py"))
BUCKET_TO_STATUS = {"needs_you": "waiting", "working": "doing", "done": "done", "ended": "ended"}
STATUS_TO_BUCKET = {v: k for k, v in BUCKET_TO_STATUS.items()}


class ManualCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    note: str = Field(default="", max_length=200)
    bucket: str = "working"


class ManualUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=200)
    bucket: str | None = None


async def _run(*args: str) -> dict | list:
    if not TASK_PY.exists():
        raise HTTPException(status_code=500, detail=f"task.py 없음: {TASK_PY}")
    proc = await asyncio.create_subprocess_exec(
        "python3", str(TASK_PY), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
    try:
        data = json.loads(out.decode() or "null")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=err.decode()[:300] or str(e)) from e
    if proc.returncode != 0:
        raise HTTPException(status_code=404, detail=data)
    return data


def _view(t: dict) -> dict:
    return {**t, "sessionId": t["id"], "bucket": STATUS_TO_BUCKET.get(t["status"], "working")}


@router.get("")
async def list_manual() -> list[dict]:
    return [_view(t) for t in await _run("json")]  # type: ignore[union-attr]


@router.post("")
async def create_manual(body: ManualCreate) -> dict:
    if body.bucket not in BUCKET_TO_STATUS:
        raise HTTPException(status_code=422, detail="bucket must be needs_you|working|done|ended")
    t = await _run("add-json", body.name.strip(), BUCKET_TO_STATUS[body.bucket], body.note.strip())
    return _view(t)  # type: ignore[arg-type]


@router.patch("/{task_id}")
async def update_manual(task_id: str, body: ManualUpdate) -> dict:
    status = BUCKET_TO_STATUS.get(body.bucket or "", "")
    note = body.note.strip() if body.note is not None else "__KEEP__"
    t = await _run("set-id", task_id, status, note, (body.name or "").strip())
    return _view(t)  # type: ignore[arg-type]


@router.delete("/{task_id}")
async def delete_manual(task_id: str) -> dict:
    await _run("rm-id", task_id)
    return {"ok": True}
