import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  nearestFreqIndices, extractY, alignSign,
} from "../analysis/macMatching.js";
import { COLORS } from "./charts/chartTheme.js";
import { isProOrTrial } from "../utils/plan.js";

// App.jsx側と同じSupabaseクライアント設定を再利用する。
// 【注記】App.jsx側で既に作成済みのsupabaseクライアントをpropsで渡す方式も検討したが、
// 他のコンポーネント(ProjectsModal等)も同様にモジュールトップレベルでcreateClientしている
// 既存パターンに合わせた（旧CompareModal.jsxから踏襲）。createClientは同一設定なら
// 複数回呼んでも実害はない。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// 低MAC値（対応が怪しいモード）の警告しきい値。プロトタイプ・旧CompareModalと同じ値を踏襲。
const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ── 時系列比較表のΔ（▲▼）に付ける色 ──
// 「値が大きい／小さい」ではなく「良い方向／悪い方向」で色分けする（1-9g合意）。
// 固有振動数・危険速度は上昇が良い方向（危険速度から離れる）なのでdeltaGoodDirection='up'。
// ピーク振幅は上昇が悪い方向（振動が増える）なのでdeltaGoodDirection='down'。
function deltaColor(delta, goodDirection = 'up') {
  if (delta == null) return COLORS.textMuted;
  const isIncrease = delta >= 0;
  const isGood = goodDirection === 'up' ? isIncrease : !isIncrease;
  return isGood ? COLORS.accent : COLORS.danger;
}

/**
 * 複数プロジェクト比較（Pro限定機能）— 解析タブと同列の「比較」タブの中身。
 *
 * 【旧実装からの変更点】
 * 元々は「☁ クラウドプロジェクト」モーダル内でチェックボックス選択→別ウィンドウの
 * CompareModalが開く、という2段構成だったが、それをやめてこのコンポーネント1つに統合した：
 *   - プロジェクト一覧の取得・選択（旧ProjectsModal内にあった選択UI相当）
 *   - MAC行列・モード形状表示・比較表示ロジック（旧CompareModalの中身。ほぼそのまま）
 * モーダルの外枠（背景オーバーレイ・閉じるボタン）は撤去し、右パネルの通常コンテンツとして描画する。
 *
 * 【設計メモ】
 * - MAC計算はここ(クライアント側)でその場で実行する。保存時にMAC計算は行わない。
 * - 比較方式は「基準モデル方式」：選択したプロジェクトの中から基準を1つ選び、
 *   他のプロジェクトを1つずつタブで切り替えながらMAC対応づけする（全ペア総当たりはしない）。
 * - プロジェクト一覧は選択に使うidだけでなくanalysis_resultsも一括取得するため、
 *   「2つ選んだ後に選択分だけ再取得する」という旧CompareModalの2段階フェッチは不要になった。
 */
