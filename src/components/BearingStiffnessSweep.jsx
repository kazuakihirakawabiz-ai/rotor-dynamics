import { useState, useEffect, useRef } from "react";
import { assembleSystem, matAdd } from "../analysis/femCore.js";
import { solveEigenvalue } from "../analysis/eigenvalue.js";
import { COLORS } from "./charts/chartTheme.js";
import { StiffnessSweepChart } from "./charts/StiffnessSweepChart.jsx";

/**
 * ①-1固有値解析タブに内包する「軸受剛性感度解析」（Pro限定機能）。
 *
 * 【比較タブ群(①-2/②-3/③-2)との違い】あちらはクラウド保存済みプロジェクト同士を比較するが、
 * これは「今エディタで開いているモデル」に対して、軸受剛性を仮に変えたら固有振動数がどう動くかを
 * 見るツール。model_dataの取得は不要で、App.jsx本体から渡されるshaftElems/materials/disks/
 * bearings/settingsをそのまま使う（Supabase通信なし）。
 *
 * 【再計算を自動(useMemo)ではなく明示ボタンにしている理由】掃引は1点ごとにassembleSystem→
 * solveEigenvalueを行うため、50点の掃引はCampbell線図1本分に匹敵する重さになりうる。
 * 左パネルで無関係な値（ディスク質量など）を編集するたびに毎回自動再計算すると、このタブを
 * 開いたままモデルを編集した時にUIが固まりかねない。本体の「解析実行」ボタンと同じ思想で、
 * 軸受選択の切り替え・明示的な「このモデル構成で計算」ボタン押下の時だけ計算する。
 *
 * 【スライダー操作時は補間で済ませている理由】ドラッグ中に毎回solveEigenvalueを呼ぶと重くて
 * カクつくため、事前計算済みの掃引点(50点)の間をlogK軸で線形補間するだけにしている。
 * 50点あれば曲線はなめらかなので、補間による誤差は実用上問題にならない。
 */
