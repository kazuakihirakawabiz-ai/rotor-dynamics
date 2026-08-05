import { useState, useEffect, useRef } from "react";
import { assembleSystem, matAdd } from "../analysis/femCore.js";
import { solveEigenvalue } from "../analysis/eigenvalue.js";
import { COLORS } from "./charts/chartTheme.js";
import { StiffnessSweepChart } from "./charts/StiffnessSweepChart.jsx";

const MODE_COLORS = [COLORS.danger, COLORS.warning, '#A78BFA', COLORS.success, '#F472B6'];

// 軸受の「実際の値」を中心に、log10で±2.5桁（3〜11の範囲にクランプ）を掃引レンジとする。
// 軸受ごとに実際の剛性の桁が大きく異なりうる（転がり軸受 vs すべり軸受など）ため、
// 全軸受共通の固定レンジだと実際値が範囲の端や外に来て見づらくなることへの対応。
function computeLogRange(actualK) {
  const k = actualK > 0 ? actualK : 1e7;
  const center = Math.log10(k);
  return { min: Math.max(3, center - 2.5), max: Math.min(11, center + 2.5) };
}

// 掃引データ(logK昇順)から、任意のlogKにおけるfreqsを線形補間で求める共通ヘルパー。
function interpolateFreqs(sweep, logK) {
  if (!sweep || sweep.length === 0 || logK == null) return [];
  if (logK <= sweep[0].logK) return sweep[0].freqs;
  if (logK >= sweep[sweep.length - 1].logK) return sweep[sweep.length - 1].freqs;
  for (let i = 0; i < sweep.length - 1; i++) {
    if (logK >= sweep[i].logK && logK <= sweep[i + 1].logK) {
      const span = sweep[i + 1].logK - sweep[i].logK || 1;
      const t = (logK - sweep[i].logK) / span;
      const n = Math.max(sweep[i].freqs.length, sweep[i + 1].freqs.length);
      const out = [];
      for (let m = 0; m < n; m++) {
        const a = sweep[i].freqs[m], b = sweep[i + 1].freqs[m];
        out.push(a != null && b != null ? a + (b - a) * t : (a ?? b ?? null));
      }
      return out;
    }
  }
  return sweep[sweep.length - 1].freqs;
}

/**
 * ①-1固有値解析タブに内包する「軸受剛性感度解析」（Pro限定機能）。
 *
 * 【全軸受を横並びスライダーで出す設計】以前はグラフのX軸になる軸受を選ぶボタン列を別に
 * 持っていたが、スライダー自体が全軸受ぶん常に見えているなら選ぶ場所が2箇所になり冗長
 * （ユーザー指摘により変更）。今はスライダーのラベル部分をクリックすると、その軸受が
 * 「グラフのX軸（アクティブ）」になる。つまみを動かす操作とアクティブ切り替えは分離しており、
 * 値を動かしただけでは勝手にグラフの軸が入れ替わらない（誤操作防止）。
 *
 * 【ドラッグ中は補間・指を離した時だけ自動再計算】掃引は1点ごとにassembleSystem→
 * solveEigenvalueを行うため、毎フレーム再計算するとカクつく。ドラッグ中はどのスライダーも
 * 表示上の数値・つまみ位置だけを更新し（軽い）、pointerup/mouseupで実際に指を離した時に、
 * その時点の全軸受のWhat-if値を反映してアクティブ軸受のグラフを自動で再計算する
 * （ユーザー指示：都度自動再計算・ただしドラッグ中のカクつきは避ける、の折衷案）。
 *
 * 【非アクティブ軸受のWhat-if値もsolveEigenvalueに効かせている点】グラフのX軸はアクティブ
 * 軸受の剛性だが、他の軸受も「今それぞれのスライダーで設定されているWhat-if値」に固定して
 * assembleSystemに渡している。そのため「軸受Aを軟らかくしつつ軸受Bも硬くしたら」という
 * 複合的な感度も見られる（片方ずつしか見られない、という以前の制約を解消）。
 *
 * 【2026-08-05 追記・レイアウトとちらつきの修正】
 * - グラフを上・スライダーを下の順に変更（以前は逆で読みづらいという指摘）。
 * - 再計算中（loading）にグラフ全体を「計算中...」の1行へ丸ごと差し替えるのをやめ、
 *   直前の掃引結果を表示したまま右上に小さく「更新中...」を出すだけにした
 *   （stale-while-revalidate）。以前の実装は、再計算のたびにコンテンツの高さが
 *   大きく縮んでから伸びるため、右パネル(overflow:auto)のスクロール位置が
 *   ブラウザによって一番上まで戻されてしまっていた（ユーザー指摘により変更）。
 * - 非アクティブ軸受（例:軸受B）を動かした時、グラフのX軸はアクティブ軸受の剛性のため
 *   B自身の値をX軸上の点として置くことはできない（別軸受・別の値のため）。代わりに
 *   チャート内の余白にBの現在値を数値バッジとしてライブ表示するようにした
 *   （ドラッグ中でも軽い描画のみなので、都度更新して問題ない）。
 */