export function ComparePanel({ session, profile, onUpgradeClick, active = true, onSelectionChange }) {
  // isProOrTrial は plan(有料契約) と trial_active(トライアル中) の両方を見る共通判定関数。
  // 以前はここに `profile?.plan === 'paid1' || profile?.plan === 'paid2'` を直書きしていたが、
  // トライアル機能追加時に他画面と判定がズレる不具合が起きたため、共通関数化した（1-19・1-20）。
  const isPaid = isProOrTrial(profile);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]); // 全プロジェクト一覧（analysis_results含む）
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [referenceId, setReferenceId] = useState(null);
  const [targetId, setTargetId] = useState(null); // タブで選ばれている比較対象1件

  // 「解析モデル」ボタンで展開中のプロジェクトID群（解析モデルの概要を表示。複数同時に開ける）。
  // ProjectsModal(App.jsx)の同機能とロジックを揃えている。
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [modelPreviewCache, setModelPreviewCache] = useState({}); // 未解析プロジェクト用：id -> model_data（展開時に遅延取得してキャッシュ。時系列表のモデル差分表示でも共用する）
  const [previewLoadingId, setPreviewLoadingId] = useState(null);

  // 時系列比較表用：どのプロジェクトを「基準」にするか（周波数のΔ・モデル設定の差分の両方、この基準からの差を表示する）。
  const [tableBaselineId, setTableBaselineId] = useState(null);

  // 【1-12追加】AI相談タブ（④）が「直前にこの比較タブで何を見ていたか」を復元できるよう、
  // 選択IDと基準列IDを親（App.jsx）へ軽量に通知する。重い計算結果は渡さず、IDのみ渡す
  // （AI相談タブ側で必要なら選択IDから再計算する。1-12で合意した方式2）。
  useEffect(() => {
    onSelectionChange?.({ selectedIds: [...selectedIds], baselineId: tableBaselineId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, tableBaselineId]);
  const [modelDiffLoadingIds, setModelDiffLoadingIds] = useState(() => new Set()); // モデル差分表示のため取得中のプロジェクトID

  // 【1-10バグ修正】このパネルはApp.jsx側で常時マウントされ、非表示時はdisplay:noneで隠される
  // 方式に変更した（タブ切替でアンマウント→選択状態が消える問題への対応）。
  // そのため「一度プロジェクト一覧を取得済みか」をrefで管理し、非アクティブなタブの分まで
  // 先読みフェッチしたり、タブを行き来するたびに再フェッチしたりしないようにする。
  const hasFetchedRef = useRef(false);

  // 「解析モデル」ボタンを押すと、そのプロジェクトの解析モデルの概要を展開して表示する。
  // 解析済み(analysis_results あり)なら一覧取得時のデータだけで表示できるので追加取得は不要。
  // 未解析の場合はシャフト構成などがmodel_data側にしかないため、展開時に初めて取得してキャッシュする。
  const toggleExpand = async (p) => {
    const alreadyOpen = expandedIds.has(p.id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      return next;
    });
    if (alreadyOpen) return; // 閉じる操作の場合はデータ取得不要
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

  useEffect(() => {
    // 非アクティブなタブの分まで先読みフェッチしない。
    // 一度取得済み(hasFetchedRef)なら、タブを離れて戻ってきても再フェッチしない
    // （selectedIds等の選択状態はマウントされ続けているのでこのuseEffectと無関係に保持される）。
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

  // 選択中(かつ解析結果あり)のプロジェクトのみ、選択した順で並べる
  const selectedProjects = useMemo(() => {
    const order = [...selectedIds];
    return projects
      .filter(p => selectedIds.has(p.id) && p.analysis_results?.modes?.length > 0)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [projects, selectedIds]);

  // 時系列比較表用：基準列(tableBaselineId)を先頭に固定し、残りは選択(チェック)した順に並べる。
  // 【2026-08-06変更】以前は保存日時(updated_at)の昇順で並べていたが、「基準が右端に出て
  // 分かりにくい」という指摘を受け、基準列を左端固定に変更した。時系列（保存順）で俯瞰する
  // という以前の意味合いはこの並びでは失われるが、基準からの差分を見る用途を優先している。
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
  // 再取得しない。2件未満の時は比較のしようがないので取得しない。
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
  // 【設計メモ】シャフト要素は要素数が変わると1対1で対応させる意味が薄い（分割数を変えただけの場合と、
  // 実際に形状を変えた場合の区別が難しい）ため、全長・要素数といった集計値のみを比較する。
  // ディスク・軸受・材料はid一致で対応づけ、位置・質量・剛性など主要な値だけを比較する
  // （マイナーな内部プロパティまで網羅すると、変化の要点が埋もれてしまうため）。
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

  // 選択セットが変わったら、基準プロジェクトIDが選択の中に無ければ補正する
  useEffect(() => {
    if (selectedProjects.length === 0) { setReferenceId(null); return; }
    if (!selectedProjects.some(p => p.id === referenceId)) {
      setReferenceId(selectedProjects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  // 選択セットが変わったら、比較対象プロジェクトIDが選択の中に無ければ補正する。
  // 基準と同じプロジェクトを比較対象に選ぶこと自体は許可する（自分自身との比較でMAC対応づけの動作確認ができるため）。
  // 初期選択時は分かりやすさのため基準と異なるプロジェクトを優先するが、強制はしない。
  useEffect(() => {
    if (selectedProjects.length === 0) { setTargetId(null); return; }
    if (!selectedProjects.some(p => p.id === targetId)) {
      const fallback = selectedProjects.find(p => p.id !== referenceId) || selectedProjects[0];
      setTargetId(fallback.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  // 一覧取得結果は analysis_results.modes の形なので、比較ロジックが期待する
  // { id, name, modes, nodePositions, bearingPos, diskPos } の平坦な形に正規化する。
  // 以降このrefN/tgtNだけを単一のデータソースとして使う（二重定義によるバグの種を避ける）。
  const normalize = (p) => p && {
    id: p.id, name: p.name,
    modes: p.analysis_results?.modes || [],
    nodePositions: p.analysis_results?.nodePositions || [],
    bearingPos: p.analysis_results?.bearingPos || [],
    diskPos: p.analysis_results?.diskPos || [],
  };
  const refN = normalize(referenceProject) || { name: '', modes: [], nodePositions: [], bearingPos: [], diskPos: [] };
  const tgtN = normalize(targetProject) || { name: '', modes: [], nodePositions: [], bearingPos: [], diskPos: [] };
  const modesA = refN.modes;
  const modesB = tgtN.modes;
  const nodePositions = refN.nodePositions;

  // MAC計算はサーバー側（Edge Function 'mac-match'）で行う。
  // 【設計メモ・2026-08-21】以前はcomputeMACMatrix/matchModesByMACをここで直接
  // 呼んでいたが、計算ロジック自体がpublicなJSバンドルに含まれてしまう問題
  // （プロダクト方針メモ 1-5）への対策として、Edge Functionに移した。
  // クライアント側にはmacMatching.jsのnearestFreqIndices・extractY・alignSignの
  // ような「表示用の軽い処理」のみを残し、MAC計算本体（computeMAC系）は
  // クライアントのソースコードから完全に削除している。
  const [macMatrix, setMacMatrix] = useState([]);
  const [matches, setMatches] = useState([]);
  const [macLoading, setMacLoading] = useState(false);
  const [macError, setMacError] = useState(null);

  useEffect(() => {
    if (!modesA.length || !modesB.length) {
      setMacMatrix([]);
      setMatches(modesA.map((ref, i) => ({
        refIndex: i, refFreq: ref.freq,
        targetIndex: null, targetFreq: null, macValue: null, lowConfidence: true, incomparable: true,
      })));
      return;
    }
    let cancelled = false;
    setMacLoading(true);
    setMacError(null);
    supabase.functions.invoke('mac-match', {
      body: { referenceModes: modesA, targetModes: modesB },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data || data.error) {
        setMacError(data?.error || error?.message || 'MAC計算に失敗しました');
        setMacMatrix([]);
        setMatches([]);
        return;
      }
      setMacMatrix(data.macMatrix || []);
      setMatches(data.matches || []);
    }).catch((e) => {
      if (cancelled) return;
      setMacError(e?.message || 'MAC計算に失敗しました');
      setMacMatrix([]);
      setMatches([]);
    }).finally(() => {
      if (!cancelled) setMacLoading(false);
    });
    return () => { cancelled = true; };
  }, [modesA, modesB]);

  const nearestFreqIdx = useMemo(() => nearestFreqIndices(modesA, modesB), [modesA, modesB]);

  // ─── 未ログイン／Free：アップグレード誘導（ProjectsModalの同種の分岐と揃えたトーン） ───
  if (!session) {
    return (
      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, padding: '40px 0', textAlign: 'center' }}>
        複数プロジェクト比較を使うには、まずログインしてください。
      </div>
    );
  }
  if (!isPaid) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, marginBottom: 14 }}>
          複数プロジェクト比較はProプランの機能です。保存済みのプロジェクト同士で固有振動数・モード形状を比較できます。
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
        MACはモード<b>形状</b>ベクトル同士の類似度（0〜1）を示す指標で、周波数の値は一切使っていません。
        周波数だけを見た「最近傍」の予想と、形状で見たMACの対応づけが食い違うことがあります（設計変更でモードの出現順序が入れ替わっている場合など）。
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
                  {/* 1段目：チェックボックス＋名前＋バッジ＋「解析モデル」ボタン。
                      1行にすべて詰め込むと項目数が多く折り返しが必要になるケースがあるため、flexWrapで安全側に倒す */}
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

                  {/* 2段目：更新日時 */}
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 4 }}>
                    {new Date(p.updated_at).toLocaleDateString('ja-JP')}
                  </div>

                  {/* 展開時：解析モデルの概要（ProjectsModalと同じ表示ロジック） */}
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

      {/* 固有振動数の時系列比較表（新設）。
          選択した全プロジェクトを保存日時順に並べ、モードごとの固有振動数の推移を一覧できる。
          下の「基準/比較対象」2件比較（既存のMAC比較）とは独立した俯瞰用の表で、選択状態は共有する。
          【設計メモ】モードの対応づけは番号（出現順）ベースの単純な比較で、MACのような形状ベースの
          対応づけはしていない。設計変更でモードの出現順序が入れ替わるケースでは行がずれる可能性がある
          （下のMAC比較セクションが、まさにそのズレを検出するためのもの）。
          【2026-08-05追記】列ヘッダーをクリックすると、そのプロジェクトを「基準」にできる
          （BearingStiffnessSweep.jsxの「ラベルクリックでアクティブ切り替え」と同じ操作感に揃えた）。
          Δ・モデル設定の変化は、どちらもこの基準列との差分になる（以前は「1つ前の列との差分」
          だったが、基準を固定して見たいというユーザー要望により変更）。 */}
      {selectedProjects.length >= 2 && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
            固有振動数の時系列比較
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            選択した{timeSeriesProjects.length}件を保存日時順（古い→新しい）に並べています。列ヘッダーをクリックすると、その列を基準（Δの比較元）にできます。
            モード番号（出現順）ベースの単純な比較のため、設計変更でモードの順序が入れ替わっている場合は対応がずれることがあります（正確な対応づけは下のMAC比較を参照してください）。
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `56px repeat(${timeSeriesProjects.length}, minmax(150px, 1fr))`,
              gap: 6, minWidth: 56 + timeSeriesProjects.length * 150,
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

              {/* 「変化」行：モード行群のすぐ下に、モデル設定側の差分（インプットの変化）を列ごとに並べる。
                  以前は表の外に別セクションとして出していたが、「モードの下に一緒に入れたい」という
                  ユーザー要望により、同じグリッドの1行としてここに統合した。
                  CSS Gridは行ごとに高さが自動調整される（他の行の高さには影響しない）ため、
                  この行だけ内容量に応じて縦に伸びても、M1〜M5の行の見た目は変わらない。 */}
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
              モード形状の重なり・MAC対応づけまで詳しく見る。上の時系列表（全件の俯瞰）とは別の
              セクションであることが分かるよう見出しを付けている（ユーザー指摘により追加）。 */}
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
            グラフ比較（2種）
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
            上の時系列表は選択した全件の俯瞰です。ここでは2件（基準／比較対象）を選んで、モード形状の重なりとMAC対応づけを詳しく比較します。
          </div>

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

          {/* モード一覧（左：基準／右：比較対象） */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.accent, marginBottom: 10 }}>{refN.name}</div>
              <ModeList modes={refN.modes} color={COLORS.accent} nodePositions={refN.nodePositions} bearingPos={refN.bearingPos} diskPos={refN.diskPos} />
            </div>
            <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.danger, marginBottom: 10 }}>{tgtN.name}</div>
              <ModeList modes={tgtN.modes} color={COLORS.danger} nodePositions={tgtN.nodePositions} bearingPos={tgtN.bearingPos} diskPos={tgtN.diskPos} />
            </div>
          </div>

          {/* MAC行列 */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>MAC 行列</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 10 }}>
              縦：{refN.name}のモード　横：{tgtN.name}のモード。太枠＝各行で最もMACが高い（＝最も形状が近い）セル
            </div>
            {macLoading && (
              <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
                MACを計算しています…
              </div>
            )}
            {!macLoading && macError && (
              <div style={{ fontSize: 12, color: COLORS.danger, padding: '20px 0', textAlign: 'center' }}>
                MAC計算に失敗しました：{macError}
              </div>
            )}
            {!macLoading && !macError && (
            <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(${modesB.length}, 1fr)`, gap: 6, alignItems: 'center' }}>
              <div />
              {modesB.map((mb, j) => (
                <div key={j} style={{ textAlign: 'center', fontSize: 10, color: COLORS.danger, fontFamily: 'JetBrains Mono' }}>
                  B{j + 1}<br />{mb.freq.toFixed(0)}Hz
                </div>
              ))}
              {modesA.map((ma, i) => (
                <FragmentRow key={i} i={i} ma={ma} row={macMatrix[i]} bestIdx={matches[i]?.targetIndex} />
              ))}
            </div>
            )}
          </div>

          {/* 「同じ順番」vs「MAC」比較 */}
          {!macLoading && !macError && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              「同じ順番」比較 vs 「MAC」比較
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 14, lineHeight: 1.6 }}>
              基準の各モードについて、MACで判定した「本当の対応」を大きく表示し、その下に「同じ順番と仮定した場合」「周波数が一番近いものを選んだ場合」を参考として添えています。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {modesA.map((ma, i) => {
                const naiveB = modesB[i];
                const match = matches[i];
                const freqB = nearestFreqIdx[i] >= 0 ? modesB[nearestFreqIdx[i]] : null;
                const macVal = match?.macValue ?? null; // nullはDOF不一致による「比較不可」（0.00とは区別する）
                const bestIdx = match?.targetIndex;
                const freqVsMacDisagree = nearestFreqIdx[i] !== bestIdx;
                const orderVsMacDisagree = i !== bestIdx;
                const lowConfidence = macVal !== null && macVal < LOW_CONFIDENCE_THRESHOLD;
                const flagged = macVal !== null && (freqVsMacDisagree || orderVsMacDisagree);
                return (
                  <div key={i} style={{
                    border: `1px solid ${flagged ? COLORS.danger + '66' : COLORS.border}`,
                    background: flagged ? COLORS.danger + '0A' : COLORS.surface2,
                    borderRadius: 6, padding: '10px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700, color: COLORS.accent }}>
                        A{i + 1}（{ma.freq.toFixed(0)}Hz）
                      </span>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>→ MACによる本当の対応：</span>
                      {bestIdx != null && modesB[bestIdx] ? (
                        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 14, fontWeight: 700, color: COLORS.textBright }}>
                          B{bestIdx + 1}（{modesB[bestIdx].freq.toFixed(0)}Hz）
                        </span>
                      ) : <span style={{ fontSize: 12, color: COLORS.textMuted }}>対応なし</span>}
                      {macVal === null ? (
                        <span
                          title="モデル構造（要素数・ノード数）が異なるため比較できません"
                          style={{
                            fontSize: 11, fontFamily: 'JetBrains Mono', padding: '1px 6px', borderRadius: 4,
                            background: COLORS.textMuted + '22', color: COLORS.textMuted,
                          }}>
                          比較不可（モデル構造が異なる）
                        </span>
                      ) : (
                        <span style={{
                          fontSize: 11, fontFamily: 'JetBrains Mono', padding: '1px 6px', borderRadius: 4,
                          background: lowConfidence ? COLORS.warning + '22' : COLORS.success + '22',
                          color: lowConfidence ? COLORS.warning : COLORS.success,
                        }}>
                          MAC {macVal.toFixed(2)}{lowConfidence ? '（低信頼）' : ''}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 11, color: COLORS.textMuted, flexWrap: 'wrap' }}>
                      <span>
                        同じ順番の予想：B{i + 1}（{naiveB ? naiveB.freq.toFixed(0) : '—'}Hz）
                        {orderVsMacDisagree
                          ? <span style={{ color: COLORS.danger, fontWeight: 700 }}> ✗ 不一致</span>
                          : <span style={{ color: COLORS.success }}> ✓ 一致</span>}
                      </span>
                      {freqB && (
                        <span>
                          周波数最近傍の予想：B{nearestFreqIdx[i] + 1}（{freqB.freq.toFixed(0)}Hz, MAC {
                            macMatrix[i]?.[nearestFreqIdx[i]] != null
                              ? macMatrix[i][nearestFreqIdx[i]].toFixed(2)
                              : '—（比較不可）'
                          }）
                          {freqVsMacDisagree
                            ? <span style={{ color: COLORS.danger, fontWeight: 700 }}> ✗ 不一致</span>
                            : <span style={{ color: COLORS.success }}> ✓ 一致</span>}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 12, lineHeight: 1.6 }}>
              「周波数最近傍」は比較のためだけに別途計算したもので、MACの判定には一切使っていません。✗が付いている場合は、
              「同じ順番」または「周波数が近い」という直感的な予想が、形状で見ると誤りだったことを意味します。<br />
              ※各基準モードについてMAC最大値を単純に採用する簡易版です。複数の基準モードが同じ対象モードを指す場合（veering現象）もあり、
              1対1の最適割当（ハンガリアン法など）は今後の検討課題です。
            </div>
          </div>
          )}

          {/* 形状を実際に重ねて確認 */}
          {!macLoading && !macError && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              形状を実際に重ねて確認
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              各基準モードについて、重ねて比べたい比較対象のモードをボタンで選べます（デフォルトはMACが最も高いものを自動選択）。
              「推奨」＝MAC最良、「周波数近」＝周波数だけで見ると一番近いもの。カーブが実線とぴったり重なっていれば同じ変形パターン、
              大きくズレていれば別の変形パターンです。⌂＝軸受位置、●＝ディスク位置。
            </div>
            {modesA.map((ma, i) => (
              <ShapeCompareRow
                key={`${referenceId}-${targetId}-${i}`}
                i={i} ma={ma} modesB={modesB}
                nodePositions={nodePositions}
                bearingPos={refN.bearingPos}
                diskPos={refN.diskPos}
                recommendedIdx={matches[i]?.targetIndex ?? 0}
                incomparable={matches[i]?.incomparable ?? false}
                nearestFreqIdxForRow={nearestFreqIdx[i]}
                macRow={macMatrix[i] || []}
                isLast={i === modesA.length - 1}
              />
            ))}
          </div>
          )}
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

// モード形状をシャフトに沿ったSVG曲線として描画する。
// 複数の曲線を重ねて描けるので、「同じ形か・違う形か」を目で確認できる。
function ModeShapeSvg({ nodePositions, curves, width = 260, height = 90, bearingPos = [], diskPos = [] }) {
  if (!nodePositions || nodePositions.length === 0) return null;
  const totalLen = nodePositions[nodePositions.length - 1] || 1;
  const padX = 12, padY = 14;
  const px = x => padX + (x / totalLen) * (width - padX * 2);
  const maxAbs = Math.max(...curves.flatMap(c => c.y.map(Math.abs)), 1e-9);
  const py = v => height / 2 - (v / maxAbs) * (height / 2 - padY);
  return (
    <svg width={width} height={height} style={{ display: 'block', background: COLORS.surface, borderRadius: 4 }}>
      <line x1={padX} y1={height / 2} x2={width - padX} y2={height / 2} stroke={COLORS.border} strokeWidth={1} />
      {bearingPos.map((x, i) => (
        <rect key={`b${i}`} x={px(x) - 3} y={height / 2 - 3} width={6} height={6} fill={COLORS.warning} />
      ))}
      {diskPos.map((x, i) => (
        <circle key={`d${i}`} cx={px(x)} cy={height / 2} r={4} fill={COLORS.purple} opacity={0.5} />
      ))}
      {curves.map((c, ci) => (
        <polyline
          key={ci}
          points={nodePositions.map((x, i) => `${px(x)},${py(c.y[i] ?? 0)}`).join(' ')}
          fill="none" stroke={c.color} strokeWidth={2.2}
          strokeDasharray={c.dash || 'none'}
        />
      ))}
    </svg>
  );
}

// v=null は「DOF数（モデル構造）が違うため計算不能」を表す。
// 0.00（形状が全く異なるという計算結果）と混同しないよう、色を塗らずグレーの「—」で表示する。
function MacCell({ v }) {
  if (v === null || v === undefined) {
    return (
      <div
        title="モデル構造（要素数・ノード数）が異なるため比較できません"
        style={{
          background: COLORS.surface2, borderRadius: 4, padding: '8px 4px',
          textAlign: 'center', fontFamily: 'JetBrains Mono', fontSize: 12,
          color: COLORS.textMuted, border: '2px solid transparent',
        }}>
        —
      </div>
    );
  }
  const alpha = Math.round(v * 220).toString(16).padStart(2, '0');
  const isHigh = v >= 0.7;
  return (
    <div style={{
      background: COLORS.accent + alpha, borderRadius: 4, padding: '8px 4px',
      textAlign: 'center', fontFamily: 'JetBrains Mono', fontSize: 12,
      fontWeight: isHigh ? 700 : 400, color: v > 0.45 ? '#fff' : COLORS.text,
      border: isHigh ? `2px solid ${COLORS.textBright}` : '2px solid transparent',
    }}>
      {v.toFixed(2)}
    </div>
  );
}

function FragmentRow({ i, ma, row, bestIdx }) {
  return (
    <>
      <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono' }}>
        A{i + 1}<br />{ma.freq.toFixed(0)}Hz
      </div>
      {(row || []).map((v, j) => (
        <div key={j} style={j === bestIdx ? { outline: `2px solid ${COLORS.textBright}`, borderRadius: 4 } : undefined}>
          <MacCell v={v} />
        </div>
      ))}
    </>
  );
}

function ShapeCompareRow({ i, ma, modesB, nodePositions, bearingPos, diskPos, recommendedIdx, incomparable = false, nearestFreqIdxForRow, macRow, isLast }) {
  const [selected, setSelected] = useState(recommendedIdx);
  // ユーザーが同じ行で明示的に別のBモードを選び直すまでは、常に最新の推奨（MAC最良）を表示する
  const [userPicked, setUserPicked] = useState(false);
  useEffect(() => { setSelected(recommendedIdx); setUserPicked(false); }, [recommendedIdx]);
  const effectiveSelected = userPicked ? Math.min(selected, modesB.length - 1) : recommendedIdx;

  const yA = extractY(ma.mode);
  const selB = modesB[effectiveSelected];
  const ySel = selB ? alignSign(yA, extractY(selB.mode)) : [];

  return (
    <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: isLast ? 'none' : `1px solid ${COLORS.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.accent }}>
          A{i + 1}（{ma.freq.toFixed(0)}Hz）
        </span>
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>と比べる：</span>
        {modesB.map((mb, j) => {
          const isSel = j === effectiveSelected;
          const isRec = !incomparable && j === recommendedIdx;
          const isFreqNearest = j === nearestFreqIdxForRow;
          return (
            <button
              key={j}
              onClick={() => { setSelected(j); setUserPicked(true); }}
              style={{
                padding: '3px 8px', fontSize: 10, fontFamily: 'JetBrains Mono', borderRadius: 5,
                background: isSel ? COLORS.accent + '22' : 'transparent',
                color: isSel ? COLORS.accent : COLORS.textMuted,
                border: `1px solid ${isSel ? COLORS.accent + '88' : COLORS.border}`,
                display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, cursor: 'pointer',
              }}>
              <span>B{j + 1} {mb.freq.toFixed(0)}Hz</span>
              {(isRec || isFreqNearest) && (
                <span style={{ fontSize: 8, color: isRec ? COLORS.success : COLORS.warning }}>
                  {isRec ? '推奨' : ''}{isRec && isFreqNearest ? '・' : ''}{isFreqNearest ? '周波数近' : ''}
                </span>
              )}
            </button>
          );
        })}
        {userPicked && (
          <button
            onClick={() => setUserPicked(false)}
            style={{ padding: '3px 8px', fontSize: 10, color: COLORS.textMuted, background: 'transparent', border: `1px dashed ${COLORS.border}`, borderRadius: 5, cursor: 'pointer' }}>
            推奨に戻す
          </button>
        )}
        <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: COLORS.textMuted, marginLeft: 'auto' }}>
          MAC = <b style={{ color: COLORS.textBright }}>
            {macRow[effectiveSelected] === null || macRow[effectiveSelected] === undefined
              ? '—（比較不可）'
              : macRow[effectiveSelected].toFixed(2)}
          </b>
        </span>
      </div>
      <ModeShapeSvg
        nodePositions={nodePositions}
        curves={[{ y: yA, color: COLORS.accent }, { y: ySel, color: COLORS.danger, dash: '5,4' }]}
        bearingPos={bearingPos} diskPos={diskPos}
        width={300} height={76}
      />
    </div>
  );
}

function ModeList({ modes, color, nodePositions, bearingPos, diskPos }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {modes.map((m, i) => (
        <div key={i} style={{ background: COLORS.surface, borderRadius: 4, padding: '6px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'JetBrains Mono', fontSize: 12, marginBottom: 4 }}>
            <span style={{ color }}>Mode {i + 1}</span>
            <span style={{ color: COLORS.textBright, fontWeight: 700 }}>{m.freq.toFixed(1)} Hz</span>
          </div>
          <ModeShapeSvg
            nodePositions={nodePositions}
            curves={[{ y: extractY(m.mode), color }]}
            bearingPos={bearingPos} diskPos={diskPos}
            width={220} height={64}
          />
        </div>
      ))}
    </div>
  );
}
