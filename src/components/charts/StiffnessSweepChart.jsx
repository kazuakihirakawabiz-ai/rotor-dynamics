// ─── Bearing Stiffness Sweep Chart（軸受剛性感度解析タブ用）───
// LineChart.jsx（①固有値解析のモード一覧、③周波数応答等で使う汎用折れ線グラフ）は
// x軸が線形固定（目盛りラベルもMath.round(x)決め打ち）で、剛性のように桁が4〜5桁変わる値を
// 軸に取るのには向かない。CampbellDiagramOverlay.jsxを専用コンポーネントとして切り出した時と
// 同じ判断で、log10軸の描画・目盛りフォーマット・「何かの位置に垂直マーカーを立てる」機能を
// 持った専用チャートとしてここに新設した。
import { useState, useEffect, useRef } from "react";
import { COLORS } from "./chartTheme.js";

// モード番号ごとの色分け。App.jsx本体の③周波数応答タブが使っているmodeColorsパレットと揃えている。
const MODE_COLORS = [COLORS.danger, COLORS.warning, '#A78BFA', COLORS.success, '#F472B6'];

function formatK(k) {
  return k.toExponential(1) + ' N/m';
}

/**
 * @param {{k:number, logK:number, freqs:number[]}[]} sweep 掃引結果（logK昇順）
 * @param {number} currentLogK what-ifスライダーの現在位置（log10）
 * @param {number} actualLogK 現在保存されているモデルの実際の剛性（log10）。スライダーと別に固定マーカーとして表示
 * @param {number} nModes 描画するモード数（sweepの各点のfreqs配列の長さと一致させる）
 */
