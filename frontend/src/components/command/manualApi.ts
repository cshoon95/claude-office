// (로컬 커스텀) 직접 추가하는 캐릭터 API — backend /api/v1/manual
import { create } from "zustand";
import type { ZoneKey } from "./layout";

const API = `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/manual`;

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
  refresh: () => Promise<void>;
}

export const useManualStore = create<ManualStore>()((set) => ({
  tasks: {},
  refresh: async () => {
    try {
      const list: ManualTask[] = await fetch(API, { cache: "no-store" }).then((r) => r.json());
      set({ tasks: Object.fromEntries(list.map((t) => [t.sessionId, t])) });
    } catch {
      /* 서버가 꺼져 있으면 무시 */
    }
  },
}));

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  await useManualStore.getState().refresh();
}

export const manualApi = {
  create: (name: string, note: string, bucket: ZoneKey) => call("POST", "", { name, note, bucket }),
  update: (id: string, patch: { name?: string; note?: string; bucket?: ZoneKey }) => call("PATCH", `/${id}`, patch),
  remove: (id: string) => call("DELETE", `/${id}`),
};
