/**
 * Layout 參數即時微調面板。每個 slider 有獨立還原鍵,底下有全部還原。
 * NetworkPage 存 localStorage,重新整理不會被 reset。
 */

import { Minus, Plus, RotateCcw, X } from "lucide-react";
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
  /** slider 的步進(粗調) */
  step: number;
  /** +/- 按鈕的步進(細調,通常比 step 更小) */
  nudge: number;
  hint?: string;
}

const ROWS: ParamRow[] = [
  { key: "linkStrength", label: "邊互拉強度", min: 0.01, max: 1, step: 0.01, nudge: 0.01, hint: "越大有邊節點越靠近" },
  { key: "chargeStrength", label: "節點互斥強度", min: -1000, max: -50, step: 10, nudge: 1, hint: "越負互斥越強" },
  { key: "radialStrength", label: "環半徑錨定強度", min: 0.1, max: 2, step: 0.05, nudge: 0.01, hint: "越大越硬撐在環上" },
  { key: "collidePadding", label: "節點/標籤間距", min: 0, max: 50, step: 1, nudge: 1, hint: "px" },
  { key: "bandGap", label: "環間最小間距", min: 0, max: 200, step: 5, nudge: 1, hint: "px" },
  { key: "hop1CapMultiplier", label: "hop1 半徑上限倍率", min: 0.1, max: 2, step: 0.05, nudge: 0.01, hint: "× ringRadii[1]" },
  { key: "hop2CapMultiplier", label: "hop2 半徑上限倍率", min: 0.1, max: 2, step: 0.05, nudge: 0.01, hint: "× ringRadii[2]" },
  { key: "hop3CapMultiplier", label: "hop3 半徑上限倍率", min: 0.1, max: 2, step: 0.05, nudge: 0.01, hint: "× ringRadii[3]" },
  { key: "outerCapMultiplier", label: "外圍半徑上限倍率", min: 0.1, max: 2, step: 0.05, nudge: 0.01, hint: "× ringRadii[4],< 1 把灰點拉近" },
];

/** 依 step 大小決定小數位:step >= 1 顯示整數,< 1 顯示 2 位 */
function formatValue(value: number, step: number): string {
  return value.toFixed(step < 1 ? 2 : 0);
}

/** 處理浮點加減常見的尾巴誤差,四捨五入到 nudge 對應的小數位 */
function roundToNudge(value: number, nudge: number): number {
  const decimals = nudge < 1 ? Math.max(0, -Math.floor(Math.log10(nudge))) : 0;
  return Number(value.toFixed(decimals));
}

export default function TuningPanel({ tuning, onChange, onClose }: TuningPanelProps) {
  const set = (key: keyof LayoutTuning, value: number) => {
    onChange({ ...tuning, [key]: value });
  };
  const nudgeValue = (row: ParamRow, direction: 1 | -1) => {
    const next = roundToNudge(tuning[row.key] + direction * row.nudge, row.nudge);
    const clamped = Math.min(row.max, Math.max(row.min, next));
    set(row.key, clamped);
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
          const atMin = value <= row.min + 1e-9;
          const atMax = value >= row.max - 1e-9;
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{row.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => nudgeValue(row, -1)}
                    disabled={atMin}
                    aria-label={`減 ${row.nudge}`}
                    title={`- ${row.nudge}`}
                    className="rounded p-0.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <Minus size={11} />
                  </button>
                  <span className="tabular-nums text-slate-300 min-w-[2.5rem] text-center">
                    {formatValue(value, row.nudge)}
                  </span>
                  <button
                    onClick={() => nudgeValue(row, 1)}
                    disabled={atMax}
                    aria-label={`加 ${row.nudge}`}
                    title={`+ ${row.nudge}`}
                    className="rounded p-0.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <Plus size={11} />
                  </button>
                  <button
                    onClick={() => resetOne(row.key)}
                    disabled={isDefault}
                    aria-label={`還原 ${row.label}`}
                    title={`還原為預設 ${DEFAULT_TUNING[row.key]}`}
                    className="ml-0.5 rounded p-0.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
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
