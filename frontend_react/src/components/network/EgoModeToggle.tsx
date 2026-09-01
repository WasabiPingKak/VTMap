/**
 * ego 模式的佈局切換:同心環 / 力導向 / 徑向樹。
 * 只在圓心檢視模式(有選圓心)時顯示。
 */

import { Sun, Target, Waypoints } from "lucide-react";
import type { EgoLayoutMode } from "./layout";

interface EgoModeToggleProps {
  mode: EgoLayoutMode;
  onChange: (mode: EgoLayoutMode) => void;
}

const MODES: { id: EgoLayoutMode; icon: typeof Target; label: string }[] = [
  { id: "rings", icon: Target, label: "同心環(距離語意)" },
  { id: "force", icon: Waypoints, label: "力導向(社群語意)" },
  { id: "sunburst", icon: Sun, label: "徑向樹(親子語意)" },
];

export default function EgoModeToggle({ mode, onChange }: EgoModeToggleProps) {
  return (
    <div className="flex gap-1 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 p-1">
      {MODES.map(({ id, icon: Icon, label }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={
              active
                ? "flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-sm text-white"
                : "flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            }
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}