export function BearingStiffnessSweep({ shaftElems, materials, disks, bearings, settings, isPaidPlan, onUpgradeClick }) {
  const [activeBearingId, setActiveBearingId] = useState(bearings?.[0]?.id ?? null);
  const [whatIfLogK, setWhatIfLogK] = useState({}); // { [bearingId]: logK }（触っていない軸受は未登録＝実際値扱い）
  const [logRangeMap, setLogRangeMap] = useState({}); // { [bearingId]: {min,max} }
  const [sweep, setSweep] = useState(null); // アクティブ軸受用の掃引結果 [{k, logK, freqs}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const staleRef = useRef(false); // モデル本体が編集されて掃引結果が古くなったことを示すフラグ
  const draggingRef = useRef(false); // ドラッグ中かどうか（pointerup判定の補助）

  // 軸受一覧・実際の剛性値が変わったら、レンジとWhat-if初期値を（未登録分だけ）補う
  useEffect(() => {
    if (!bearings || bearings.length === 0) { setActiveBearingId(null); return; }
    if (!bearings.some(b => b.id === activeBearingId)) setActiveBearingId(bearings[0].id);
    setLogRangeMap(prev => {
      const next = { ...prev };
      bearings.forEach(b => { if (!next[b.id]) next[b.id] = computeLogRange(b.kxx); });
      return next;
    });
    setWhatIfLogK(prev => {
      const next = { ...prev };
      bearings.forEach(b => { if (next[b.id] == null) next[b.id] = Math.log10(b.kxx > 0 ? b.kxx : 1e7); });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bearings]);

  // モデル本体（形状・ディスク・軸受構成・設定）が変わったら「グラフは古い」ことだけ記録する
  // （自動では再計算しない。掃引を丸ごとやり直すのは重いため、モデル編集のたびには行わない）。
  useEffect(() => {
    staleRef.current = sweep != null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaftElems, materials, disks, bearings, settings]);

  const yieldToPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  // アクティブ軸受の剛性をX軸にした掃引を計算する。他の軸受は現時点のWhat-if値（未設定なら実際値）で固定。
  const runSweep = async (targetBearingId, whatIfSnapshot) => {
    const bearing = (bearings || []).find(b => b.id === targetBearingId);
    if (!bearing || !shaftElems || !materials || !settings) return;
    setLoading(true);
    setError(null);
    await yieldToPaint();
    try {
      const resolveMat = (materialId) =>
        materials.find(x => x.id === materialId) || materials[0] || { youngMod: 200, density: 8190 };
      const shaftElemsResolved = shaftElems.map(el => {
        const mat = resolveMat(el.materialId);
        return { ...el, youngMod: mat.youngMod, density: mat.density };
      });

      const range = logRangeMap[targetBearingId] || computeLogRange(bearing.kxx);
      const { min: logMin, max: logMax } = range;
      const nPoints = 50;
      const nModes = settings.nModes;

      const points = [];
      for (let i = 0; i < nPoints; i++) {
        const logK = logMin + (logMax - logMin) * i / (nPoints - 1);
        const sweptBearings = (bearings || []).map(b => {
          if (b.id === targetBearingId) {
            const k = Math.pow(10, logK);
            return { ...b, kxx: k, kyy: k };
          }
          const otherLogK = whatIfSnapshot[b.id];
          if (otherLogK == null) return b; // 未設定＝実際値のまま
          const k = Math.pow(10, otherLogK);
          return { ...b, kxx: k, kyy: k };
        });
        const sys = assembleSystem(shaftElemsResolved, disks || [], sweptBearings);
        const Ktotal = matAdd(sys.K, sys.Kb);
        const modes = solveEigenvalue(sys.M, Ktotal, nModes);
        points.push({ k: Math.pow(10, logK), logK, freqs: modes.map(m => m.freq) });
      }
      setSweep(points);
      staleRef.current = false;
    } catch (e) {
      setError(e?.message || String(e) || '計算に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  // アクティブ軸受を切り替えたら、その軸受用に自動で計算し直す（他軸受は現在のWhat-if値のまま）
  useEffect(() => {
    if (!isPaidPlan || !activeBearingId) return;
    runSweep(activeBearingId, whatIfLogK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBearingId, isPaidPlan]);

  // どれかのスライダーで指を離した時：その時点の全What-if値でアクティブ軸受のグラフを再計算
  const handleSliderRelease = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (activeBearingId) runSweep(activeBearingId, whatIfLogK);
  };

  if (!isPaidPlan) {
    return (
      <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 6 }}>
          軸受剛性 感度解析 <span style={{ fontSize: 10, color: COLORS.textMuted, fontWeight: 400 }}>Pro限定機能</span>
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6, marginBottom: 10 }}>
          軸受剛性を仮に変えた場合に、各次数の固有振動数がどう変化するかをグラフとスライダーで確認できます。
        </div>
        <button onClick={onUpgradeClick} style={{
          padding: '8px 16px', fontSize: 12, fontWeight: 600,
          background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
        }}>
          Proにアップグレード
        </button>
      </div>
    );
  }

  if (!bearings || bearings.length === 0) {
    return (
      <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 6 }}>軸受剛性 感度解析</div>
        <div style={{ fontSize: 11, color: COLORS.textMuted }}>軸受が定義されていません。左パネルで軸受を追加してください。</div>
      </div>
    );
  }

  const activeBearing = bearings.find(b => b.id === activeBearingId) || null;
  const activeLogK = whatIfLogK[activeBearingId];
  const actualLogK = activeBearing && activeBearing.kxx > 0 ? Math.log10(activeBearing.kxx) : null;
  const interpolatedFreqs = interpolateFreqs(sweep, activeLogK);
  const actualFreqs = interpolateFreqs(sweep, actualLogK);
  const activeK = activeLogK != null ? Math.pow(10, activeLogK) : null;

  // 非アクティブ軸受の「今のWhat-if値」。グラフのX軸はアクティブ軸受の剛性なので、他の軸受の値を
  // 同じ軸上に点として置くこと自体ができない（単位・意味が異なる別軸受の値のため）。
  // そのため、X軸上のマーカーではなく、チャート内の余白（凡例エリア）に数値バッジとして
  // ライブ表示する（軸受Bのスライダーを動かすたびに、ドラッグ中でも軽く更新される）。
  const otherBearingBadges = bearings
    .filter(b => b.id !== activeBearingId)
    .map((b, i) => {
      const logK = whatIfLogK[b.id] ?? Math.log10(b.kxx > 0 ? b.kxx : 1e7);
      return { name: b.name || `軸受#${i + 1}`, k: Math.pow(10, logK) };
    });

  return (
    <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 4 }}>軸受剛性 感度解析</div>
      <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 14, lineHeight: 1.6 }}>
        軸受ごとにWhat-ifの剛性(Kxx=Kyy)を設定できます。ラベルをクリックした軸受がグラフのX軸（アクティブ）になり、
        他の軸受はそれぞれのスライダー値に固定した状態で計算されます（複数軸受を同時に変えた場合の感度も見られます）。
        ドラッグ中は軽い補間表示、指を離すとその時点の全軸受の値で自動的に再計算します。
      </div>

      {staleRef.current && !loading && (
        <div style={{ fontSize: 10, color: COLORS.warning, marginBottom: 10 }}>
          ※ モデルが編集されています。グラフはまだ編集前の構成のままです（スライダーを少し動かすと最新の構成で再計算されます）。
        </div>
      )}

      {error ? (
        <div style={{ fontSize: 11, color: COLORS.danger, padding: '12px 0' }}>{error}</div>
      ) : !sweep ? (
        // 初回読み込みのみ、この高さのプレースホルダーを出す（以降は下のstale-while-revalidateに切り替わる）
        <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0', minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {loading ? '掃引計算中...' : '準備中...'}
        </div>
      ) : (
        <>
          {/* 再計算中も直前のグラフをそのまま表示し続ける（stale-while-revalidate）。
              以前はここを「計算中...」の1行に丸ごと差し替えていたが、それだと右パネル
              (overflow:auto)のコンテンツ高さが一瞬大きく縮んでから伸びるため、ブラウザが
              スクロール位置を一番上まで戻してしまっていた（ユーザー指摘により変更）。 */}
          <div style={{ position: 'relative' }}>
            {loading && (
              <div style={{
                position: 'absolute', top: 4, right: 4, zIndex: 1,
                fontSize: 9, padding: '3px 8px', borderRadius: 4,
                background: COLORS.surface2, color: COLORS.textMuted,
                border: `1px solid ${COLORS.border}`,
              }}>
                更新中...
              </div>
            )}
            <StiffnessSweepChart
              sweep={sweep}
              currentLogK={activeLogK}
              actualLogK={actualLogK}
              otherBearings={otherBearingBadges}
              nModes={settings.nModes}
              width={640} height={300}
            />
          </div>

          {/* 現在の設定 vs What-if（アクティブ軸受についてのみ表示） */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 9, color: COLORS.success, marginBottom: 4 }}>
                現在の設定（{activeBearing?.name || '軸受'}: {activeBearing?.kxx?.toExponential(1)} N/m）
              </div>
              {actualFreqs.map((f, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: MODE_COLORS[i % MODE_COLORS.length] }}>
                  M{i + 1}: {f != null ? f.toFixed(1) : '—'} Hz
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 9, color: COLORS.accent, marginBottom: 4 }}>
                What-if（{activeBearing?.name || '軸受'}: {activeK != null ? activeK.toExponential(1) : '—'} N/m）
              </div>
              {interpolatedFreqs.map((f, i) => {
                const base = actualFreqs[i];
                const diffPct = (f != null && base) ? ((f - base) / base * 100) : null;
                return (
                  <div key={i} style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: MODE_COLORS[i % MODE_COLORS.length] }}>
                    M{i + 1}: {f != null ? f.toFixed(1) : '—'} Hz
                    {diffPct != null && (
                      <span style={{ color: COLORS.textMuted }}> ({diffPct >= 0 ? '+' : ''}{diffPct.toFixed(1)}%)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* 全軸受のWhat-ifスライダーを横並び（グラフの下に移動。以前はグラフより上にあったが、
          「まずグラフが見えて、下に操作パネルがある」方が読みやすいというユーザー指摘により変更） */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {bearings.map((b, i) => {
          const isActive = b.id === activeBearingId;
          const range = logRangeMap[b.id] || computeLogRange(b.kxx);
          const logK = whatIfLogK[b.id] ?? Math.log10(b.kxx > 0 ? b.kxx : 1e7);
          const k = Math.pow(10, logK);
          return (
            <div key={b.id} style={{ flex: '1 1 200px', minWidth: 200 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span
                  onClick={() => setActiveBearingId(b.id)}
                  title="クリックでこの軸受をグラフのX軸にする"
                  style={{
                    cursor: 'pointer', fontSize: 11, fontWeight: isActive ? 700 : 400,
                    color: isActive ? COLORS.accent : COLORS.textMuted,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  {b.name || `軸受#${i + 1}`}
                  {isActive && (
                    <span style={{ fontSize: 8, padding: '1px 6px', borderRadius: 3, background: COLORS.accent + '22', color: COLORS.accent }}>
                      グラフ表示中
                    </span>
                  )}
                </span>
                <span style={{
                  fontSize: 11, fontFamily: 'JetBrains Mono', fontWeight: 700,
                  color: isActive ? COLORS.accent : COLORS.textMuted,
                }}>
                  {k.toExponential(2)} N/m
                </span>
              </div>
              <input
                type="range"
                min={range.min} max={range.max} step={0.02}
                value={logK}
                onPointerDown={() => { draggingRef.current = true; }}
                onMouseDown={() => { draggingRef.current = true; }}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setWhatIfLogK(prev => ({ ...prev, [b.id]: v }));
                }}
                onPointerUp={handleSliderRelease}
                onMouseUp={handleSliderRelease}
                style={{ width: '100%', accentColor: isActive ? COLORS.accent : COLORS.textMuted }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
