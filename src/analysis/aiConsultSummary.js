// ═══════════════════════════════════════════════════════════════
// AI相談タブ（④ AI相談）専用のサマリ生成ロジック
//
// 【位置づけ】
// 「AIに貼り付けられる結果」専用タブ（1-10要望5・1-12で設計）向けに、
// 単体モデル・比較（①-2/②-3/③-2）それぞれのサマリをMarkdown文章として組み立てる。
//
// 【1-12での設計判断・案B（最小差分）】
// ComparePanel.jsx / CampbellComparePanel.jsx / FreqResponseComparePanel.jsx には
// 同種の計算ロジック（危険速度・マージン判定など）が既に存在するが、今回はそれらを
// 共通化・移動せず、このファイルに簡略版を独立して新規実装する。
// 理由：①それら3ファイルは1-11で動作確認済みのため今は触れたくない、②AI相談タブの
// 仕様自体がまだ固まっていない（初回実装のため今後変わる可能性が高い）。
// 将来、AI相談タブの仕様が安定した時点で、App.jsxのリファクタリングと合わせて
// 共通ユーティリティ化を検討する（1-12申し送り事項）。
//
// 【比較サマリの再計算方式（方式2）】
// 比較3タブ側のローカルstate（selectedIds等）をApp.jsxに複製せず、
// 「最後にどの比較タブで、どのプロジェクトIDが選ばれていたか」という軽量な情報だけを
// App.jsxが持つ。AI相談タブを開いたタイミングで、このファイルの関数が選択IDから
// Supabaseを再取得し、その場でサマリ用に再計算する（計算結果は複製・キャッシュしない）。
// ═══════════════════════════════════════════════════════════════

// ── 危険速度（1X/2X/3XとモードのRPM交点）を1系列ぶん求める ──
// CampbellComparePanel.jsx内のfindCriticalSpeedsと同じロジック（意図的な重複。案B参照）。
function findCriticalSpeeds(campbellData, maxRpm) {
  if (!campbellData || campbellData.length === 0) return [];
  const modeCount = campbellData[0]?.modes?.length || 0;
  const criticalSpeeds = [];
  [1, 2, 3].forEach(n => {
    for (let m = 0; m < modeCount; m++) {
      for (let i = 0; i < campbellData.length - 1; i++) {
        const pt0 = campbellData[i], pt1 = campbellData[i + 1];
        if (!pt0.modes[m] || !pt1.modes[m]) continue;
        const rpm0 = pt0.rpm, rpm1 = pt1.rpm;
        const f0 = pt0.modes[m].freq, f1 = pt1.modes[m].freq;
        const modeMeta = { isForward: pt0.modes[m].isForward, undampedModeIdx: pt0.modes[m].undampedModeIdx };
        const g0 = f0 - n * rpm0 / 60;
        const g1 = f1 - n * rpm1 / 60;
        if (g0 === 0) {
          criticalSpeeds.push({ rpm: rpm0, freq: f0, order: n, modeIdx: m, ...modeMeta });
        } else if (g0 * g1 < 0) {
          const t = g0 / (g0 - g1);
          criticalSpeeds.push({ rpm: rpm0 + t * (rpm1 - rpm0), freq: f0 + t * (f1 - f0), order: n, modeIdx: m, ...modeMeta });
        }
      }
    }
  });
  return criticalSpeeds
    .filter(cs => cs.rpm >= 0 && cs.rpm <= maxRpm)
    .sort((a, b) => a.rpm - b.rpm);
}

