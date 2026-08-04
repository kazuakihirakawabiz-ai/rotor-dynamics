// ─────────────────────────────────────────────
// ③ キャンベル線図 (Campbell Diagram)
// 回転数(0〜maxRpm)を rpmSteps 分割してスイープし、各回転数における
// ②複素固有値解析(solveComplexEigenvalue)を繰り返し呼び出す。
// undampedModes(①固有値解析の結果)は回転数に依らず同じものを再利用し、
// ジャイロ項(Ω依存)だけが回転数ごとに変化する。
//
// ※元コードでは runAnalysis 内にベタ書きされていたスイープループを
//   関数として切り出したもの。ロジック・既定値(rpmSteps=150)は変更していない。
// ─────────────────────────────────────────────
import { solveComplexEigenvalue } from './complexEigenvalue.js';

// undampedModes: ①固有値解析(solveEigenvalue)の結果。呼び出し側で既に
//   計算済みならそれを渡す(なければ呼び出し側でフォールバック計算してから渡すこと)。
export function solveCampbellSweep(M, Ktotal, Ctotal, G, maxRpm, nModes, undampedModes, rpmSteps = 150) {
  const data = [];
  for (let i = 0; i <= rpmSteps; i++) {
    const rpm = maxRpm * i / rpmSteps;
    const Omega = rpm * Math.PI / 30;
    // Pass undamped modes — only gyroscopic term changes with Omega
    const modes = solveComplexEigenvalue(M, Ktotal, Ctotal, G, Omega, nModes, undampedModes);
    data.push({ rpm, modes });
  }
  return data;
}
