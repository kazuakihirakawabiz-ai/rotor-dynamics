// ─────────────────────────────────────────────
// MAC (Modal Assurance Criterion) によるモード対応づけ
//
// mac_matching_prototype_1.jsx で検証済みのロジックをベースに、
// UIから独立した純粋関数として切り出したもの。
//
// 【設計メモ】この切り出しは、将来この計算をSupabase Edge Function
// （サーバー側）に移す場合に備えたもの。UIコンポーネント（CompareModal等）は
// この関数群だけを呼び出す形にしておけば、呼び出し先をfetch()経由の
// サーバー呼び出しに差し替えるだけで済み、UI側の変更は不要になる。
// （プロダクト方針メモ 1-5「比較ロジックがpublicなJSに露出する」問題への
//   対策は現時点では未着手・次回以降の課題として保留）
// ─────────────────────────────────────────────

/**
 * 2つのモード形状ベクトルのMAC（Modal Assurance Criterion）を計算する。
 * 0〜1の値をとり、1に近いほど同じ変形パターンであることを示す。
 * @param {number[]} phiA モードAの形状ベクトル（M直交化済み固有ベクトル）
 * @param {number[]} phiB モードBの形状ベクトル（Aと同じDOF構成である必要がある）
 * @returns {number} MAC値（0〜1）
 */
export function computeMAC(phiA, phiB) {
  if (!phiA || !phiB || phiA.length !== phiB.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < phiA.length; i++) {
    dot += phiA[i] * phiB[i];
    na += phiA[i] * phiA[i];
    nb += phiB[i] * phiB[i];
  }
  return (dot * dot) / ((na * nb) || 1);
}

/**
 * 基準モデル(reference)の各モードに対し、比較対象モデル(target)の中で
 * 最もMACが高いモードを対応づける（行ごとargmax方式）。
 * 1対1の最適割当（ハンガリアン法等）ではない簡易版 —
 * 複数のreferenceモードが同じtargetモードを指す場合がありうる（veering現象）。
 *
 * @param {{freq:number, mode:number[]}[]} referenceModes 基準モデルのモード配列
 * @param {{freq:number, mode:number[]}[]} targetModes     比較対象モデルのモード配列
 * @returns {{
 *   refIndex: number,
 *   refFreq: number,
 *   targetIndex: number|null,
 *   targetFreq: number|null,
 *   macValue: number,
 *   lowConfidence: boolean
 * }[]} 基準モデルの各モードごとの対応づけ結果（refModesと同じ順序・同じ長さ）
 */
export function matchModesByMAC(referenceModes, targetModes, { lowConfidenceThreshold = 0.6 } = {}) {
  if (!referenceModes || !targetModes || targetModes.length === 0) {
    return (referenceModes || []).map((ref, i) => ({
      refIndex: i, refFreq: ref.freq,
      targetIndex: null, targetFreq: null, macValue: 0, lowConfidence: true,
    }));
  }

  return referenceModes.map((ref, i) => {
    let bestIdx = 0, bestVal = -1;
    for (let j = 0; j < targetModes.length; j++) {
      const v = computeMAC(ref.mode, targetModes[j].mode);
      if (v > bestVal) { bestVal = v; bestIdx = j; }
    }
    return {
      refIndex: i,
      refFreq: ref.freq,
      targetIndex: bestIdx,
      targetFreq: targetModes[bestIdx].freq,
      macValue: bestVal,
      lowConfidence: bestVal < lowConfidenceThreshold,
    };
  });
}

/**
 * 基準モデル1つに対して、複数の比較対象モデルをそれぞれMAC対応づけする
 * （プロダクト方針の「パターン1：基準モデル方式」でのN個比較）。
 *
 * @param {{freq:number, mode:number[]}[]} referenceModes 基準モデルのモード配列
 * @param {{ projectId: string, name: string, modes: {freq:number, mode:number[]}[] }[]} targets
 *        比較対象モデルの配列（プロジェクトごと）
 * @returns {{ projectId: string, name: string, matches: ReturnType<typeof matchModesByMAC> }[]}
 */
export function matchMultipleAgainstReference(referenceModes, targets, options) {
  return targets.map(t => ({
    projectId: t.projectId,
    name: t.name,
    matches: matchModesByMAC(referenceModes, t.modes, options),
  }));
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