// ── 運用回転数レンジに対する余裕度を判定する ──
// CampbellComparePanel.jsx内のmarginStatusと同じ境界値（1-9g合意）を使う（意図的な重複）。
function marginStatus(rpm, operatingMinRpm, operatingMaxRpm) {
  if (operatingMinRpm == null || operatingMaxRpm == null) return null;
  if (rpm >= operatingMinRpm && rpm <= operatingMaxRpm) {
    return { category: '運用範囲内', pct: 0, level: 0 };
  }
  const overHi = rpm > operatingMaxRpm;
  const refEdge = overHi ? operatingMaxRpm : operatingMinRpm;
  const pct = refEdge !== 0 ? Math.abs(rpm - refEdge) / Math.abs(refEdge) * 100 : Infinity;
  if (pct <= 10) return { category: '10%マージン内', pct, level: 1 };
  if (pct <= 20) return { category: '20%マージン内', pct, level: 2 };
  return { category: '20%超', pct, level: 3 };
}

// ── Δ（差分）を「+12.3 Hz (+4.2%)」のような文字列にする ──
function formatDelta(base, current, unit = '') {
  if (base == null || current == null) return null;
  const delta = current - base;
  const pct = base !== 0 ? (delta / base) * 100 : null;
  const sign = delta >= 0 ? '+' : '';
  const pctStr = pct != null ? ` (${sign}${pct.toFixed(1)}%)` : '';
  return `${sign}${delta.toFixed(2)}${unit}${pctStr}`;
}