export function BearingStiffnessSweep({ shaftElems, materials, disks, bearings, settings, isPaidPlan, onUpgradeClick }) {
  const [selectedBearingId, setSelectedBearingId] = useState(bearings?.[0]?.id ?? null);
  const [logRange, setLogRange] = useState(null); // { min, max }（選択中の軸受の実際値を中心に自動設定）
  const [sweep, setSweep] = useState(null); // [{k, logK, freqs}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentLogK, setCurrentLogK] = useState(null); // what-ifスライダーの現在位置
  const staleRef = useRef(false); // モデルが編集されて掃引結果が古くなったことを示すフラグ

  const selectedBearing = (bearings || []).find(b => b.id === selectedBearingId) || null;

  // 軸受一覧が変わったら選択を追従させる（選択中の軸受が削除された場合など）
  useEffect(() => {
    if (!bearings || bearings.length === 0) { setSelectedBearingId(null); return; }
    if (!bearings.some(b => b.id === selectedBearingId)) {
      setSelectedBearingId(bearings[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bearings]);

  // モデル本体（shaftElems/disks/bearings/materials/settings）が変わったら、
  // 掃引結果は「今の構成を反映していない」古い状態になったことだけ記録する（自動再計算はしない）。
  useEffect(() => {
    staleRef.current = sweep != null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaftElems, materials, disks, bearings, settings]);

  const yieldToPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  const runSweep = async (bearingId) => {
    const bearing = (bearings || []).find(b => b.id === bearingId);
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

      // 掃引範囲は、選択中の軸受の「今の実際の剛性」を中心に5桁分（logで±2.5）を自動で取る。
      // 軸受ごとに実際の剛性の桁が大きく異なりうる（例：転がり軸受 vs すべり軸受）ため、
      // 全軸受共通の固定レンジ（例えば常に1e5〜1e9）だと、実際の値が範囲の端や外に来て
      // 見づらくなるケースがあるための対応。
      const actualK = bearing.kxx > 0 ? bearing.kxx : 1e7;
      const logCenter = Math.log10(actualK);
      const logMin = Math.max(3, logCenter - 2.5);
      const logMax = Math.min(11, logCenter + 2.5);
      setLogRange({ min: logMin, max: logMax });

      const nPoints = 50;
      const nModes = settings.nModes;
      const points = [];
      for (let i = 0; i < nPoints; i++) {
        const logK = logMin + (logMax - logMin) * i / (nPoints - 1);
        const k = Math.pow(10, logK);
        const sweptBearings = (bearings || []).map(b => b.id === bearingId ? { ...b, kxx: k, kyy: k } : b);
        const sys = assembleSystem(shaftElemsResolved, disks || [], sweptBearings);
        const Ktotal = matAdd(sys.K, sys.Kb);
        const modes = solveEigenvalue(sys.M, Ktotal, nModes);
        points.push({ k, logK, freqs: modes.map(m => m.freq) });
      }
      setSweep(points);
      setCurrentLogK(logCenter); // 初期位置は「現在の設定」と同じところから始める
      staleRef.current = false;
    } catch (e) {
      setError(e?.message || String(e) || '計算に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  // 軸受の選択を切り替えたら、その軸受用に自動で計算し直す
  useEffect(() => {
    if (!isPaidPlan || !selectedBearingId) return;
    runSweep(selectedBearingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBearingId, isPaidPlan]);

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

  // currentLogKにおける固有振動数を、掃引データから線形補間で求める（ドラッグ中の軽量な読み出し用）
  const interpolatedFreqs = (() => {
    if (!sweep || sweep.length === 0 || currentLogK == null) return [];
    if (currentLogK <= sweep[0].logK) return sweep[0].freqs;
    if (currentLogK >= sweep[sweep.length - 1].logK) return sweep[sweep.length - 1].freqs;
    for (let i = 0; i < sweep.length - 1; i++) {
      if (currentLogK >= sweep[i].logK && currentLogK <= sweep[i + 1].logK) {
        const span = sweep[i + 1].logK - sweep[i].logK || 1;
        const t = (currentLogK - sweep[i].logK) / span;
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
  })();

  const actualLogK = selectedBearing && selectedBearing.kxx > 0 ? Math.log10(selectedBearing.kxx) : null;
  const actualFreqs = (() => {
    if (!sweep || actualLogK == null) return [];
    // interpolatedFreqsと同じロジックをactualLogKに対して評価する（重複だが数点の計算なので許容）
    if (actualLogK <= sweep[0].logK) return sweep[0].freqs;
    if (actualLogK >= sweep[sweep.length - 1].logK) return sweep[sweep.length - 1].freqs;
    for (let i = 0; i < sweep.length - 1; i++) {
      if (actualLogK >= sweep[i].logK && actualLogK <= sweep[i + 1].logK) {
        const span = sweep[i + 1].logK - sweep[i].logK || 1;
        const t = (actualLogK - sweep[i].logK) / span;
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
  })();

  const currentK = currentLogK != null ? Math.pow(10, currentLogK) : null;
  const MODE_COLORS = [COLORS.danger, COLORS.warning, '#A78BFA', COLORS.success, '#F472B6'];

  return (
    <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 4 }}>軸受剛性 感度解析</div>
      <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
        選択した軸受のKxx=Kyyを仮に変えた場合に、固有振動数がどう変化するかを事前計算した掃引グラフです。
        スライダーは掃引データの補間なので軽く動きますが、グラフ自体（曲線・範囲）は軸受を切り替えた時か
        「このモデル構成で再計算」を押した時だけ更新されます。
      </div>

      {/* 軸受選択 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {bearings.map((b, i) => (
          <button key={b.id} onClick={() => setSelectedBearingId(b.id)} style={{
            fontSize: 11, padding: '5px 12px', borderRadius: 6,
            fontWeight: b.id === selectedBearingId ? 700 : 400,
            background: b.id === selectedBearingId ? COLORS.accent : COLORS.surface2,
            color: b.id === selectedBearingId ? '#fff' : COLORS.text,
            border: `1px solid ${b.id === selectedBearingId ? COLORS.accent : COLORS.border}`,
            cursor: 'pointer',
          }}>
            {b.name || `軸受#${i + 1}`}
          </button>
        ))}
        <button
          onClick={() => runSweep(selectedBearingId)}
          disabled={loading || !selectedBearingId}
          style={{
            fontSize: 11, padding: '5px 12px', borderRadius: 6,
            background: 'transparent', color: COLORS.textMuted,
            border: `1px solid ${COLORS.border}`, cursor: loading ? 'not-allowed' : 'pointer',
            marginLeft: 'auto',
          }}>
          {loading ? '計算中...' : staleRef.current ? '↻ このモデル構成で再計算' : '↻ 再計算'}
        </button>
      </div>

      {staleRef.current && !loading && (
        <div style={{ fontSize: 10, color: COLORS.warning, marginBottom: 10 }}>
          ※ モデルが編集されています。このグラフはまだ編集前の構成のままです。再計算すると反映されます。
        </div>
      )}

      {error ? (
        <div style={{ fontSize: 11, color: COLORS.danger, padding: '12px 0' }}>{error}</div>
      ) : loading || !sweep ? (
        <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '12px 0' }}>
          {loading ? '掃引計算中...' : '準備中...'}
        </div>
      ) : (
        <>
          <StiffnessSweepChart
            sweep={sweep}
            currentLogK={currentLogK}
            actualLogK={actualLogK}
            nModes={settings.nModes}
            width={640} height={300}
          />

          {/* What-ifスライダー */}
          <div style={{ marginTop: 12, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>What-if: {selectedBearing?.name || '軸受'} 剛性 (Kxx=Kyy)</span>
              <span style={{ fontSize: 11, color: COLORS.accent, fontFamily: 'JetBrains Mono', fontWeight: 700 }}>
                {currentK != null ? currentK.toExponential(2) : '—'} N/m
              </span>
            </div>
            <input
              type="range"
              min={logRange?.min ?? 3} max={logRange?.max ?? 11} step={0.02}
              value={currentLogK ?? 7}
              onChange={e => setCurrentLogK(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: COLORS.accent }}
            />
          </div>

          {/* 現在の設定 vs What-if の比較 */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: COLORS.success, marginBottom: 4 }}>現在の設定（{selectedBearing?.kxx?.toExponential(1)} N/m）</div>
              {actualFreqs.map((f, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: MODE_COLORS[i % MODE_COLORS.length] }}>
                  M{i + 1}: {f != null ? f.toFixed(1) : '—'} Hz
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 9, color: COLORS.accent, marginBottom: 4 }}>What-if（{currentK != null ? currentK.toExponential(1) : '—'} N/m）</div>
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
    </div>
  );
}
