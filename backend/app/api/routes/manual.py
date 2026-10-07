"""(로컬 커스텀) 사용자가 직접 추가하는 캐릭터.

Claude Code 세션이 아닌 일도 Command Center 에 띄운다. 저장·이벤트 발행은
~/.claude/skills/pixel-office/task.py 가 맡는다(CLI 와 같은 파일이라 어디서 바꿔도 같다).
상태(bucket): needs_you · working · done · ended
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.sessions import delete_session
from app.db.database import get_db

router = APIRouter(prefix="/manual", tags=["manual"])

TASK_PY = Path(
    os.environ.get("CLAUDE_OFFICE_TASK_PY", Path.home() / ".claude/skills/pixel-office/task.py")
)
Bucket = Literal["needs_you", "working", "done", "ended"]
BUCKET_TO_STATUS: dict[str, str] = {
    "needs_you": "waiting",
    "working": "doing",
    "done": "done",
    "ended": "ended",
}
STATUS_TO_BUCKET = {v: k for k, v in BUCKET_TO_STATUS.items()}
TIMEOUT_S = 60


def _clean_name(v: str | None) -> str | None:
    """공백만 있는 이름은 거절하고, 연속 공백은 하나로."""
    if v is None:
        return None
    v = " ".join(v.split())
    if not v:
        raise ValueError("이름이 비어 있어요")
    return v


class ManualCreate(BaseModel):
    name: str = Field(max_length=40)
    note: str = Field(default="", max_length=200)
    bucket: Bucket = "working"

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return _clean_name(v) or ""


class ManualUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=200)
    bucket: Bucket | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _clean_name(v)


async def _run(*args: str) -> dict | list:
    """task.py 실행. 서버와 같은 인터프리터(sys.executable)로 돌린다 — task.py 는 3.9+ 호환."""
    if not TASK_PY.exists():
        raise HTTPException(status_code=500, detail=f"task.py 없음: {TASK_PY}")
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(TASK_PY),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(status_code=504, detail="task.py 응답 없음(시간 초과)") from None
    try:
        data = json.loads(out.decode() or "null")
    except json.JSONDecodeError:
        data = None
    if proc.returncode != 0 or data is None:
        if isinstance(data, dict) and data.get("error") == "not found":
            raise HTTPException(status_code=404, detail="해당 캐릭터를 찾지 못했어요")
        raise HTTPException(status_code=500, detail=(err.decode().strip()[-300:] or "task.py 실패"))
    return data


def _view(t: dict) -> dict:
    return {**t, "sessionId": t["id"], "bucket": STATUS_TO_BUCKET.get(t["status"], "working")}


@router.get("")
async def list_manual() -> list[dict]:
    return [_view(t) for t in await _run("json")]  # type: ignore[union-attr]


@router.post("")
async def create_manual(body: ManualCreate) -> dict:
    t = await _run("add-json", body.name, BUCKET_TO_STATUS[body.bucket], body.note.strip())
    return _view(t)  # type: ignore[arg-type]


@router.patch("/{task_id}")
async def update_manual(task_id: str, body: ManualUpdate) -> dict:
    patch: dict[str, str] = {}
    if body.bucket is not None:
        patch["status"] = BUCKET_TO_STATUS[body.bucket]
    if body.note is not None:
        patch["note"] = body.note.strip()
    if body.name is not None:
        patch["name"] = body.name
    t = await _run("set-json", task_id, json.dumps(patch, ensure_ascii=False))
    return _view(t)  # type: ignore[arg-type]


@router.delete("/{task_id}")
async def delete_manual(task_id: str, db: Annotated[AsyncSession, Depends(get_db)]) -> dict:
    await _run("rm-id", task_id)
    # 사이드바·세션 목록에 남은 기록도 지운다(직접 추가한 캐릭터는 대화 기록이 없다)
    try:
        await delete_session(task_id, db)
    except HTTPException as e:
        if e.status_code != 404:
            raise
    return {"ok": True}