// ═══════════════════════════════════════════════════════════════
// ① 単体モデルのサマリ（①-1固有値・②-1複素固有値・②-2キャンベル・③周波数応答）
// ═══════════════════════════════════════════════════════════════
// App.jsxのresults / criticalSpeeds / settingsから、人が読める形のMarkdown文章を組み立てる。
// handleExportAllResults（CSV全出力）と同じデータソースを使うが、出力形式は
// 「AIに読ませて相談する」目的に合わせてサマリ主体（生の掃引データまでは含めない）にする。
export function buildSingleModelSummary({ results, criticalSpeeds, settings, disks, bearings }) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  const hasAny =
    (results?.eigenResults && results.eigenResults.length > 0) ||
    (results?.complexResults && results.complexResults.length > 0) ||
    (results?.campbellData && results.campbellData.length > 0) ||
    (results?.freqResponse && results.freqResponse.length > 0);

  if (!hasAny) return null;

  push('## ロータダイナミクス解析結果サマリ（単体モデル）');
  push('');

  // ①-1 固有値解析
  if (results.eigenResults && results.eigenResults.length > 0) {
    push('### 固有値解析（Undamped Eigenvalue）');
    results.eigenResults.forEach((r, i) => {
      push(`- Mode ${i + 1}: ${r.freq.toFixed(2)} Hz（1X危険速度換算 ${(r.freq * 60).toFixed(0)} rpm）`);
    });
    push('');
  }

  // ②-1 複素固有値解析（安定性）
  if (results.complexResults && results.complexResults.length > 0) {
    push('### 複素固有値解析（安定性）');
    results.complexResults.forEach(r => {
      const label = `Mode ${r.undampedModeIdx + 1}${r.isForward ? 'F' : 'B'}`;
      const dir = r.isForward ? 'Forward' : 'Backward';
      const stable = r.sigma < 0 ? '安定' : '不安定';
      push(`- ${label}（${dir}）: ${r.freq.toFixed(2)} Hz, 減衰比ζ=${r.zeta.toFixed(4)}, ${stable}（実部σ=${r.sigma.toFixed(4)}）`);
    });
    push('');
  }

  // ②-2 危険速度（1X/2X/3X交点）＋運用回転数レンジとの余裕度
  if (criticalSpeeds && criticalSpeeds.length > 0) {
    push('### 危険速度（1X/2X/3X励振線との交点）');
    if (settings?.operatingMinRpm != null && settings?.operatingMaxRpm != null) {
      push(`運用回転数レンジ: ${settings.operatingMinRpm} – ${settings.operatingMaxRpm} rpm`);
    }
    criticalSpeeds.forEach(cs => {
      const margin = marginStatus(cs.rpm, settings?.operatingMinRpm, settings?.operatingMaxRpm);
      const marginStr = margin ? `　→ ${margin.category}${margin.level > 0 ? `（${margin.pct.toFixed(1)}%）` : ''}` : '';
      push(`- ${cs.order}X - Mode ${cs.modeIdx + 1}: ${cs.rpm.toFixed(0)} rpm（${cs.freq.toFixed(2)} Hz）${marginStr}`);
    });
    push('');
  }

  // ③ 周波数応答（不釣合い応答）のピーク値
  if (results.freqResponse && results.freqResponse.length > 0) {
    push('### 周波数応答（アンバランス応答）');
    let maxAmp = -1, maxAmpRpm = null;
    results.freqResponse.forEach(r => {
      const localMax = Math.max(...(r.nodeAmp || [0]));
      if (localMax > maxAmp) { maxAmp = localMax; maxAmpRpm = r.rpm; }
    });
    push(`- 最大振幅: ${maxAmp.toExponential(3)} mm（${maxAmpRpm?.toFixed(0) ?? '—'} rpm付近）`);
    push(`- アンバランス設定箇所数: ${(disks || []).filter(d => d.hasUnbalance).length}`);
    push('');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// ② 比較サマリ（①-2固有値比較 / ②-3キャンベル比較 / ③-2周波数応答比較）
// 選択済みプロジェクトID一覧とsupabaseクライアントを受け取り、再計算してMarkdownを返す。
// ═══════════════════════════════════════════════════════════════

// ①-2相当：固有振動数の時系列比較（保存済みanalysis_resultsのmodesをそのまま使う。
// MAC対応づけ自体の再計算はサマリでは行わず、保存済みモード番号の並びをそのまま使う簡略版）。
export async function buildEigenCompareSummary(supabase, selectedIds, baselineId) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, updated_at, analysis_results')
    .in('id', selectedIds);
  if (error || !data) return null;

  const projects = data.filter(p => p.analysis_results?.modes?.length > 0);
  if (projects.length === 0) return null;

  const baseline = projects.find(p => p.id === baselineId) || projects[0];
  const others = projects.filter(p => p.id !== baseline.id);
  const maxModeCount = Math.max(...projects.map(p => p.analysis_results.modes.length));

  const lines = [];
  const push = (s = '') => lines.push(s);
  push('## 固有値解析 比較サマリ（①-2）');
  push(`基準: ${baseline.name}　比較対象: ${others.map(p => p.name).join(' / ')}`);
  push('');
  push('| Mode | ' + [baseline, ...others].map(p => p.name).join(' | ') + ' |');
  push('|---' + [baseline, ...others].map(() => '|---').join('') + '|');
  for (let m = 0; m < maxModeCount; m++) {
    const baseFreq = baseline.analysis_results.modes[m]?.freq;
    const row = [baseFreq != null ? `${baseFreq.toFixed(2)} Hz` : '—'];
    others.forEach(p => {
      const f = p.analysis_results.modes[m]?.freq;
      if (f == null || baseFreq == null) { row.push('—'); return; }
      row.push(`${f.toFixed(2)} Hz (${formatDelta(baseFreq, f, 'Hz')})`);
    });
    push(`| Mode ${m + 1} | ${row.join(' | ')} |`);
  }
  push('');
  return lines.join('\n');
}

