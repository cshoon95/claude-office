"use client";

import { useEffect } from "react";
import { backendPort } from "@/utils/api";
import { useNavigationStore } from "@/stores/navigationStore";

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ||
  // (로컬 커스텀) 접속한 호스트의 :8000 — 휴대폰(LAN)·next dev(:3000) 모두 백엔드를 가리키게(WS 규칙과 동일)
  (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:${backendPort()}` : "http://localhost:8000")}/api/v1`;

/**
 * Fetches building configuration from the backend and stores it
 * in the navigation store. Runs once on mount.
 *
 * If no floors are configured, the store stays in "single" view mode.
 */
export function useFloorConfig(): void {
  const setBuildingConfig = useNavigationStore((s) => s.setBuildingConfig);
  const setLoading = useNavigationStore((s) => s.setLoading);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/floors`)
      .then((res) => res.json())
      .then((data) => {
        // Backend returns camelCase (Pydantic to_camel alias)
        const config = {
          buildingName: data.buildingName ?? "Building",
          floors: ((data.floors ?? []) as Record<string, unknown>[]).map(
            (floor) => ({
              id: floor.id as string,
              name: floor.name as string,
              floorNumber: floor.floorNumber as number,
              accent: floor.accent as string,
              icon: floor.icon as string,
              rooms: ((floor.rooms ?? []) as Record<string, unknown>[]).map(
                (room) => ({
                  id: room.id as string,
                  repoName: room.repoName as string,
                }),
              ),
            }),
          ),
        };
        setBuildingConfig(config);
      })
      .catch(() => {
        setBuildingConfig({ buildingName: "Building", floors: [] });
      });
  }, [setBuildingConfig, setLoading]);
}