export function StiffnessSweepChart({ sweep, currentLogK, actualLogK, nModes, width = 640, height = 300 }) {
  const canvasRef = useRef();
  const scaleRef = useRef(null);
  const [hoverPt, setHoverPt] = useState(null);

  useEffect(() => {
    if (!sweep || sweep.length === 0) return;
    const canvas = canvasRef.current;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = '100%';
      canvas.style.maxWidth = width + 'px';
      const W = canvas.clientWidth || width;
      canvas.width = W * dpr; canvas.height = height * dpr;
      canvas.style.height = height + 'px';
      ctx.scale(dpr, dpr);
      ctx.fillStyle = COLORS.surface; ctx.fillRect(0, 0, W, height);

      const pad = { top: 30, right: 20, bottom: 45, left: 65 };
      const pw = W - pad.left - pad.right;
      const ph = height - pad.top - pad.bottom;

      const logMin = sweep[0].logK, logMax = sweep[sweep.length - 1].logK;
      const allFreqs = sweep.flatMap(pt => pt.freqs.filter(f => isFinite(f)));
      const freqMax = (Math.max(...allFreqs, 1) * 1.1);
      const freqMin = 0;

      const tx = logK => pad.left + (logK - logMin) / ((logMax - logMin) || 1) * pw;
      const ty = f => pad.top + ph - (f - freqMin) / ((freqMax - freqMin) || 1) * ph;

      scaleRef.current = { pad, pw, ph, logMin, logMax, freqMin, freqMax, tx, ty, sweep, nModes };

      // Grid（横）
      ctx.strokeStyle = COLORS.border + '55'; ctx.lineWidth = 0.5;
      for (let i = 0; i <= 5; i++) {
        const f = freqMin + (freqMax - freqMin) * i / 5;
        ctx.beginPath(); ctx.moveTo(pad.left, ty(f)); ctx.lineTo(pad.left + pw, ty(f)); ctx.stroke();
      }
      // Grid（縦・log軸の1桁ごと）
      const decadeStart = Math.ceil(logMin), decadeEnd = Math.floor(logMax);
      for (let d = decadeStart; d <= decadeEnd; d++) {
        ctx.beginPath(); ctx.moveTo(tx(d), pad.top); ctx.lineTo(tx(d), pad.top + ph); ctx.stroke();
      }

      // Axes
      ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

      // Y labels
      ctx.fillStyle = COLORS.textMuted; ctx.font = '10px JetBrains Mono'; ctx.textAlign = 'right';
      for (let i = 0; i <= 5; i++) {
        const f = freqMin + (freqMax - freqMin) * i / 5;
        ctx.fillText(f.toFixed(0), pad.left - 6, ty(f) + 4);
      }
      // X labels（10^dの形。指数表記でないと桁数が読めないため専用フォーマット）
      ctx.textAlign = 'center';
      for (let d = decadeStart; d <= decadeEnd; d++) {
        ctx.fillText(`1e${d}`, tx(d), pad.top + ph + 15);
      }
      ctx.fillStyle = COLORS.textMuted; ctx.font = '10px Inter';
      ctx.fillText('軸受剛性 Kxx=Kyy [N/m]（log軸）', pad.left + pw / 2, height - 5);
      ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText('固有振動数 [Hz]', 0, 0); ctx.restore();
      ctx.fillStyle = COLORS.textBright; ctx.font = '500 11px Inter'; ctx.textAlign = 'left';
      ctx.fillText('軸受剛性 感度解析', pad.left, 18);

      // モード曲線
      for (let m = 0; m < nModes; m++) {
        ctx.strokeStyle = MODE_COLORS[m % MODE_COLORS.length]; ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false, lastPt = null;
        sweep.forEach(pt => {
          if (pt.freqs[m] == null) return;
          const x = tx(pt.logK), y = ty(pt.freqs[m]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          lastPt = { x, y };
        });
        ctx.stroke();
        if (lastPt) {
          ctx.fillStyle = MODE_COLORS[m % MODE_COLORS.length]; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
          ctx.fillText(`M${m + 1}`, lastPt.x + 3, lastPt.y + 3);
        }
      }

      // 「現在の設定」固定マーカー（実際に保存されている剛性値。textMutedより少し目立つ色に）
      if (actualLogK != null && actualLogK >= logMin && actualLogK <= logMax) {
        const ax = tx(actualLogK);
        ctx.strokeStyle = COLORS.success + 'AA'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(ax, pad.top); ctx.lineTo(ax, pad.top + ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.success; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'center';
        ctx.fillText('現在の設定', ax, pad.top - 4);
      }

      // What-ifスライダーの垂直マーカー（accent色・破線）
      if (currentLogK != null && currentLogK >= logMin && currentLogK <= logMax) {
        const cx = tx(currentLogK);
        ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(cx, pad.top); ctx.lineTo(cx, pad.top + ph); ctx.stroke();
        ctx.setLineDash([]);
      }

      // ホバー時のクロスヘア
      if (hoverPt && hoverPt.px >= pad.left && hoverPt.px <= pad.left + pw) {
        ctx.strokeStyle = COLORS.textMuted + '99'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(hoverPt.px, pad.top); ctx.lineTo(hoverPt.px, pad.top + ph); ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [sweep, currentLogK, actualLogK, nModes, width, height, hoverPt]);

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const s = scaleRef.current;
    if (!s) return;
    const mouseLogK = s.logMin + (px - s.pad.left) / s.pw * (s.logMax - s.logMin);
    // 最も近い掃引点にスナップ
    let best = s.sweep[0], bestDist = Infinity;
    s.sweep.forEach(pt => { const d = Math.abs(pt.logK - mouseLogK); if (d < bestDist) { bestDist = d; best = pt; } });
    setHoverPt({ px: s.tx(best.logK), k: best.k, freqs: best.freqs });
  };

  const inPlotArea = (() => {
    if (!hoverPt || !scaleRef.current) return false;
    const s = scaleRef.current;
    return hoverPt.px >= s.pad.left && hoverPt.px <= s.pad.left + s.pw;
  })();

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: width, height }}>
      <canvas
        ref={canvasRef}
        style={{ borderRadius: 6, display: 'block', cursor: 'crosshair', width: '100%', maxWidth: width }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverPt(null)}
      />
      {inPlotArea && (
        <div style={{
          position: 'absolute',
          left: Math.min(hoverPt.px + 12, (canvasRef.current?.clientWidth || width) - 160),
          top: 34,
          background: COLORS.surface2, border: `1px solid ${COLORS.border}`,
          borderRadius: 5, padding: '6px 9px', pointerEvents: 'none',
          fontSize: 10, fontFamily: 'JetBrains Mono', color: COLORS.textBright,
          whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}>
          <div style={{ color: COLORS.accent, fontWeight: 700, marginBottom: 3 }}>{formatK(hoverPt.k)}</div>
          {hoverPt.freqs.map((f, i) => (
            <div key={i} style={{ color: MODE_COLORS[i % MODE_COLORS.length] }}>M{i + 1}: {f.toFixed(1)} Hz</div>
          ))}
        </div>
      )}
    </div>
  );
}