// model_dataからshaftElems解決済み・M/K/G/Kb/Cb一式を組み立てる共通の下ごしらえ処理。
// CampbellComparePanel.jsx／FreqResponseComparePanel.jsxのcomputeXxxForProjectと同じ手順
// （意図的な重複。案B参照）。
function assembleFromModelData(m, { assembleSystem, matAdd }) {
  const { shaftElems, materials, disks, bearings, settings } = m;
  if (!shaftElems || !materials || !settings) throw new Error('モデルデータの形式が不正です');
  const resolveMat = (materialId) =>
    materials.find(x => x.id === materialId) || materials[0] || { youngMod: 200, density: 8190 };
  const shaftElemsResolved = shaftElems.map(el => {
    const mat = resolveMat(el.materialId);
    return { ...el, youngMod: mat.youngMod, density: mat.density };
  });
  const sys = assembleSystem(shaftElemsResolved, disks || [], bearings || []);
  const { M, K, G, Kb, Cb, nodePositions } = sys;
  const C = M.map((row, i) => row.map((v, j) =>
    settings.alphaRayleigh * M[i][j] + settings.betaRayleigh * K[i][j]
  ));
  const Ktotal = matAdd(K, Kb);
  const Ctotal = matAdd(C, Cb);
  return { M, K, G, Kb, Cb, C, Ktotal, Ctotal, nodePositions, settings, disks: disks || [] };
}

