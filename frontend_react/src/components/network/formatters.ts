/**
 * 面板用的顯示格式化(DetailPanel + RecentNodesPanel 共用)。
 * 集中在此避免兩處字串不同步。
 */

/** 訂閱數格式:
 *  < 1 萬 → 原始數字加千分位;
 *  1 萬 ~ 9.9 萬 → 一位小數的萬(例:5.4 萬);
 *  ≥ 10 萬 → 整數萬(例:120 萬)。
 *  null → 明確標示還沒抓,不用「不公開」這種含糊字。 */
export function formatSubscribers(count: number | null): string {
  if (count === null) return "訂閱數還沒整理";
  if (count < 10000) return `${count.toLocaleString("zh-TW")} 人訂閱`;
  const wan = count / 10000;
  const display = wan < 10 ? wan.toFixed(1) : Math.round(wan).toLocaleString("zh-TW");
  return `${display} 萬人訂閱`;
}

/** 相對時間:小於 1 天顯示「今天」、小於 30 天顯示「N 天前」、以上顯示日期 yyyy-mm-dd。
 *  null 直接回空字串,呼叫端自行決定是否顯示。 */
export function formatRelativeAdded(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "今天加入";
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days} 天前加入`;
  return `${iso.slice(0, 10)} 加入`;
}
