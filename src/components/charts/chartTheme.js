// ─────────────────────────────────────────────
// 描画系共通の定数・ユーティリティ
// COLORS は元コードでは App.jsx 側の他のUI(ボタン・テーブル等)からも参照される
// グローバル定数だったため、統合時は App.jsx 側もここから import する想定。
// formatAdaptive は数値の桁数を値の大きさに応じて自動調整するフォーマッタ。
// ─────────────────────────────────────────────

export const COLORS = {
  bg: "#FFFFFF",
  surface: "#FFFFFF",
  surface2: "#F4F6FA",
  border: "#D7DCE6",
  accent: "#0B6FB0",
  accent2: "#085A8C",
  danger: "#C0392B",
  warning: "#B8860B",
  orange: "#C4691F",
  yellow: "#FBBF24",
  success: "#1E7A3D",
  text: "#1F2937",
  textMuted: "#6B7280",
  textBright: "#0A0E1A",
  purple: "#6B3FA0",
};

// 値の大きさに応じて小数点以下の桁数を自動調整するフォーマッタ。
// 振幅など非常に小さい値（例: 0.0003mm）が "0.0" と表示されて
// 見えなくなってしまうのを防ぐために使う。
export function formatAdaptive(v, maxSig = 4) {
  if (v === 0 || !isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  // 非常に小さい値は指数表記にする
  return v.toExponential(2);
}
