import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { assembleSystem, matAdd } from "../analysis/femCore.js";
import { solveFrequencyResponse } from "../analysis/frequencyResponse.js";
import { COLORS } from "./charts/chartTheme.js";
import { LineChart } from "./charts/LineChart.jsx";

// App.jsx／ComparePanel.jsx／CampbellComparePanel.jsx側と同じSupabaseクライアント設定を再利用する。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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
 * 【比較点を「全体の最大」に固定している理由】①周波数応答タブ本体はディスク／軸受ごとの応答点を
 * 選べるが、比較対象の2件は軸受・ディスクの構成そのものが異なりうる（例：軸受位置を変えた設計変更）。
 * 位置を跨いで意味のある比較指標として、各回転数でシャフト全節点のうち最も振幅が大きい点＝
 * 「全体の最大」に固定している（本体タブのpointOptionsのうち'max'相当のみを使う設計）。
 */
export function FreqResponseComparePanel({ session, profile, onUpgradeClick }) {
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

    return { freqResponse, freqMaxRpm, unbalanceCount: unbalancesFromDisks.length };
  };

  useEffect(() => {
    if (!session || !isPaid) { setLoading(false); return; }
    let cancelled = false;
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
        return;
      }
      setProjects(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session, isPaid]);

  const selectedProjects = useMemo(() => {
    const order = [...selectedIds];
    return projects
      .filter(p => selectedIds.has(p.id) && p.analysis_results?.modes?.length > 0)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [projects, selectedIds]);

  // 時系列比較表用：選択済みプロジェクトを保存日時(updated_at)の昇順（古い→新しい）に並べたもの。
  // 「基準/比較対象」の2件固定選択とは別の並びで、選択した全件を時系列で俯瞰するために使う（①-2と同じ設計）。
  const timeSeriesProjects = useMemo(
    () => [...selectedProjects].sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)),
    [selectedProjects]
  );
  const maxModeCount = Math.max(0, ...timeSeriesProjects.map(p => p.analysis_results?.modes?.length || 0));

  // 時系列表の基準プロジェクトが選択から外れたら、一番古いプロジェクトに補正する
  useEffect(() => {
    if (timeSeriesProjects.length === 0) { setTableBaselineId(null); return; }
    if (!timeSeriesProjects.some(p => p.id === tableBaselineId)) {
      setTableBaselineId(timeSeriesProjects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSeriesProjects]);

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

  // 「全体の最大」振幅・位相を回転数ごとに求める（比較設計の理由はファイル冒頭コメント参照）。
  const maxSeries = (freq) => {
    if (!freq || !Array.isArray(freq.freqResponse)) return [];
    return freq.freqResponse.map(r => {
      let bestIdx = 0, bestAmp = -1;
      (r.nodeAmp || []).forEach((a, i) => { if (a > bestAmp) { bestAmp = a; bestIdx = i; } });
      return { rpm: r.rpm, amplitude: r.nodeAmp?.[bestIdx] ?? 0, phase: r.nodePhase?.[bestIdx] ?? 0 };
    });
  };

  // 「全体の最大」振幅が最も大きくなるrpm（＝危険速度）とその振幅を返す。
  // 基準・比較対象の2件比較（下のrefMaxAmp/refCritRpm等）と、時系列表（任意の選択プロジェクト全件）の
  // 両方から呼べる汎用形にしている。
  const criticalPoint = (freq) => {
    const series = maxSeries(freq);
    let maxAmp = 0, critRpm = null;
    series.forEach(d => { if (d.amplitude > maxAmp) { maxAmp = d.amplitude; critRpm = d.rpm; } });
    return { maxAmp, critRpm };
  };

  const refSeries = maxSeries(refFreq);
  const tgtSeries = maxSeries(tgtFreq);
  const ampLines = [
    referenceProject && { data: refSeries, color: COLORS.accent, label: referenceProject.name },
    targetProject && { data: tgtSeries, color: COLORS.danger, label: targetProject.name },
  ].filter(Boolean);
  const phaseLines = ampLines; // 同じ系列構成（色・ラベル）をそのまま流用、yKeyだけ切り替える

  const { maxAmp: refMaxAmp, critRpm: refCritRpm } = criticalPoint(refFreq);
  const { maxAmp: tgtMaxAmp, critRpm: tgtCritRpm } = criticalPoint(tgtFreq);

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
            - 危険速度（rpm）・ピーク振幅：それぞれ1行のみ。①・③-2本体タブと同じ「全体の最大
              （各回転数でシャフト全節点のうち最も振幅が大きい点）」に固定しているため、モード単位では
              なくプロジェクト単位で1つの値になる（①-2との行の粒度の違いはここに起因する）。
          下の「基準/比較対象」2件比較（ボード線図重ね描き）とは独立した俯瞰用の表で、選択状態は共有する。
          列ヘッダーをクリックすると、そのプロジェクトを「基準」にできる（①-2と同じ操作感）。 */}
      {selectedProjects.length >= 2 && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
            周波数応答の時系列比較
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            選択した{timeSeriesProjects.length}件を保存日時順（古い→新しい）に並べています。列ヘッダーをクリックすると、その列を基準（Δの比較元）にできます。
            危険速度・ピーク振幅は「全体の最大（各回転数でシャフト全節点のうち最も振幅が大きい点）」で統一しているため、位置の異なる設計同士でも比較できます。
            固有振動数はモード番号（出現順）ベースの単純な比較のため、設計変更でモードの順序が入れ替わっている場合は対応がずれることがあります。
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
                        <div style={{ fontSize: 9, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 2 }}>
                          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}Hz ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                        </div>
                      )}
                    </div>
                  );
                }),
              ]).flat()}

              {/* 危険速度（rpm）：1行のみ。「全体の最大」振幅を与える回転数（プロジェクト単位の値のため
                  モード別には分解していない。①-2との行の粒度の違いはここに起因する）。
                  freqCacheがまだ無い列は「計算中...」表示にする（③-2独自の追加事項）。 */}
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
                const { critRpm } = criticalPoint(cache);
                const baseCache = freqCache[tableBaselineId];
                const baseCritRpm = baseCache ? criticalPoint(baseCache).critRpm : null;
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
                      <div style={{ fontSize: 9, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 2 }}>
                        {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta))}rpm ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ピーク振幅：1行のみ。危険速度と同じcriticalPointからmaxAmpを取り出す。 */}
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
                const { maxAmp } = criticalPoint(cache);
                const baseCache = freqCache[tableBaselineId];
                const baseMaxAmp = baseCache ? criticalPoint(baseCache).maxAmp : null;
                const delta = (!isBaseline && baseMaxAmp != null) ? maxAmp - baseMaxAmp : null;
                const deltaPct = (delta != null && baseMaxAmp) ? (delta / baseMaxAmp * 100) : null;
                return (
                  <div key={`amp-${p.id}`} style={{
                    background: isBaseline ? COLORS.accent + '0F' : COLORS.surface2, borderRadius: 4, padding: '6px 8px', textAlign: 'center',
                  }}>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.textBright }}>
                      {maxAmp.toExponential(3)} mm
                    </div>
                    {isBaseline ? (
                      <div style={{ fontSize: 9, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginTop: 2 }}>基準</div>
                    ) : delta != null && (
                      <div style={{ fontSize: 9, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 2 }}>
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
              周波数応答 重ね描き（全体の最大振幅）
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              accent＝{referenceProject?.name || '基準'}、danger＝{targetProject?.name || '比較対象'}。
              破線の縦線は各プロジェクトの固有振動数（同色）です。
            </div>

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

                <LineChart
                  data={refSeries}
                  lines={ampLines}
                  xKey="rpm" yKey="amplitude"
                  title="ボード線図 — 振幅"
                  xLabel="回転数 [rpm]" yLabel="振幅 [mm]"
                  vLines={eigenVLines}
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
