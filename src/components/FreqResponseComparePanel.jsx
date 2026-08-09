import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { assembleSystem, matAdd } from "../analysis/femCore.js";
import { solveFrequencyResponse } from "../analysis/frequencyResponse.js";
import { COLORS } from "./charts/chartTheme.js";
import { LineChart } from "./charts/LineChart.jsx";

// App.jsx／ComparePanel.jsx／CampbellComparePanel.jsx側と同じSupabaseクライアント設定を再利用する。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ── 時系列比較表のΔ（▲▼）に付ける色 ──
// ComparePanel.jsx（①-2）と同じ考え方。「大小」ではなく「良い方向／悪い方向」で色分けする（1-9g合意）。
// 危険速度は上昇が良い方向（運用回転数から離れる）なのでdeltaGoodDirection='up'。
// ピーク振幅は上昇が悪い方向（振動が増える）なのでdeltaGoodDirection='down'。
function deltaColor(delta, goodDirection = 'up') {
  if (delta == null) return COLORS.textMuted;
  const isIncrease = delta >= 0;
  const isGood = goodDirection === 'up' ? isIncrease : !isIncrease;
  return isGood ? COLORS.accent : COLORS.danger;
}

/**
 * ③-2 周波数応答比較（Pro限定機能）— 「①-2 固有値解析 比較」「②-3 キャンベル線図比較」と同列の独立比較タブ。
 *
 * 【なぜ別コンポーネントなのか】②-3と同じ理由：DB保存の軽量スナップショット(analysis_results＝
 * 固有振動数＋モード形状のみ)には周波数応答の生データ(rpm掃引×アンバランス応答)が無いため、選択した
 * プロジェクトのmodel_dataから毎回その場でassembleSystem→solveFrequencyResponseを再計算する。
 * ①-2・②-3とはプロジェクト選択の状態を共有せず、ここで改めて選び直す仕様（②-3で確立した方針を踏襲）。
 * プロジェクト一覧の取得・選択・「解析モデル」展開まわりのUIも、意図的にほぼ同じものをここに持たせている。
 *
 * 【eigenvalueの再計算を省略している点】solveFrequencyResponseはモード形状(modes)を必要とするが、
 * これは一覧取得時に既に持っているanalysis_results.modesをそのまま使う。model_dataとanalysis_results
 * は常に1対1対応という設計原則（プロダクト方針メモ1-9）を前提に、solveEigenvalueの再計算をここでは
 * 省略している（②-3のcomputeCampbellForProjectはこの前提を使わずsolveEigenvalueから再計算しているが、
 * 周波数応答側はモード形状さえあれば計算できるため、計算コストを1ステップ減らせる）。
 *
 * 【比較点は「全体の最大」または特定の部位を選択可能】①周波数応答タブ本体はディスク／軸受ごとの
 * 応答点を選べる（pointOptions）。③-2側も同様に部位選択を導入したが、比較対象2件は軸受・ディスクの
 * 構成そのものが異なりうる（例：軸受位置を変えた設計変更）ため、以下の設計にしている：
 *   - 部位選択の選択肢一覧は「時系列表の基準列（tableBaselineId）に選ばれているプロジェクト」の
 *     disks/bearingsから作る（基準列を切り替えると選択肢も連動して切り替わる）。
 *   - 選んだ部位が他のプロジェクトに存在しない場合、そのプロジェクトの値は「該当なし（—）」にする。
 *   - 部位選択は時系列表・グラフ比較（ボード線図）の両方が共通で参照する、独立した1つのUI。
 * デフォルトは「全体の最大（各回転数でシャフト全節点のうち最も振幅が大きい点）」。
 */
