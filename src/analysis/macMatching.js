// ─────────────────────────────────────────────
// MAC (Modal Assurance Criterion) によるモード対応づけ
//
// 【設計メモ・2026-08-21】
// MAC計算ロジック本体（computeMAC・computeMACMatrix・matchModesByMAC・
// matchMultipleAgainstReference）は、Supabase Edge Function 'mac-match' に
// 移した（プロダクト方針メモ 1-5「比較ロジックがpublicなJSに露出する」問題への
// 対策）。以前はここに実装があったが、クライアント側のJSバンドルに計算式が
// そのまま含まれてしまい、誰でも中身を読めてしまう状態だったため。
//
// クライアント側（ComparePanel.jsx）は supabase.functions.invoke('mac-match', ...)
// で呼び出し、結果のJSON（macMatrix・matches）だけを受け取る。
// Edge Function側の実装・アクセス制御はSupabaseダッシュボードで管理
// （このリポジトリにソースは含まれない。ダッシュボードから直接編集する運用）。
//
// このファイルに残しているのは、DOF数に依存しない・サーバーに送るまでもない
// 「表示専用の軽い処理」のみ：
//   - nearestFreqIndices：周波数だけを見た参考値（MAC計算とは無関係）
//   - extractY・alignSign：形状重ね描き表示のための整形処理
// ─────────────────────────────────────────────

/**
 * 「もし周波数の値だけで対応づけたら、どのモードが一番近いか」を返す。
 * MACの計算には一切使わない・比較のためだけの参考値
 * （「MACは結局、周波数が近いものを選んでいるだけでは？」という疑問に答えるため）。
 * @param {{freq:number}[]} referenceModes
 * @param {{freq:number}[]} targetModes
 * @returns {number[]} referenceModesと同じ長さ。各要素は最も周波数が近いtargetModesのインデックス
 */
export function nearestFreqIndices(referenceModes, targetModes) {
  if (!targetModes || targetModes.length === 0) return (referenceModes || []).map(() => -1);
  return (referenceModes || []).map(ref => {
    const diffs = targetModes.map(t => Math.abs(t.freq - ref.freq));
    return diffs.indexOf(Math.min(...diffs));
  });
}

/**
 * eigenResults（App本体の解析結果）と、モード形状描画に必要な位置情報から、
 * DB保存・MAC計算・形状重ね描きに必要な軽量スナップショットを組み立てる。
 *
 * 【設計メモ】nodePositions/bearingPos/diskPosを保存時に一緒に持たせておくことで、
 * 比較画面では model_data から assembleSystem 相当を再計算する必要がなくなる
 * （保存されたプロジェクトはシャフト構成が互いに異なりうるため、比較画面側で
 *  再現するより、保存時点の位置情報をそのまま持ち歩く方がシンプルで軽量）。
 *
 * @param {{omega:number, freq:number, mode:number[]}[]} eigenResults
 * @param {number[]} nodePositions 各節点のx座標配列（App本体のresults.nodePositions）
 * @param {{position:number}[]} disks ディスク配列（App本体のdisks state）
 * @param {{position:number}[]} bearings 軸受配列（App本体のbearings state）
 * @returns {{ modes: {freq:number, mode:number[]}[], nodePositions: number[], bearingPos: number[], diskPos: number[] }}
 */
export function buildAnalysisSnapshot(eigenResults, nodePositions, disks, bearings) {
  return {
    modes: extractLightweightModes(eigenResults),
    nodePositions: nodePositions || [],
    bearingPos: (bearings || []).map(b => b.position),
    diskPos: (disks || []).map(d => d.position),
  };
}

/**
 * eigenResults（App本体の解析結果）から、DB保存・MAC計算に必要な
 * freq/modeのみの軽量な配列を切り出す。
 * @param {{omega:number, freq:number, mode:number[]}[]} eigenResults
 * @returns {{freq:number, mode:number[]}[]}
 */
export function extractLightweightModes(eigenResults) {
  if (!Array.isArray(eigenResults)) return [];
  return eigenResults.map(r => ({ freq: r.freq, mode: r.mode }));
}

/**
 * モード形状ベクトルから、各節点のy方向変位のみを取り出す
 * （4 DOF/node: vy, θz, vz, θy の並びを前提。キャンベル線図と別に
 *  形状を重ね描きする際に使用）。
 * @param {number[]} mode
 * @returns {number[]}
 */
export function extractY(mode) {
  const y = [];
  for (let i = 0; i < mode.length; i += 4) y.push(mode[i]);
  return y;
}

/**
 * モード形状の符号任意性（φと-φは物理的に同じモード）を、基準側に合わせて揃える。
 * @param {number[]} yRef 基準側のy成分配列
 * @param {number[]} yTarget 揃えたい側のy成分配列
 * @returns {number[]} 符号を揃えたyTarget
 */
export function alignSign(yRef, yTarget) {
  let dot = 0;
  for (let i = 0; i < yRef.length; i++) dot += yRef[i] * yTarget[i];
  return dot < 0 ? yTarget.map(v => -v) : yTarget;
}
