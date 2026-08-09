import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { assembleSystem, matAdd } from "../analysis/femCore.js";
import { solveEigenvalue } from "../analysis/eigenvalue.js";
import { solveCampbellSweep } from "../analysis/campbell.js";
import { COLORS } from "./charts/chartTheme.js";
import { CampbellDiagramOverlay } from "./charts/CampbellDiagramOverlay.jsx";

// App.jsx／ComparePanel.jsx側と同じSupabaseクライアント設定を再利用する。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ── 危険速度（1X/2X/3XとモードのRPM交点）を1系列ぶん求める ──
// CampbellDiagram.jsx（②-2本体）内の同ロジックの切り出し版。
// 比較表用に、系列（＝プロジェクト）を問わず同じ形で呼べるようモジュール関数化してある。
// 戻り値: [{ rpm, freq, order, modeIdx, isForward, undampedModeIdx }, ...]（rpm昇順ソート済み）
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
// CampbellDiagram.jsx／CampbellDiagramOverlay.jsxの帯の階調（白／黄10%／橙20%／赤20%超）と同じ境界値を使う。
// operatingMinRpm/operatingMaxRpmが未設定の場合はnullを返す（表側で「—」表示にする）。
function marginStatus(rpm, operatingMinRpm, operatingMaxRpm) {
  if (operatingMinRpm == null || operatingMaxRpm == null) return null;
  if (rpm >= operatingMinRpm && rpm <= operatingMaxRpm) {
    return { category: '運用範囲内', pct: 0, level: 0 };
  }
  // 上限・下限、近い方からの逸脱率(%)を求める
  const overHi = rpm > operatingMaxRpm;
  const refEdge = overHi ? operatingMaxRpm : operatingMinRpm;
  const pct = refEdge !== 0 ? Math.abs(rpm - refEdge) / Math.abs(refEdge) * 100 : Infinity;
  if (pct <= 10) return { category: '10%マージン内', pct, level: 1 };
  if (pct <= 20) return { category: '20%マージン内', pct, level: 2 };
  return { category: '20%超', pct, level: 3 };
}

/**
 * ②-3 キャンベル線図比較（Pro限定機能）— 「①-2 固有値解析 比較」(ComparePanel.jsx)とは別タブ。
 *
 * 【なぜComparePanelと別コンポーネントなのか】
 * キャンベル線図の重ね描きは、DBに保存している比較用の軽量スナップショット(analysis_results＝
 * 固有振動数＋モード形状のみ)には無いデータ(rpm掃引の生データ)が必要で、選択したプロジェクトの
 * model_dataから毎回その場でassembleSystem→solveEigenvalue→solveCampbellSweepを再計算する。
 * これはMAC対応づけよりもずっと重い処理のため、①-2タブに間借りさせず、専用タブとして独立させた
 * （①-2で選んだ基準／比較対象とは連動せず、ここで改めて選び直す仕様。ユーザー指示による）。
 * プロジェクト一覧の取得・選択・「解析モデル」展開まわりのUIは、ComparePanel.jsxとほぼ同じものを
 * ここでも持っている（意図的な重複。①-2側の状態と混ざらないようにするため）。
 */