// ②-3相当：危険速度比較表（次数×モードを行、選択済み全プロジェクトを列とする）。
// 各プロジェクトのmodel_dataからキャンベル線図を再計算する（CampbellComparePanel.jsxの
// computeCampbellForProjectと同じ手順）。必要な計算関数はApp.jsx側から注入する。
export async function buildCampbellCompareSummary(supabase, selectedIds, { assembleSystem, matAdd, solveEigenvalue, solveCampbellSweep }) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, updated_at, model_data')
    .in('id', selectedIds);
  if (error || !data) return null;

  const withCampbell = data
    .map(p => {
      const md = p.model_data;
      if (!md) return null;
      try {
        const { M, Ktotal, Ctotal, G, settings } = assembleFromModelData(md, { assembleSystem, matAdd });
        const undamped = solveEigenvalue(M, Ktotal, settings.nModes);
        const campbellData = solveCampbellSweep(M, Ktotal, Ctotal, G, settings.maxRpm, settings.nModes, undamped);
        return {
          id: p.id, name: p.name,
          campbellData,
          maxRpm: settings.maxRpm,
          operatingMinRpm: settings.operatingMinRpm,
          operatingMaxRpm: settings.operatingMaxRpm,
        };
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);

  if (withCampbell.length === 0) return null;

  const rowKeySet = new Map();
  withCampbell.forEach(proj => {
    findCriticalSpeeds(proj.campbellData, proj.maxRpm).forEach(cs => {
      const key = `${cs.order}-${cs.undampedModeIdx ?? cs.modeIdx}-${cs.isForward}`;
      if (!rowKeySet.has(key)) rowKeySet.set(key, cs);
    });
  });

  const lines = [];
  const push = (s = '') => lines.push(s);
  push('## キャンベル線図 比較サマリ（②-3・危険速度比較）');
  push(`対象プロジェクト: ${withCampbell.map(p => p.name).join(' / ')}`);
  push('');
  push('| 次数-モード | ' + withCampbell.map(p => p.name).join(' | ') + ' |');
  push('|---' + withCampbell.map(() => '|---').join('') + '|');

  [...rowKeySet.entries()]
    .sort((a, b) => a[1].order - b[1].order || (a[1].undampedModeIdx ?? a[1].modeIdx) - (b[1].undampedModeIdx ?? b[1].modeIdx))
    .forEach(([key, meta]) => {
      const label = `${meta.order}X - Mode${(meta.undampedModeIdx ?? meta.modeIdx) + 1}${meta.isForward === undefined ? '' : (meta.isForward ? 'F' : 'B')}`;
      const cells = withCampbell.map(proj => {
        const cs = findCriticalSpeeds(proj.campbellData, proj.maxRpm)
          .find(c => `${c.order}-${c.undampedModeIdx ?? c.modeIdx}-${c.isForward}` === key);
        if (!cs) return '—';
        const margin = marginStatus(cs.rpm, proj.operatingMinRpm, proj.operatingMaxRpm);
        const marginStr = margin ? `（${margin.category}）` : '';
        return `${cs.rpm.toFixed(0)} rpm${marginStr}`;
      });
      push(`| ${label} | ${cells.join(' | ')} |`);
    });
  push('');
  return lines.join('\n');
}

// ③-2相当：周波数応答比較（デフォルト部位＝全体の最大のみに簡略化。1-12合意）。
// FreqResponseComparePanel.jsxのcomputeFreqResponseForProjectと同じ手順で再計算する
// （モードは保存済みanalysis_results.modesをそのまま使う。解析範囲は固有振動数×1.5まで自動拡張）。
export async function buildFreqCompareSummary(supabase, selectedIds, baselineId, { assembleSystem, matAdd, solveFrequencyResponse }) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, updated_at, model_data, analysis_results')
    .in('id', selectedIds);
  if (error || !data) return null;

  const withFreq = data
    .map(p => {
      const md = p.model_data;
      const modes = p.analysis_results?.modes || [];
      if (!md || modes.length === 0) return null;
      try {
        const { M, Ktotal, Ctotal, G, Kb, Cb, nodePositions, settings, disks } = assembleFromModelData(md, { assembleSystem, matAdd });

        const unbalancesFromDisks = disks.filter(d => d.hasUnbalance).map(d => ({
          position: d.position,
          mass: d.unbalanceMass || 0,
          eccentricity: d.eccentricity || 0,
          phase: d.unbalancePhase || 0,
        }));

        const nOmegaSteps = 300;
        const eigenFreqs = modes.map(r => r.freq * 60);
        const freqMaxRpm = eigenFreqs.length > 0
          ? Math.max(settings.maxRpm, eigenFreqs[eigenFreqs.length - 1] * 1.5)
          : settings.maxRpm;
        const omegaRange = Array.from({ length: nOmegaSteps }, (_, i) =>
          (settings.minRpm + (freqMaxRpm - settings.minRpm) * i / (nOmegaSteps - 1)) * Math.PI / 30
        );

        let freqResponse;
        if (unbalancesFromDisks.length === 0) {
          const zeroNodes = new Array(nodePositions.length).fill(0);
          freqResponse = omegaRange.map(Omega => ({
            omega: Omega, freq: Omega / (2 * Math.PI), rpm: Omega * 60 / (2 * Math.PI),
            nodeAmp: zeroNodes, nodePhase: zeroNodes,
          }));
        } else {
          freqResponse = solveFrequencyResponse(M, Ktotal, Ctotal, G, Kb, Cb, unbalancesFromDisks, omegaRange, nodePositions, modes);
        }

        let maxAmp = -1, maxAmpRpm = null;
        freqResponse.forEach(r => {
          const localMax = Math.max(...(r.nodeAmp || [0]));
          if (localMax > maxAmp) { maxAmp = localMax; maxAmpRpm = r.rpm; }
        });
        return { id: p.id, name: p.name, maxAmp, maxAmpRpm };
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);

  if (withFreq.length === 0) return null;

  const baseline = withFreq.find(p => p.id === baselineId) || withFreq[0];
  const others = withFreq.filter(p => p.id !== baseline.id);

  const lines = [];
  const push = (s = '') => lines.push(s);
  push('## 周波数応答 比較サマリ（③-2・全体最大振幅のみ）');
  push(`基準: ${baseline.name}　比較対象: ${others.map(p => p.name).join(' / ')}`);
  push('');
  push(`- ${baseline.name}: 最大振幅 ${baseline.maxAmp.toExponential(3)} mm（${baseline.maxAmpRpm?.toFixed(0) ?? '—'} rpm付近）`);
  others.forEach(p => {
    const delta = formatDelta(baseline.maxAmp, p.maxAmp, 'mm');
    push(`- ${p.name}: 最大振幅 ${p.maxAmp.toExponential(3)} mm（${p.maxAmpRpm?.toFixed(0) ?? '—'} rpm付近）　Δ${delta}`);
  });
  push('');
  return lines.join('\n');
}
