// (로컬 커스텀) 직접 추가하는 캐릭터 API — backend /api/v1/manual
import { create } from "zustand";
import { apiFetch } from "@/utils/api";
import type { ZoneKey } from "./layout";

const PATH = "/api/v1/manual";

export interface ManualTask {
  id: string;
  sessionId: string;
  name: string;
  note: string;
  bucket: ZoneKey;
  updated: string;
}

interface ManualStore {
  tasks: Record<string, ManualTask>; // sessionId → task
  error: string | null;
  refresh: () => Promise<void>;
}

export const useManualStore = create<ManualStore>()((set) => ({
  tasks: {},
  error: null,
  refresh: async () => {
    try {
      const r = await apiFetch(PATH, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status}`);
      const list: ManualTask[] = await r.json();
      set({ tasks: Object.fromEntries(list.map((t) => [t.sessionId, t])), error: null });
    } catch (e) {
      set({ error: `직접 추가한 캐릭터 목록을 못 불러왔어요 (${String(e)})` });
    }
  },
}));

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const r = await apiFetch(`${PATH}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = "";
    try {
      const j = await r.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      detail = await r.text().catch(() => "");
    }
    throw new Error(detail || `요청 실패 (${r.status})`);
  }
  await useManualStore.getState().refresh();
}

export const manualApi = {
  create: (name: string, note: string, bucket: ZoneKey) => call("POST", "", { name, note, bucket }),
  update: (id: string, patch: { name?: string; note?: string; bucket?: ZoneKey }) => call("PATCH", `/${id}`, patch),
  remove: (id: string) => call("DELETE", `/${id}`),
};