export function FreqResponseComparePanel({ session, profile, onUpgradeClick, active = true }) {
  const isPaid = profile?.plan === 'paid1' || profile?.plan === 'paid2';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]); // 全プロジェクト一覧（analysis_results含む）
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [referenceId, setReferenceId] = useState(null);
  const [targetId, setTargetId] = useState(null);

  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [modelPreviewCache, setModelPreviewCache] = useState({}); // id -> model_data（解析モデル展開時・周波数応答計算時の両方で共用）
  const [previewLoadingId, setPreviewLoadingId] = useState(null);

  const [freqCache, setFreqCache] = useState({}); // id -> { freqResponse, freqMaxRpm, unbalanceCount }
  const [freqLoadingId, setFreqLoadingId] = useState(null);
  const [freqError, setFreqError] = useState(null);

  // 時系列比較表用：どのプロジェクトを「基準」にするか（危険速度・ピーク振幅・モデル設定の差分、
  // いずれもこの基準からの差を表示する）。①-2 ComparePanel.jsxの同名stateと同じ役割。
  const [tableBaselineId, setTableBaselineId] = useState(null);
  const [modelDiffLoadingIds, setModelDiffLoadingIds] = useState(() => new Set()); // モデル差分表示のため取得中のプロジェクトID

  // 部位選択（新設）：危険速度・ピーク振幅・グラフ比較で「どこを見るか」。基準列(tableBaselineId)とは
  // 独立したUIで、値は 'max'（全体の最大） / `disk-${id}` / `bearing-${id}`。
  // 選択肢一覧は基準列プロジェクトのdisks/bearingsから作るため、基準列が変わると選択肢も変わる
  // （ファイル冒頭コメント参照）。デフォルトは常に'max'。
  const [comparePointValue, setComparePointValue] = useState('max');

  // 【1-10バグ修正】ComparePanel.jsx／CampbellComparePanel.jsxと同じ対応（詳細はComparePanel.jsx参照）。
  const hasFetchedRef = useRef(false);

  const toggleExpand = async (p) => {
    const alreadyOpen = expandedIds.has(p.id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      return next;
    });
    if (alreadyOpen) return;
    const hasResults = p.analysis_results?.modes?.length > 0;
    if (!hasResults && !modelPreviewCache[p.id]) {
      setPreviewLoadingId(p.id);
      const { data, error: fetchError } = await supabase.from('projects').select('model_data').eq('id', p.id).single();
      setPreviewLoadingId(null);
      if (!fetchError && data?.model_data) {
        setModelPreviewCache(prev => ({ ...prev, [p.id]: data.model_data }));
      }
    }
  };

  // 重い同期計算の直前に1フレーム分だけ処理を返し、直前のsetState(ローディング表示)を
  // 画面に反映させてから計算を始める（App.jsx・CampbellComparePanelのtick()/yieldToPaint()と同じ狙い）。
  const yieldToPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  const computeFreqResponseForProject = async (p) => {
    let m = modelPreviewCache[p.id];
    if (!m) {
      const { data, error: fetchError } = await supabase.from('projects').select('model_data').eq('id', p.id).single();
      if (fetchError || !data?.model_data) throw new Error('モデルデータの取得に失敗しました');
      m = data.model_data;
      setModelPreviewCache(prev => ({ ...prev, [p.id]: m }));
    }
    const { shaftElems, materials, disks, bearings, settings } = m;
    if (!shaftElems || !materials || !settings) throw new Error('モデルデータの形式が不正です');
    await yieldToPaint();

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

    // モードは一覧取得時点のanalysis_results.modesをそのまま使う（ファイル冒頭コメント参照）。
    const modes = p.analysis_results?.modes || [];
    if (modes.length === 0) throw new Error('固有値解析の結果がありません');

    const unbalancesFromDisks = (disks || []).filter(d => d.hasUnbalance).map(d => ({
      position: d.position,
      mass: d.unbalanceMass || 0,
      eccentricity: d.eccentricity || 0,
      phase: d.unbalancePhase || 0,
    }));

    // 解析範囲の決め方はApp.jsx本体の③周波数応答解析と同じロジック
    // （設定maxRpmと、固有振動数の1.5倍のうち大きい方まで自動拡張する）。
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

    // 【2026-08-05追記】nodePositionsも戻り値に含める（本体③タブのresults.nodePositionsと同じやり方）。
    // ディスク/軸受の位置(m)から最寄り節点indexを求める部位選択機能で必要になるため、
    // 計算時に既に手元にあるこの値を、使い捨てずfreqCacheに保存するようにした。
    // 【2026-08-06追記】運用回転数レンジ（帯表示用）も保存時のsettingsから持ち出す。
    // ②-3（CampbellComparePanel.jsx）と同じ考え方：帯は基準プロジェクトの設定のみを使う。
    return {
      freqResponse, freqMaxRpm, unbalanceCount: unbalancesFromDisks.length, nodePositions,
      operatingMinRpm: settings.operatingMinRpm, operatingMaxRpm: settings.operatingMaxRpm,
    };
  };

  useEffect(() => {
    if (!active || hasFetchedRef.current) return;
    if (!session || !isPaid) { setLoading(false); return; }
    let cancelled = false;
    hasFetchedRef.current = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('id, name, updated_at, analysis_results')
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (fetchError) {
        setError('プロジェクトの取得に失敗しました: ' + fetchError.message);
        setLoading(false);
        hasFetchedRef.current = false; // 失敗時は再試行できるようにする
        return;
      }
      setProjects(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [active, session, isPaid]);

  const selectedProjects = useMemo(() => {
    const order = [...selectedIds];
    return projects
      .filter(p => selectedIds.has(p.id) && p.analysis_results?.modes?.length > 0)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [projects, selectedIds]);

  // 時系列比較表用：基準列(tableBaselineId)を先頭に固定し、残りは選択(チェック)した順に並べる。
  // 【2026-08-06変更】①-2と同じ変更。以前は保存日時(updated_at)の昇順だったが、
  // 「基準が右端に出て分かりにくい」という指摘を受け、基準列を左端固定に変更した。
  const timeSeriesProjects = useMemo(() => {
    const base = selectedProjects.find(p => p.id === tableBaselineId);
    const rest = selectedProjects.filter(p => p.id !== tableBaselineId);
    return base ? [base, ...rest] : selectedProjects;
  }, [selectedProjects, tableBaselineId]);
  const maxModeCount = Math.max(0, ...timeSeriesProjects.map(p => p.analysis_results?.modes?.length || 0));

  // 時系列表の基準プロジェクトが選択から外れたら、選択順で一番先頭のプロジェクトに補正する
  useEffect(() => {
    if (selectedProjects.length === 0) { setTableBaselineId(null); return; }
    if (!selectedProjects.some(p => p.id === tableBaselineId)) {
      setTableBaselineId(selectedProjects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  // 時系列表に「モデル設定の変化」を出すため、選択済みプロジェクト全件のmodel_dataを取得する。
  // 「解析モデル」ボタンの展開機能と同じmodelPreviewCacheを共用するので、既に展開済みのものは
  // 再取得しない。2件未満の時は比較のしようがないので取得しない（①-2と同じ設計）。
  useEffect(() => {
    if (timeSeriesProjects.length < 2) return;
    const toFetch = timeSeriesProjects.filter(p => !modelPreviewCache[p.id]);
    if (toFetch.length === 0) return;
    let cancelled = false;
    (async () => {
      setModelDiffLoadingIds(prev => {
        const next = new Set(prev);
        toFetch.forEach(p => next.add(p.id));
        return next;
      });
      for (const p of toFetch) {
        if (cancelled) return;
        const { data, error: fetchError } = await supabase.from('projects').select('model_data').eq('id', p.id).single();
        if (!cancelled && !fetchError && data?.model_data) {
          setModelPreviewCache(prev => ({ ...prev, [p.id]: data.model_data }));
        }
        setModelDiffLoadingIds(prev => { const next = new Set(prev); next.delete(p.id); return next; });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSeriesProjects]);

  // 基準モデル(baseline)と対象モデル(target)のmodel_dataを突き合わせ、人が読める変化点のリストにする。
  // ①-2 ComparePanel.jsxのdiffModelData関数をそのまま移植（周波数応答特有の差分は無いため変更不要）。
  function diffModelData(baseline, target) {
    if (!baseline || !target) return null;
    const changes = [];

    const settingsLabels = { minRpm: '最小回転数', maxRpm: '最大回転数', nModes: 'モード数', alphaRayleigh: 'レイリー減衰α', betaRayleigh: 'レイリー減衰β' };
    Object.entries(settingsLabels).forEach(([k, label]) => {
      const a = baseline.settings?.[k], b = target.settings?.[k];
      if (a != null && b != null && a !== b) changes.push(`${label}: ${a} → ${b}`);
    });

    const lenA = (baseline.shaftElems || []).reduce((s, e) => s + (e.length || 0), 0);
    const lenB = (target.shaftElems || []).reduce((s, e) => s + (e.length || 0), 0);
    if (Math.abs(lenA - lenB) > 1e-6) changes.push(`シャフト全長: ${lenA.toFixed(3)} → ${lenB.toFixed(3)} m`);
    const nElA = (baseline.shaftElems || []).length, nElB = (target.shaftElems || []).length;
    if (nElA !== nElB) changes.push(`シャフト要素数: ${nElA} → ${nElB}`);

    const diffItems = (itemsA, itemsB, kind, fields) => {
      itemsA.forEach(a => {
        const b = itemsB.find(x => x.id === a.id);
        const label = a.name || `${kind}#${a.id}`;
        if (!b) { changes.push(`${label}（${kind}）が削除された`); return; }
        fields.forEach(({ key, unit, fmt }) => {
          const av = a[key], bv = b[key];
          if (av != null && bv != null && av !== bv) {
            const f = fmt || (v => v);
            changes.push(`${label} ${key}: ${f(av)}${unit || ''} → ${f(bv)}${unit || ''}`);
          }
        });
      });
      const idsA = new Set(itemsA.map(x => x.id));
      itemsB.forEach(b => {
        if (!idsA.has(b.id)) changes.push(`${b.name || `${kind}#${b.id}`}（${kind}）が追加された`);
      });
    };

    diffItems(baseline.disks || [], target.disks || [], 'ディスク', [
      { key: 'position', unit: ' m' },
      { key: 'mass', unit: ' kg' },
    ]);
    diffItems(baseline.bearings || [], target.bearings || [], '軸受', [
      { key: 'position', unit: ' m' },
      { key: 'kxx', unit: ' N/m', fmt: v => v.toExponential(2) },
    ]);
    diffItems(baseline.materials || [], target.materials || [], '材料', [
      { key: 'youngMod', unit: ' GPa' },
      { key: 'density', unit: ' kg/m³' },
    ]);

    return changes;
  }

  const referenceProject = selectedProjects.find(p => p.id === referenceId) || null;
  const targetProject = selectedProjects.find(p => p.id === targetId) || selectedProjects[0] || null;

  useEffect(() => {
    if (selectedProjects.length === 0) { setReferenceId(null); return; }
    if (!selectedProjects.some(p => p.id === referenceId)) {
      setReferenceId(selectedProjects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  useEffect(() => {
    if (selectedProjects.length === 0) { setTargetId(null); return; }
    if (!selectedProjects.some(p => p.id === targetId)) {
      const fallback = selectedProjects.find(p => p.id !== referenceId) || selectedProjects[0];
      setTargetId(fallback.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  // 選択済みプロジェクト（timeSeriesProjects）が変わるたびに、未計算ぶんだけ周波数応答を計算する。
  // 【2026-08-05変更】以前は「基準・比較対象の2件」だけを対象にしていたが、時系列比較表
  // （選択した全件の危険速度・ピーク振幅を並べる）のために、選択した全プロジェクトを対象に拡張した。
  // 1件ずつ順番に計算する既存ロジック・yieldToPaintはそのまま維持している。
  useEffect(() => {
    const toCompute = timeSeriesProjects.filter(p => !freqCache[p.id]);
    if (toCompute.length === 0) return;
    let cancelled = false;
    (async () => {
      setFreqError(null);
      for (const p of toCompute) {
        if (cancelled) return;
        setFreqLoadingId(p.id);
        try {
          const result = await computeFreqResponseForProject(p);
          if (!cancelled) setFreqCache(prev => ({ ...prev, [p.id]: result }));
        } catch (e) {
          if (!cancelled) setFreqError(`${p.name}: ${e.message || '周波数応答の計算に失敗しました'}`);
        }
      }
      if (!cancelled) setFreqLoadingId(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSeriesProjects]);

  const refFreq = referenceProject ? freqCache[referenceProject.id] : null;
  const tgtFreq = targetProject ? freqCache[targetProject.id] : null;

  // 【1-10バグ修正・重要】部位選択の選択肢一覧：基準列(tableBaselineId)に選ばれているプロジェクトの
  // disks/bearingsから作る。model_dataがまだ取得できていない（modelPreviewCache未取得）間は
  // 「全体の最大」のみになる。
  // ★このuseMemo・useEffectは、以前は下の「!session」早期returnより後ろに置かれていた。
  // 単体タブとして開いた時だけマウントされていた頃は、マウント時点でsessionが確定していることが
  // 多く問題が表面化しなかったが、1-10でこのパネルを常時マウントする方式に変えたところ、
  // アプリ起動直後（session=null）→非同期でログイン状態が確定→再レンダー、という過程で
  // 「早期returnを通過するかどうか」が変わり、Hooksの呼び出し数がレンダーごとに変わってしまう
  // (React error #310 "Rendered more hooks than during the previous render")というクラッシュを
  // 引き起こしていた。Hooksは条件分岐やearly returnより前で無条件に呼ぶ、というReactのルールに
  // 従い、他のHooksと同じ場所（early returnより前）に移動して解消した。
  const baselineModelForPoints = modelPreviewCache[tableBaselineId];
  const comparePointOptions = useMemo(() => {
    const base = [{ value: 'max', shortLabel: '全体の最大', label: '全体の最大（各回転数で一番大きい点）' }];
    if (!baselineModelForPoints) return base;
    const disksOpt = (baselineModelForPoints.disks || []).map((d, i) => ({
      value: `disk-${d.id}`,
      shortLabel: d.name || `ディスク#${i + 1}`,
      tag: 'ディスク',
      posMm: d.position * 1000,
      position: d.position,
      label: `ディスク: ${d.name || `#${i + 1}`}`,
    }));
    const bearingsOpt = (baselineModelForPoints.bearings || []).map((b, i) => ({
      value: `bearing-${b.id}`,
      shortLabel: b.name || `軸受#${i + 1}`,
      tag: '軸受',
      posMm: b.position * 1000,
      position: b.position,
      label: `軸受: ${b.name || `#${i + 1}`}`,
    }));
    return [...base, ...disksOpt, ...bearingsOpt];
  }, [baselineModelForPoints]);

  // 基準列が切り替わって選択中のcomparePointValueが選択肢に無くなった場合は「全体の最大」に戻す
  useEffect(() => {
    if (!comparePointOptions.some(o => o.value === comparePointValue)) {
      setComparePointValue('max');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparePointOptions]);

  // ─── 未ログイン／Free：アップグレード誘導（ComparePanel・CampbellComparePanelの同種の分岐と揃えたトーン） ───
  if (!session) {
    return (
      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, padding: '40px 0', textAlign: 'center' }}>
        周波数応答比較を使うには、まずログインしてください。
      </div>
    );
  }
  if (!isPaid) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, marginBottom: 14 }}>
          周波数応答比較はProプランの機能です。保存済みのプロジェクト同士でボード線図（振幅・位相）を重ねて確認できます。
        </div>
        <button onClick={onUpgradeClick} style={{
          padding: '10px 20px', fontSize: 13, fontWeight: 600,
          background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
        }}>
          Proにアップグレード
        </button>
      </div>
    );
  }

  // 回転数ごとの振幅・位相の系列を返す。comparePointValueが'max'なら「全体の最大」（各回転数で
  // シャフト全節点のうち最も振幅が大きい点）、部位が選ばれていればその部位の最寄り節点を使う。
  // 【2026-08-05変更】以前は常に「全体の最大」固定だったが、部位選択（時系列表向けに新設）を
  // グラフ比較（ボード線図重ね描き）にも反映するよう拡張した。project引数は部位のposition(m)を
  // modelPreviewCacheから引くために必要（freqのみでは対象プロジェクトが分からないため）。
  const seriesForProject = (freq, project) => {
    if (!freq || !Array.isArray(freq.freqResponse)) return { series: [], missing: false };

    if (comparePointValue === 'max') {
      const series = freq.freqResponse.map(r => {
        let bestIdx = 0, bestAmp = -1;
        (r.nodeAmp || []).forEach((a, i) => { if (a > bestAmp) { bestAmp = a; bestIdx = i; } });
        return { rpm: r.rpm, amplitude: r.nodeAmp?.[bestIdx] ?? 0, phase: r.nodePhase?.[bestIdx] ?? 0 };
      });
      return { series, missing: false };
    }

    const [kind, id] = comparePointValue.split(/-(.+)/); // 'disk-abc123' -> ['disk', 'abc123']
    const model = project ? modelPreviewCache[project.id] : null;
    if (!model) return { series: [], missing: false }; // model_data取得中

    const list = kind === 'disk' ? (model.disks || []) : (model.bearings || []);
    const item = list.find(x => String(x.id) === id);
    if (!item) return { series: [], missing: true }; // 該当部位が無い

    const nodePositions = freq.nodePositions || [];
    const nodeIdx = findNearestNodeIdxIn(nodePositions, item.position);
    const series = freq.freqResponse.map(r => ({
      rpm: r.rpm,
      amplitude: r.nodeAmp?.[nodeIdx] ?? 0,
      phase: r.nodePhase?.[nodeIdx] ?? 0,
    }));
    return { series, missing: false };
  };

  // 「全体の最大」振幅・位相を回転数ごとに求める（時系列表の危険速度・ピーク振幅で使用）。
  const maxSeries = (freq) => {
    if (!freq || !Array.isArray(freq.freqResponse)) return [];
    return freq.freqResponse.map(r => {
      let bestIdx = 0, bestAmp = -1;
      (r.nodeAmp || []).forEach((a, i) => { if (a > bestAmp) { bestAmp = a; bestIdx = i; } });
      return { rpm: r.rpm, amplitude: r.nodeAmp?.[bestIdx] ?? 0, phase: r.nodePhase?.[bestIdx] ?? 0 };
    });
  };

  // 「全体の最大」振幅が最も大きくなるrpm（＝危険速度）とその振幅を返す。
  const criticalPoint = (freq) => {
    const series = maxSeries(freq);
    let maxAmp = 0, critRpm = null;
    series.forEach(d => { if (d.amplitude > maxAmp) { maxAmp = d.amplitude; critRpm = d.rpm; } });
    return { maxAmp, critRpm };
  };

  // ─── 部位選択（新設・時系列表とグラフ比較の両方で使う） ───

  // 位置(x)に一番近い節点indexを返す（本体③タブのfindNearestNodeIdxと同じロジック）。
  const findNearestNodeIdxIn = (nodePositions, x) => {
    let best = 0, bd = Infinity;
    (nodePositions || []).forEach((xn, i) => { const d = Math.abs(xn - x); if (d < bd) { best = i; bd = d; } });
    return best;
  };

  // 指定プロジェクトについて、選んだ部位(comparePointValue)における危険速度・ピーク振幅を返す。
  // 【該当なしの扱い】選んだ部位（ディスク/軸受のid）が対象プロジェクトのdisks/bearingsに
  // 存在しない場合は { maxAmp: null, critRpm: null, missing: true } を返し、呼び出し側で
  // 「—」「該当部位なし」表示にする（プロダクト方針メモの確認事項3の合意通り）。
  // seriesForProjectと同じ部位解決ロジックを使い、系列から危険速度・最大振幅を求める形に統一した。
  const criticalPointForProject = (p) => {
    const cache = freqCache[p.id];
    if (!cache) return { maxAmp: null, critRpm: null, missing: false };

    const { series, missing } = seriesForProject(cache, p);
    if (missing) return { maxAmp: null, critRpm: null, missing: true };
    if (comparePointValue !== 'max' && series.length === 0) return { maxAmp: null, critRpm: null, missing: false }; // model_data取得中

    let maxAmp = 0, critRpm = null;
    series.forEach(d => { if (d.amplitude > maxAmp) { maxAmp = d.amplitude; critRpm = d.rpm; } });
    return { maxAmp, critRpm, missing: false };
  };

  // グラフ比較（ボード線図重ね描き）：以前は常に「全体の最大」だったが、部位選択(comparePointValue)を
  // 反映するよう変更。選んだ部位が該当プロジェクトに無い場合はseriesが空になり、グラフ上は
  // その系列が描かれない（凡例側で分かるよう後述のmissing表示を追加）。
  const refResult = seriesForProject(refFreq, referenceProject);
  const tgtResult = seriesForProject(tgtFreq, targetProject);
  const refSeries = refResult.series;
  const tgtSeries = tgtResult.series;
  const ampLines = [
    referenceProject && { data: refSeries, color: COLORS.accent, label: referenceProject.name },
    targetProject && { data: tgtSeries, color: COLORS.danger, label: targetProject.name },
  ].filter(Boolean);
  const phaseLines = ampLines; // 同じ系列構成（色・ラベル）をそのまま流用、yKeyだけ切り替える

  const refCriticalRaw = refSeries.reduce((best, d) => (d.amplitude > (best?.amplitude ?? -1) ? d : best), null);
  const tgtCriticalRaw = tgtSeries.reduce((best, d) => (d.amplitude > (best?.amplitude ?? -1) ? d : best), null);
  const refMaxAmp = refCriticalRaw?.amplitude ?? 0;
  const refCritRpm = refCriticalRaw?.rpm ?? null;
  const tgtMaxAmp = tgtCriticalRaw?.amplitude ?? 0;
  const tgtCritRpm = tgtCriticalRaw?.rpm ?? null;

  // 固有振動数の縦線（両プロジェクト分。①-2/②-3同様に基準=accent・比較対象=dangerで色分け）。
  // analysis_results.modesは一覧取得時に既に持っているため、追加の取得コストはかからない。
  // 【2026-08-05】以前はlabelに`${プロジェクト名} M${i+1}`を入れていたが、自動生成名（タイムスタンプ
  // 入り）だとモードの数だけ長いラベルが縦線上に繰り返し表示され、グラフが読みづらくなっていた
  // （ユーザー指摘）。色で系列は区別できるため、ラベルは付けず縦線のみにした。
  const eigenVLines = [
    ...(referenceProject?.analysis_results?.modes || []).map(r => ({
      x: r.freq * 60, color: COLORS.accent,
    })),
    ...(targetProject?.analysis_results?.modes || []).map(r => ({
      x: r.freq * 60, color: COLORS.danger,
    })),
  ];

  const freqMaxRpm = Math.max(refFreq?.freqMaxRpm || 0, tgtFreq?.freqMaxRpm || 0) || undefined;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 16px', lineHeight: 1.6 }}>
        比較用に保存しているデータには周波数応答の生データを含まないため、選択したプロジェクトのモデル構成から
        その場で再計算します（計算に少し時間がかかることがあります）。①-2・②-3とは選択が独立しています。
        比較指標は「全体の最大（各回転数でシャフト全節点のうち最も振幅が大きい点）」に固定しています。
      </div>

      {/* プロジェクト選択 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 8 }}>
          比較したいプロジェクトを2つ以上選択してください（{selectedProjects.length}件選択中・解析結果があるものだけ選択できます）
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>読み込み中...</div>
        ) : error ? (
          <div style={{ fontSize: 12, color: COLORS.danger, padding: '20px 0' }}>{error}</div>
        ) : projects.length === 0 ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>
            まだ保存されたプロジェクトはありません。左パネルの「☁ クラウドプロジェクト」からモデルを保存してください。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflow: 'auto', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 8 }}>
            {projects.map(p => {
              const hasResults = p.analysis_results?.modes?.length > 0;
              const checked = selectedIds.has(p.id);
              const isExpanded = expandedIds.has(p.id);
              const toggleSelect = () => {
                if (!hasResults) return;
                setSelectedIds(prev => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                  return next;
                });
              };
              return (
                <div key={p.id} style={{
                  background: COLORS.surface2, borderRadius: 6, padding: '8px 10px',
                  border: `1px solid ${checked ? COLORS.accent : 'transparent'}`,
                  opacity: hasResults ? 1 : 0.55,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!hasResults}
                      title={hasResults ? '比較対象として選択' : '解析結果が無いため比較できません（このプロジェクトを解析後、上書き保存してください）'}
                      onChange={toggleSelect}
                      style={{
                        flexShrink: 0, flexGrow: 0, flexBasis: 'auto',
                        width: 16, height: 16, minWidth: 16,
                        cursor: hasResults ? 'pointer' : 'not-allowed',
                      }}
                    />
                    <span
                      onClick={toggleSelect}
                      title={hasResults ? '比較対象として選択' : undefined}
                      style={{
                        fontSize: 12, color: COLORS.textBright, flex: '1 1 100px', minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        cursor: hasResults ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {p.name}
                    </span>
                    {hasResults ? (
                      <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: COLORS.success + '22', color: COLORS.success, fontFamily: 'JetBrains Mono', flexShrink: 0, whiteSpace: 'nowrap' }}>
                        解析済 {p.analysis_results.modes.length}modes
                      </span>
                    ) : (
                      <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: COLORS.border, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', flexShrink: 0, whiteSpace: 'nowrap' }}>
                        未解析
                      </span>
                    )}
                    <button
                      onClick={() => toggleExpand(p)}
                      title="解析モデルの概要を表示"
                      style={{
                        fontSize: 10, padding: '4px 9px', whiteSpace: 'nowrap',
                        background: isExpanded ? COLORS.accent + '22' : 'transparent',
                        color: isExpanded ? COLORS.accent : COLORS.textMuted,
                        border: `1px solid ${isExpanded ? COLORS.accent + '88' : COLORS.border}`,
                        borderRadius: 4, cursor: 'pointer', flexShrink: 0,
                      }}
                    >解析モデル {isExpanded ? '▾' : '▸'}</button>
                  </div>

                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 4 }}>
                    {new Date(p.updated_at).toLocaleDateString('ja-JP')}
                  </div>

                  {isExpanded && (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: COLORS.surface, borderRadius: 4, fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', lineHeight: 1.8 }}>
                      {hasResults ? (() => {
                        const ar = p.analysis_results;
                        const freqs = (ar.modes || []).map(m => m.freq);
                        const shaftLen = ar.nodePositions?.[ar.nodePositions.length - 1];
                        return (
                          <>
                            <div>シャフト全長: {shaftLen != null ? `${shaftLen.toFixed(3)} m` : '—'}{ar.nodePositions ? `（節点数 ${ar.nodePositions.length}）` : ''}</div>
                            <div>ディスク数: {ar.diskPos?.length ?? '—'} ／ 軸受数: {ar.bearingPos?.length ?? '—'}</div>
                            <div>固有振動数: {freqs.length ? `${Math.min(...freqs).toFixed(1)} 〜 ${Math.max(...freqs).toFixed(1)} Hz（${freqs.length}モード）` : '—'}</div>
                            {ar.savedAt && <div>解析保存日時: {new Date(ar.savedAt).toLocaleString('ja-JP')}</div>}
                          </>
                        );
                      })() : previewLoadingId === p.id ? (
                        <div>読み込み中...</div>
                      ) : modelPreviewCache[p.id] ? (() => {
                        const m = modelPreviewCache[p.id];
                        const len = (m.shaftElems || []).reduce((s, e) => s + (e.length || 0), 0);
                        return (
                          <>
                            <div>シャフト全長: {len.toFixed(3)} m（{(m.shaftElems || []).length}要素）</div>
                            <div>ディスク数: {(m.disks || []).length} ／ 軸受数: {(m.bearings || []).length}</div>
                            <div>最大回転数: {m.settings?.maxRpm ?? '—'} rpm</div>
                            <div style={{ color: COLORS.warning }}>※未解析のため固有振動数は不明です（比較対象にも選択できません）</div>
                          </>
                        );
                      })() : (
                        <div>概要を取得できませんでした</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 周波数応答の時系列比較表（新設）。①-2 ComparePanel.jsxの時系列比較表と同じ設計思想を踏襲。
          選択した全プロジェクトを保存日時順に並べ、以下を一覧できる：
            - 固有振動数（Hz）：モード番号ごとの複数行。analysis_results.modesベース（①-2と同じ粒度）。
            - 危険速度（rpm）・ピーク振幅：それぞれ1行のみ。「全体の最大」または部位選択（下記）に
              応じた値で、プロジェクト単位の1つの値になる（①-2との行の粒度の違いはここに起因する）。
          下の「基準/比較対象」2件比較（ボード線図重ね描き）とは独立した俯瞰用の表で、選択状態は共有する。
          列ヘッダーをクリックすると、そのプロジェクトを「基準」にできる（①-2と同じ操作感）。
          【2026-08-05追記】部位選択（comparePointValue）を新設。基準列とは独立したUIで、選択肢一覧は
          基準列プロジェクトのdisks/bearingsから作る。選んだ部位が無いプロジェクトは「該当部位なし」表示。
          下のグラフ比較（ボード線図）にも同じ部位選択が反映される。 */}
      {selectedProjects.length >= 2 && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
            周波数応答の時系列比較
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            選択した{timeSeriesProjects.length}件を保存日時順（古い→新しい）に並べています。列ヘッダーをクリックすると、その列を基準（Δの比較元）にできます。
            固有振動数はモード番号（出現順）ベースの単純な比較のため、設計変更でモードの順序が入れ替わっている場合は対応がずれることがあります。
          </div>

          {/* 部位選択（新設）：危険速度・ピーク振幅で「どこを見るか」。選択肢一覧は基準列プロジェクトの
              disks/bearingsから作るため、基準列を切り替えると選択肢も連動して切り替わる。 */}
          <div style={{ marginBottom: 14, padding: '10px 12px', background: COLORS.surface2, borderRadius: 6, border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 8 }}>
              危険速度・ピーク振幅で見る部位を選択（選択肢は基準列「{timeSeriesProjects.find(p => p.id === tableBaselineId)?.name || '—'}」のモデル構成から作成）:
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {comparePointOptions.map(opt => {
                const checked = opt.value === comparePointValue;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setComparePointValue(opt.value)}
                    title={opt.label}
                    style={{
                      padding: '5px 10px', fontSize: 9, fontFamily: 'JetBrains Mono',
                      borderRadius: 5, cursor: 'pointer',
                      background: checked ? COLORS.accent + '22' : 'transparent',
                      color: checked ? COLORS.accent : COLORS.textMuted,
                      border: `1px solid ${checked ? COLORS.accent + '88' : COLORS.border}`,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, minWidth: 64,
                    }}>
                    <span>{opt.shortLabel}</span>
                    {opt.posMm !== undefined && (
                      <span style={{ fontSize: 8, opacity: 0.8 }}>{opt.posMm.toFixed(0)}mm</span>
                    )}
                    {opt.tag && (
                      <span style={{ fontSize: 8, color: opt.tag === '軸受' ? COLORS.warning : COLORS.purple }}>
                        {opt.tag}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 8, lineHeight: 1.5 }}>
              「全体の最大」は各回転数においてシャフト全節点のうち最も振幅が大きい点の値です。部位を選んだ場合、選択肢に対応する部位が無いプロジェクトは「該当部位なし」と表示されます。
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `92px repeat(${timeSeriesProjects.length}, minmax(150px, 1fr))`,
              gap: 6, minWidth: 92 + timeSeriesProjects.length * 150,
            }}>

              <div />
              {timeSeriesProjects.map(p => {
                const isBaseline = p.id === tableBaselineId;
                return (
                  <div
                    key={p.id}
                    onClick={() => setTableBaselineId(p.id)}
                    title="クリックでこの列を基準にする"
                    style={{
                      textAlign: 'center', cursor: 'pointer', padding: '2px 4px', borderRadius: 4,
                      background: isBaseline ? COLORS.accent + '18' : 'transparent',
                      border: `1px solid ${isBaseline ? COLORS.accent + '66' : 'transparent'}`,
                    }}
                  >
                    <div
                      title={p.name}
                      style={{
                        fontSize: 11, color: isBaseline ? COLORS.accent : COLORS.textBright, fontWeight: 700,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {p.name}
                    </div>
                    <div style={{ fontSize: 9, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                      {new Date(p.updated_at).toLocaleString('ja-JP', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {isBaseline && (
                      <div style={{ fontSize: 8, color: COLORS.accent, marginTop: 1 }}>基準</div>
                    )}
                  </div>
                );
              })}

              {/* 固有振動数（モード別・複数行）：①-2と同じくanalysis_results.modesベース */}
              {Array.from({ length: maxModeCount }, (_, m) => [
                <div key={`label-${m}`} style={{
                  fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono',
                  display: 'flex', alignItems: 'center',
                }}>
                  M{m + 1}
                </div>,
                ...timeSeriesProjects.map(p => {
                  const isBaseline = p.id === tableBaselineId;
                  const freq = p.analysis_results?.modes?.[m]?.freq;
                  const baseFreq = timeSeriesProjects.find(x => x.id === tableBaselineId)?.analysis_results?.modes?.[m]?.freq;
                  const delta = (!isBaseline && freq != null && baseFreq != null) ? freq - baseFreq : null;
                  const deltaPct = (delta != null && baseFreq) ? (delta / baseFreq * 100) : null;
                  return (
                    <div key={`${p.id}-${m}`} style={{
                      background: isBaseline ? COLORS.accent + '0F' : COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center',
                    }}>
                      <div style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.textBright }}>
                        {freq != null ? `${freq.toFixed(1)} Hz` : '—'}
                      </div>
                      {isBaseline ? (
                        <div style={{ fontSize: 9, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginTop: 2 }}>基準</div>
                      ) : delta != null && (
                        <div style={{ fontSize: 9, color: deltaColor(delta, 'up'), fontFamily: 'JetBrains Mono', marginTop: 2 }}>
                          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}Hz ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                        </div>
                      )}
                    </div>
                  );
                }),
              ]).flat()}

              {/* 危険速度（rpm）：1行のみ。部位選択(comparePointValue)に応じた回転数（プロジェクト単位の
                  値のためモード別には分解していない。①-2との行の粒度の違いはここに起因する）。
                  freqCacheがまだ無い列は「計算中...」、選んだ部位が対象プロジェクトに無い列は
                  「該当部位なし」と表示する。 */}
              <div style={{
                fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono',
                display: 'flex', alignItems: 'center',
              }}>
                危険速度
              </div>
              {timeSeriesProjects.map(p => {
                const isBaseline = p.id === tableBaselineId;
                const cache = freqCache[p.id];
                if (!cache) {
                  return (
                    <div key={`crit-${p.id}`} style={{ background: COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                      <div style={{ fontSize: 10, color: COLORS.textMuted }}>
                        {freqLoadingId === p.id ? '計算中...' : '—'}
                      </div>
                    </div>
                  );
                }
                const { critRpm, missing } = criticalPointForProject(p);
                if (missing) {
                  return (
                    <div key={`crit-${p.id}`} style={{ background: COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                      <div style={{ fontSize: 9, color: COLORS.warning }}>該当部位なし</div>
                    </div>
                  );
                }
                const baseResult = criticalPointForProject(timeSeriesProjects.find(x => x.id === tableBaselineId) || {});
                const baseCritRpm = baseResult.missing ? null : baseResult.critRpm;
                const delta = (!isBaseline && critRpm != null && baseCritRpm != null) ? critRpm - baseCritRpm : null;
                const deltaPct = (delta != null && baseCritRpm) ? (delta / baseCritRpm * 100) : null;
                return (
                  <div key={`crit-${p.id}`} style={{
                    background: isBaseline ? COLORS.accent + '0F' : COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center',
                  }}>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.textBright }}>
                      {critRpm != null ? `${Math.round(critRpm)} rpm` : '—'}
                    </div>
                    {isBaseline ? (
                      <div style={{ fontSize: 9, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginTop: 2 }}>基準</div>
                    ) : delta != null && (
                      <div style={{ fontSize: 9, color: deltaColor(delta, 'up'), fontFamily: 'JetBrains Mono', marginTop: 2 }}>
                        {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta))}rpm ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ピーク振幅：1行のみ。危険速度と同じcriticalPointForProjectからmaxAmpを取り出す。 */}
              <div style={{
                fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono',
                display: 'flex', alignItems: 'center',
              }}>
                ピーク振幅
              </div>
              {timeSeriesProjects.map(p => {
                const isBaseline = p.id === tableBaselineId;
                const cache = freqCache[p.id];
                if (!cache) {
                  return (
                    <div key={`amp-${p.id}`} style={{ background: COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                      <div style={{ fontSize: 10, color: COLORS.textMuted }}>
                        {freqLoadingId === p.id ? '計算中...' : '—'}
                      </div>
                    </div>
                  );
                }
                const { maxAmp, missing } = criticalPointForProject(p);
                if (missing) {
                  return (
                    <div key={`amp-${p.id}`} style={{ background: COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center' }}>
                      <div style={{ fontSize: 9, color: COLORS.warning }}>該当部位なし</div>
                    </div>
                  );
                }
                const baseResult = criticalPointForProject(timeSeriesProjects.find(x => x.id === tableBaselineId) || {});
                const baseMaxAmp = baseResult.missing ? null : baseResult.maxAmp;
                const delta = (!isBaseline && maxAmp != null && baseMaxAmp != null) ? maxAmp - baseMaxAmp : null;
                const deltaPct = (delta != null && baseMaxAmp) ? (delta / baseMaxAmp * 100) : null;
                return (
                  <div key={`amp-${p.id}`} style={{
                    background: isBaseline ? COLORS.accent + '0F' : COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center',
                  }}>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.textBright }}>
                      {maxAmp != null ? `${maxAmp.toExponential(3)} mm` : '—'}
                    </div>
                    {isBaseline ? (
                      <div style={{ fontSize: 9, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginTop: 2 }}>基準</div>
                    ) : delta != null && (
                      <div style={{ fontSize: 9, color: deltaColor(delta, 'down'), fontFamily: 'JetBrains Mono', marginTop: 2 }}>
                        {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toExponential(2)}mm ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 「変化」行：モデル設定側の差分（インプットの変化）。①-2と同じくモード・指標行群の
                  すぐ下に、同じグリッドの1行として統合している。 */}
              <div style={{
                fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono',
                display: 'flex', alignItems: 'flex-start', paddingTop: 6,
              }}>
                変化
              </div>
              {timeSeriesProjects.map(p => {
                const isBaseline = p.id === tableBaselineId;
                if (isBaseline) {
                  return (
                    <div key={`diff-${p.id}`} style={{
                      background: COLORS.accent + '0F', borderRadius: 4, padding: '6px 8px',
                      fontSize: 9, color: COLORS.accent, textAlign: 'center',
                    }}>
                      基準
                    </div>
                  );
                }
                const baselineProject = timeSeriesProjects.find(x => x.id === tableBaselineId);
                const baselineModel = baselineProject ? modelPreviewCache[baselineProject.id] : null;
                const targetModel = modelPreviewCache[p.id];
                if (!baselineModel || !targetModel) {
                  const stillLoading = modelDiffLoadingIds.has(p.id) || (baselineProject && modelDiffLoadingIds.has(baselineProject.id));
                  return (
                    <div key={`diff-${p.id}`} style={{
                      background: COLORS.surface2, borderRadius: 4, padding: '6px 8px',
                      fontSize: 9, color: COLORS.textMuted, textAlign: 'center',
                    }}>
                      {stillLoading ? '取得中...' : '取得できませんでした'}
                    </div>
                  );
                }
                const changes = diffModelData(baselineModel, targetModel);
                return (
                  <div key={`diff-${p.id}`} style={{ background: COLORS.surface2, borderRadius: 4, padding: '6px 8px' }}>
                    {changes && changes.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: 14, fontSize: 9, color: COLORS.textMuted, lineHeight: 1.7, fontFamily: 'JetBrains Mono', textAlign: 'left' }}>
                        {changes.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    ) : (
                      <div style={{ fontSize: 9, color: COLORS.textMuted, textAlign: 'center' }}>変更なし</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedProjects.length < 2 ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
          上の一覧から、解析結果を持つプロジェクトを2つ以上選択してください。
        </div>
      ) : !targetProject ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>比較対象プロジェクトがありません。</div>
      ) : (
        <>
          {/* グラフ比較（2種）：ここから先は選択済みプロジェクトの中から2件（基準／比較対象）を選び、
              ボード線図を詳しく重ね描きする。上の時系列表（全件の俯瞰）とは別のセクションであることが
              分かるよう見出しを付けている（①-2と同じパターン）。 */}
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
            グラフ比較（2種）
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            上の時系列表は選択した全件の俯瞰です。ここでは2件（基準／比較対象）を選んで、ボード線図（振幅・位相）を詳しく比較します。
          </div>

          {/* 基準・比較対象の選択（選択済みプロジェクトの中から。同じプロジェクトを両方に選ぶことも可能） */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedProjects.map(p => (
                  <button key={p.id} onClick={() => setReferenceId(p.id)} style={tabStyle(p.id === referenceId, COLORS.accent)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedProjects.map(p => (
                  <button key={p.id} onClick={() => setTargetId(p.id)} style={tabStyle(p.id === targetId, COLORS.danger)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 周波数応答 重ね描き（ボード線図） */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              周波数応答 重ね描き（{comparePointOptions.find(o => o.value === comparePointValue)?.shortLabel || '全体の最大'}）
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              accent＝{referenceProject?.name || '基準'}、danger＝{targetProject?.name || '比較対象'}。
              破線の縦線は各プロジェクトの固有振動数（同色）です。表示する部位は上の時系列表の「部位選択」で切り替えられます。
            </div>

            {(refResult.missing || tgtResult.missing) && (
              <div style={{ fontSize: 10, color: COLORS.warning, marginBottom: 12, lineHeight: 1.6 }}>
                {refResult.missing && `※ ${referenceProject?.name} には選択中の部位がありません。`}
                {refResult.missing && tgtResult.missing && <br />}
                {tgtResult.missing && `※ ${targetProject?.name} には選択中の部位がありません。`}
              </div>
            )}

            {freqError ? (
              <div style={{ fontSize: 11, color: COLORS.danger, padding: '12px 0' }}>{freqError}</div>
            ) : freqLoadingId ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>
                周波数応答を計算中...（{projects.find(p => p.id === freqLoadingId)?.name || '...'}）
              </div>
            ) : refFreq && tgtFreq ? (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                  <MiniStat label={`最大振幅（${referenceProject.name}）`} value={refMaxAmp.toExponential(3)} unit="mm" color={COLORS.accent} />
                  <MiniStat label={`危険速度（${referenceProject.name}）`} value={refCritRpm != null ? Math.round(refCritRpm) : '—'} unit="rpm" color={COLORS.accent} />
                  <MiniStat label={`最大振幅（${targetProject.name}）`} value={tgtMaxAmp.toExponential(3)} unit="mm" color={COLORS.danger} />
                  <MiniStat label={`危険速度（${targetProject.name}）`} value={tgtCritRpm != null ? Math.round(tgtCritRpm) : '—'} unit="rpm" color={COLORS.danger} />
                </div>
                {(refFreq.unbalanceCount === 0 || tgtFreq.unbalanceCount === 0) && (
                  <div style={{ fontSize: 10, color: COLORS.warning, marginBottom: 12, lineHeight: 1.6 }}>
                    {refFreq.unbalanceCount === 0 && `※ ${referenceProject.name} にはアンバランス設定が無いため、振幅は常に0として表示されます。`}
                    {refFreq.unbalanceCount === 0 && tgtFreq.unbalanceCount === 0 && <br />}
                    {tgtFreq.unbalanceCount === 0 && `※ ${targetProject.name} にはアンバランス設定が無いため、振幅は常に0として表示されます。`}
                  </div>
                )}
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
                  背景の運用回転数レンジ帯は、基準（{referenceProject.name}）の解析設定を使用しています。
                </div>

                <LineChart
                  data={refSeries}
                  lines={ampLines}
                  xKey="rpm" yKey="amplitude"
                  title="ボード線図 — 振幅"
                  xLabel="回転数 [rpm]" yLabel="振幅 [mm]"
                  vLines={eigenVLines}
                  operatingMinRpm={refFreq.operatingMinRpm}
                  operatingMaxRpm={refFreq.operatingMaxRpm}
                  width={900} height={280}
                />
                <div style={{ height: 16 }} />
                <LineChart
                  data={refSeries}
                  lines={phaseLines}
                  xKey="rpm" yKey="phase"
                  title="ボード線図 — 位相"
                  xLabel="回転数 [rpm]" yLabel="位相 [deg]"
                  vLines={eigenVLines}
                  yMin={-180} yMax={180}
                  operatingMinRpm={refFreq.operatingMinRpm}
                  operatingMaxRpm={refFreq.operatingMaxRpm}
                  width={900} height={220}
                />

                <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 12, fontFamily: 'JetBrains Mono' }}>
                  解析範囲: 0 – {freqMaxRpm ? Math.round(freqMaxRpm) : '—'} rpm（各プロジェクトの設定maxRpmと固有振動数×1.5のうち大きい方まで自動拡張）
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>準備中...</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function tabStyle(active, color) {
  return {
    fontSize: 11, padding: '6px 12px', borderRadius: 6, fontWeight: active ? 700 : 400,
    background: active ? color : COLORS.surface2,
    color: active ? '#fff' : COLORS.text,
    border: `1px solid ${active ? color : COLORS.border}`,
    cursor: 'pointer',
  };
}

// App.jsxのStatCardはApp.jsx内に閉じたローカル関数でimportできないため、
// このパネル用に軽量な版を用意する（CampbellComparePanelがバッジ的な表示で済ませているのに揃え、
// 見た目はStatCardより一回り小さいコンパクト版にしている）。
function MiniStat({ label, value, unit, color }) {
  return (
    <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 12px', minWidth: 140 }}>
      <div style={{ fontSize: 9, color: COLORS.textMuted, marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono', fontSize: 14, fontWeight: 700, color: color || COLORS.accent }}>
        {value} <span style={{ fontSize: 10, fontWeight: 400, color: COLORS.textMuted }}>{unit}</span>
      </div>
    </div>
  );
}
