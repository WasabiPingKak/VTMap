/**
 * Layout 參數即時微調面板。每個 slider 有獨立還原鍵,底下有全部還原。
 * NetworkPage 存 localStorage,重新整理不會被 reset。
 */

import { RotateCcw, X } from "lucide-react";
import { DEFAULT_TUNING, type LayoutTuning } from "./layout";

interface TuningPanelProps {
  tuning: LayoutTuning;
  onChange: (next: LayoutTuning) => void;
  onClose: () => void;
}

interface ParamRow {
  key: keyof LayoutTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

const ROWS: ParamRow[] = [
  { key: "linkStrength", label: "邊互拉強度", min: 0.01, max: 1, step: 0.01, hint: "越大有邊節點越靠近" },
  { key: "chargeStrength", label: "節點互斥強度", min: -1000, max: -50, step: 10, hint: "越負互斥越強" },
  { key: "radialStrength", label: "環半徑錨定強度", min: 0.1, max: 2, step: 0.05, hint: "越大越硬撐在環上" },
  { key: "collidePadding", label: "節點/標籤間距", min: 0, max: 50, step: 1, hint: "px" },
  { key: "bandGap", label: "環間最小間距", min: 0, max: 200, step: 5, hint: "px" },
  { key: "hop1CapMultiplier", label: "hop1 半徑上限倍率", min: 0.5, max: 2, step: 0.05, hint: "× ringRadii[1]" },
  { key: "hop2CapMultiplier", label: "hop2 半徑上限倍率", min: 0.5, max: 2, step: 0.05, hint: "× ringRadii[2]" },
];

export default function TuningPanel({ tuning, onChange, onClose }: TuningPanelProps) {
  const set = (key: keyof LayoutTuning, value: number) => {
    onChange({ ...tuning, [key]: value });
  };
  const resetOne = (key: keyof LayoutTuning) => {
    onChange({ ...tuning, [key]: DEFAULT_TUNING[key] });
  };
  const resetAll = () => onChange({ ...DEFAULT_TUNING });

  // 貼在 NetworkToolbar 下方(top-16 + 工具列高度),同寬 w-60,避開 bottom-left 的 NetworkLegend
  return (
    <div className="absolute top-40 left-3 z-20 w-60 max-h-[calc(100vh-320px)] overflow-y-auto rounded-lg bg-slate-950/95 backdrop-blur border border-slate-800 p-3 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-100">Layout 微調</div>
        <button
          onClick={onClose}
          aria-label="關閉"
          className="rounded p-1 text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {ROWS.map((row) => {
          const value = tuning[row.key];
          const isDefault = value === DEFAULT_TUNING[row.key];
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{row.label}</span>
                <div className="flex items-center gap-1.5">
                  <span className="tabular-nums text-slate-400">
                    {value.toFixed(row.step < 1 ? 2 : 0)}
                  </span>
                  <button
                    onClick={() => resetOne(row.key)}
                    disabled={isDefault}
                    aria-label={`還原 ${row.label}`}
                    title={`還原為預設 ${DEFAULT_TUNING[row.key]}`}
                    className="rounded p-0.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                  >
                    <RotateCcw size={11} />
                  </button>
                </div>
              </div>
              <input
                type="range"
                min={row.min}
                max={row.max}
                step={row.step}
                value={value}
                onChange={(e) => set(row.key, Number(e.target.value))}
                className="w-full accent-sky-500"
              />
              {row.hint && (
                <div className="text-[10px] text-slate-500">{row.hint}</div>
              )}
            </div>
          );
        })}
      </div>
      <button
        onClick={resetAll}
        className="mt-3 w-full rounded-lg bg-slate-800 py-2 text-sm text-slate-200 hover:bg-slate-700"
      >
        全部還原預設
      </button>
    </div>
  );
}