export function CampbellComparePanel({ session, profile, onUpgradeClick, active = true }) {
  const isPaid = profile?.plan === 'paid1' || profile?.plan === 'paid2';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]); // 全プロジェクト一覧（analysis_results含む）
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [referenceId, setReferenceId] = useState(null);
  const [targetId, setTargetId] = useState(null);

  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [modelPreviewCache, setModelPreviewCache] = useState({}); // id -> model_data（解析モデル展開時・キャンベル計算時の両方で共用）
  const [previewLoadingId, setPreviewLoadingId] = useState(null);

  const [campbellCache, setCampbellCache] = useState({}); // id -> { campbellData, maxRpm }
  const [campbellLoadingId, setCampbellLoadingId] = useState(null);
  const [campbellError, setCampbellError] = useState(null);
  // グラフの表示範囲（null＝自動）。②-2キャンベル線図タブと同じキー構成に揃えている。
  const [campbellView, setCampbellView] = useState({ minRpm: null, maxRpm: null, minFreq: null, maxFreq: null });
  const [tableBaseId, setTableBaseId] = useState(null); // 危険速度比較表のΔ基準列（プロジェクトid）

  // 【1-10バグ修正】ComparePanel.jsxと同じ対応（コメント詳細はそちら参照）。
  // App.jsx側で常時マウント＋display:noneに変更したことに合わせ、非アクティブなタブの分まで
  // 先読みフェッチしないよう、また一度取得済みなら再フェッチしないようにする。
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
  // 画面に反映させてから計算を始める（App.jsxのtick()と同じ狙い）。
  const yieldToPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  const computeCampbellForProject = async (p) => {
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
    const { M, K, G, Kb, Cb } = sys;
    const C = M.map((row, i) => row.map((v, j) =>
      settings.alphaRayleigh * M[i][j] + settings.betaRayleigh * K[i][j]
    ));
    const Ktotal = matAdd(K, Kb);
    const Ctotal = matAdd(C, Cb);
    const undamped = solveEigenvalue(M, Ktotal, settings.nModes);
    const campbellData = solveCampbellSweep(M, Ktotal, Ctotal, G, settings.maxRpm, settings.nModes, undamped);
    // 運用回転数レンジ（帯表示用）も保存時のsettingsからそのまま持ち出す。未設定ならundefinedのまま
    // （CampbellDiagramOverlay側でnullチェックして帯を描かないようにする）。
    return {
      campbellData, maxRpm: settings.maxRpm,
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

  // 選択済み全プロジェクトぶん、未計算のものだけキャンベル線図を計算する。
  // グラフ（基準・比較対象の2系列）だけでなく、危険速度比較表（選択全件）でも使うため対象を全選択件に広げてある。
  useEffect(() => {
    const toCompute = selectedProjects.filter(p => !campbellCache[p.id]);
    if (toCompute.length === 0) return;
    let cancelled = false;
    (async () => {
      setCampbellError(null);
      for (const p of toCompute) {
        if (cancelled) return;
        setCampbellLoadingId(p.id);
        try {
          const result = await computeCampbellForProject(p);
          if (!cancelled) setCampbellCache(prev => ({ ...prev, [p.id]: result }));
        } catch (e) {
          if (!cancelled) setCampbellError(`${p.name}: ${e.message || 'キャンベル線図の計算に失敗しました'}`);
        }
      }
      if (!cancelled) setCampbellLoadingId(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  const refCampbell = referenceProject ? campbellCache[referenceProject.id] : null;
  const tgtCampbell = targetProject ? campbellCache[targetProject.id] : null;

  // Δ基準列：選択が外れたら選択済み先頭にフォールバック
  useEffect(() => {
    if (selectedProjects.length === 0) { setTableBaseId(null); return; }
    if (!selectedProjects.some(p => p.id === tableBaseId)) setTableBaseId(selectedProjects[0].id);
  }, [selectedProjects]);

  // ── 危険速度比較表：次数×モードを行、選択済み全プロジェクトを列にする ──
  // 各プロジェクトの余裕度は、そのプロジェクト自身のoperatingMinRpm/operatingMaxRpm
  // （保存時の解析設定）を使って判定する（1-9g合意：帯の判定基準と同じ考え方を表にも適用）。
  const criticalSpeedTable = useMemo(() => {
    const withData = selectedProjects
      .map(p => ({ project: p, campbell: campbellCache[p.id] }))
      .filter(x => x.campbell);
    if (withData.length === 0) return null;

    // 行キー（次数-モード番号-前進/後進）の和集合を、全プロジェクト横断で作る
    const rowKeySet = new Map(); // key -> { order, modeIdx, isForward, undampedModeIdx }
    withData.forEach(({ campbell }) => {
      findCriticalSpeeds(campbell.campbellData, campbell.maxRpm).forEach(cs => {
        const key = `${cs.order}-${cs.undampedModeIdx ?? cs.modeIdx}-${cs.isForward}`;
        if (!rowKeySet.has(key)) rowKeySet.set(key, cs);
      });
    });

    const rows = [...rowKeySet.entries()]
      .sort((a, b) => a[1].order - b[1].order || (a[1].undampedModeIdx ?? a[1].modeIdx) - (b[1].undampedModeIdx ?? b[1].modeIdx))
      .map(([key, meta]) => {
        const cells = {};
        withData.forEach(({ project, campbell }) => {
          const cs = findCriticalSpeeds(campbell.campbellData, campbell.maxRpm)
            .find(c => `${c.order}-${c.undampedModeIdx ?? c.modeIdx}-${c.isForward}` === key);
          const margin = cs ? marginStatus(cs.rpm, campbell.operatingMinRpm, campbell.operatingMaxRpm) : null;
          cells[project.id] = cs ? { rpm: cs.rpm, margin } : null;
        });
        const label = `${meta.order}X - Mode${(meta.undampedModeIdx ?? meta.modeIdx) + 1}${meta.isForward === undefined ? '' : (meta.isForward ? 'F' : 'B')}`;
        // どのプロジェクトも20%超（またはデータなし）の行は、目立たなくてよい行として末尾へ回す
        const maxLevel = Math.max(...Object.values(cells).map(c => c?.margin?.level ?? -1));
        return { key, label, order: meta.order, cells, maxLevel };
      })
      // 余裕度の高い(=危険寄り)行を上に、判定不能(-1)・20%超は下に
      .sort((a, b) => {
        const la = a.maxLevel < 0 ? 99 : a.maxLevel, lb = b.maxLevel < 0 ? 99 : b.maxLevel;
        if (la !== lb) return la - lb;
        return a.order - b.order;
      });

    return { columns: withData.map(x => x.project), rows };
  }, [selectedProjects, campbellCache]);

  // ─── 未ログイン／Free：アップグレード誘導（ComparePanelの同種の分岐と揃えたトーン） ───
  if (!session) {
    return (
      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, padding: '40px 0', textAlign: 'center' }}>
        キャンベル線図比較を使うには、まずログインしてください。
      </div>
    );
  }
  if (!isPaid) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, marginBottom: 14 }}>
          キャンベル線図比較はProプランの機能です。保存済みのプロジェクト同士でキャンベル線図を重ねて確認できます。
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

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 16px', lineHeight: 1.6 }}>
        比較用に保存しているデータにはキャンベル線図の生データを含まないため、選択したプロジェクトのモデル構成から
        その場で再計算します（計算に少し時間がかかることがあります）。①-2の固有値解析比較とは選択が独立しています。
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

      {selectedProjects.length < 2 ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
          上の一覧から、解析結果を持つプロジェクトを2つ以上選択してください。
        </div>
      ) : !targetProject ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>比較対象プロジェクトがありません。</div>
      ) : (
        <>
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

          {/* 危険速度比較表：グラフとは独立に、選択済み全プロジェクトを列として並べる */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              危険速度比較表
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              選択中の全プロジェクト（{selectedProjects.length}件）を列に、次数×モードの危険速度(rpm)を行に並べています。
              余裕度は各プロジェクト自身の運用回転数レンジ設定に基づく判定です（未設定のプロジェクトは「—」）。
              列見出しをクリックするとΔ基準列を切り替えられます。
            </div>
            {!criticalSpeedTable ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>
                {selectedProjects.length === 0 ? '上の一覧からプロジェクトを選択してください。' : '計算中...'}
              </div>
            ) : criticalSpeedTable.rows.length === 0 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>危険速度（1X/2X/3Xとモードの交点）が見つかりませんでした。</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'JetBrains Mono', minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>次数・モード</th>
                      {criticalSpeedTable.columns.map(p => (
                        <th key={p.id} style={{ ...thStyle, cursor: 'pointer', color: p.id === tableBaseId ? COLORS.accent : COLORS.text }}
                          onClick={() => setTableBaseId(p.id)} title="クリックでΔ基準列に設定">
                          {p.name}{p.id === tableBaseId ? '（基準）' : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {criticalSpeedTable.rows.map(row => {
                      const baseCell = tableBaseId ? row.cells[tableBaseId] : null;
                      // 判定不能(-1=どの列にも危険速度がない)行は視認性を下げて末尾に置いてあるため、それに合わせて薄くする
                      const rowDim = row.maxLevel === 3 || row.maxLevel < 0;
                      return (
                        <tr key={row.key} style={{ opacity: rowDim ? 0.5 : 1 }}>
                          <td style={tdStyle}>{row.label}</td>
                          {criticalSpeedTable.columns.map(p => {
                            const cell = row.cells[p.id];
                            if (!cell) return <td key={p.id} style={tdStyle}>—</td>;
                            const delta = baseCell && p.id !== tableBaseId ? cell.rpm - baseCell.rpm : null;
                            const deltaPct = baseCell && baseCell.rpm !== 0 && p.id !== tableBaseId ? (delta / baseCell.rpm) * 100 : null;
                            const marginColor = cell.margin ? marginLevelColor(cell.margin.level) : COLORS.textMuted;
                            return (
                              <td key={p.id} style={tdStyle}>
                                <div>{cell.rpm.toFixed(0)} rpm</div>
                                {delta != null && (
                                  <div style={{ fontSize: 10, color: delta >= 0 ? COLORS.success : COLORS.danger }}>
                                    Δ{delta >= 0 ? '+' : ''}{delta.toFixed(0)}（{deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%）
                                  </div>
                                )}
                                <div style={{ fontSize: 10, color: marginColor }}>
                                  {cell.margin ? `${cell.margin.category}${cell.margin.level > 0 ? `（${cell.margin.pct.toFixed(1)}%）` : ''}` : '—'}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* キャンベル線図 重ね描き */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              キャンベル線図 重ね描き
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              実線＝{referenceProject?.name || '基準'}、破線＝{targetProject?.name || '比較対象'}。
              危険速度マーカーは◆(塗りつぶし)＝基準、◇(白抜き)＝比較対象です。
              背景の運用回転数レンジ帯は、基準（{referenceProject?.name || '—'}）の解析設定を使用しています。
            </div>

            {/* 表示範囲（②-2キャンベル線図タブと同じ操作感）。未入力＝自動 */}
            <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>表示範囲</span>
              {[
                { label: 'rpm 下限', key: 'minRpm', unit: 'rpm', step: 100 },
                { label: 'rpm 上限', key: 'maxRpm', unit: 'rpm', step: 100 },
                { label: 'Hz 下限',  key: 'minFreq', unit: 'Hz', step: 10 },
                { label: 'Hz 上限',  key: 'maxFreq', unit: 'Hz', step: 10 },
              ].map(({ label, key, unit, step }) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10, color: COLORS.textMuted }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="number" step={step}
                      placeholder="auto"
                      value={campbellView[key] ?? ''}
                      onChange={e => setCampbellView(v => ({ ...v, [key]: e.target.value === '' ? null : parseFloat(e.target.value) }))}
                      style={{ width: 80, textAlign: 'right', fontFamily: 'JetBrains Mono', fontSize: 11 }}
                    />
                    <span style={{ fontSize: 10, color: COLORS.textMuted }}>{unit}</span>
                  </div>
                </div>
              ))}
              <button onClick={() => setCampbellView({ minRpm: null, maxRpm: null, minFreq: null, maxFreq: null })}
                style={{ fontSize: 10, padding: '4px 10px', background: COLORS.surface, color: COLORS.textMuted, border: `1px solid ${COLORS.border}` }}>
                リセット
              </button>
            </div>

            {campbellError ? (
              <div style={{ fontSize: 11, color: COLORS.danger, padding: '12px 0' }}>{campbellError}</div>
            ) : campbellLoadingId ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>
                キャンベル線図を計算中...（{projects.find(p => p.id === campbellLoadingId)?.name || '...'}）
              </div>
            ) : refCampbell && tgtCampbell ? (
              <CampbellDiagramOverlay
                series={[
                  { campbellData: refCampbell.campbellData, maxRpm: refCampbell.maxRpm, label: referenceProject.name, color: COLORS.accent },
                  { campbellData: tgtCampbell.campbellData, maxRpm: tgtCampbell.maxRpm, label: targetProject.name, color: COLORS.danger },
                ]}
                minRpmLim={campbellView.minRpm}
                maxRpmLim={campbellView.maxRpm}
                minFreqLim={campbellView.minFreq}
                maxFreqLim={campbellView.maxFreq}
                operatingMinRpm={refCampbell.operatingMinRpm}
                operatingMaxRpm={refCampbell.operatingMaxRpm}
                width={560}
                height={820}
              />
            ) : (
              <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>準備中...</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: 'left', padding: '6px 10px', borderBottom: `2px solid ${COLORS.border}`,
  fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}`, whiteSpace: 'nowrap',
};

// 余裕度レベル(0〜3)に応じた表示色。帯の配色（白／黄10%／橙20%／赤20%超）と揃えてある。
function marginLevelColor(level) {
  if (level === 0) return COLORS.textMuted; // 運用範囲内は目立たせない
  if (level === 1) return COLORS.warning; // 10%マージン
  if (level === 2) return COLORS.orange;
  return COLORS.danger; // 20%超
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
