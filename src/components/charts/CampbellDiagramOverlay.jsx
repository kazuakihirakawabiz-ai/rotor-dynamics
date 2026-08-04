// ─── Campbell Diagram Overlay（比較タブ用：2プロジェクト重ね描き版）───
// 単一データセット前提の CampbellDiagram.jsx（②-2タブで使用）とは別コンポーネントとして新設した。
// 理由：モード曲線の色分け・危険速度の交点計算・ホバー時の最近傍探索・軸スケールが、
// すべて「系列（＝プロジェクト）」単位で二重に必要になり、既存コンポーネントに
// 条件分岐を足し込むより、専用コンポーネントとして持たせた方が見通しが良いと判断したため。
//
// series は [{ campbellData, maxRpm, label, color }, ...] を2件想定。
// モード曲線はモード番号ではなく「系列ごと」に色分けする（基準＝実線、比較対象＝破線）。
// 個々のモード番号を追いたい場合のために、各曲線の右端に小さくモード番号を添えている。
// 危険速度マーカーは基準＝塗りつぶしひし形、比較対象＝白抜きひし形で区別する
// （1X/2X/3Xの次数による色分けは維持したまま、系列は塗り/白抜きで区別する形）。
import { useState, useEffect, useRef } from "react";
import { COLORS, formatAdaptive } from "./chartTheme.js";

export function CampbellDiagramOverlay({ series, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width = 900, height = 340, onCriticalSpeeds }) {
  const canvasRef = useRef();
  const scaleRef = useRef(null);
  const [hoverPt, setHoverPt] = useState(null);

  useEffect(() => {
    if (!series || series.length === 0 || series.some(s => !s.campbellData || s.campbellData.length === 0)) return;
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

      const pad = { top: 34, right: 30, bottom: 45, left: 65 };
      const pw = W - pad.left - pad.right;
      const ph = height - pad.top - pad.bottom;

      const dataMaxFreq = Math.max(
        ...series.flatMap(s => s.campbellData.flatMap(pt => pt.modes.map(m => m.freq)))
      ) * 1.15 || 200;
      const rpmMin = minRpmLim ?? 0;
      const rpmMax = maxRpmLim ?? Math.max(...series.map(s => s.maxRpm));
      const freqMin = minFreqLim ?? 0;
      const freqMax = maxFreqLim ?? dataMaxFreq;
      const tx = rpm => pad.left + (rpm - rpmMin) / (rpmMax - rpmMin || 1) * pw;
      const ty = f   => pad.top + ph - (f - freqMin) / (freqMax - freqMin || 1) * ph;

      scaleRef.current = { pad, pw, ph, rpmMin, rpmMax, freqMin, freqMax, tx, ty, series };

      // Grid
      ctx.strokeStyle = COLORS.border + '44'; ctx.lineWidth = 0.5;
      for (let i = 0; i <= 5; i++) {
        const f = freqMin + (freqMax - freqMin) * i / 5;
        ctx.beginPath(); ctx.moveTo(pad.left, ty(f)); ctx.lineTo(pad.left + pw, ty(f)); ctx.stroke();
      }

      // EO lines (1X, 2X, 3X) — 系列に依らない共通の基準線
      [[1, COLORS.danger], [2, COLORS.warning], [3, '#A78BFA']].forEach(([n, col]) => {
        ctx.strokeStyle = col + 'AA'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(tx(rpmMin), ty(n * rpmMin / 60));
        ctx.lineTo(tx(rpmMax), ty(n * rpmMax / 60)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
        const fx = Math.min(rpmMax, freqMax * 60 / n + rpmMin);
        const fy = n * fx / 60;
        if (fy >= freqMin && fy <= freqMax) ctx.fillText(`${n}X`, tx(fx) + 4, ty(fy) - 4);
      });

      // Mode branches：系列ごとに同一色。1系列目=実線、2系列目=破線
      series.forEach((s, si) => {
        const modeCount = s.campbellData[0]?.modes?.length || 0;
        for (let m = 0; m < modeCount; m++) {
          ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
          ctx.setLineDash(si === 0 ? [] : [5, 3]);
          ctx.beginPath();
          let started = false;
          let lastPt = null;
          s.campbellData.forEach(pt => {
            if (!pt.modes[m]) return;
            const x = tx(pt.rpm), y = ty(pt.modes[m].freq);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            lastPt = { x, y };
          });
          ctx.stroke();
          ctx.setLineDash([]);
          // 曲線の右端にモード番号を薄く添えて、同系列内でどのモードか分かるようにする
          if (lastPt) {
            ctx.fillStyle = s.color; ctx.font = '8px JetBrains Mono'; ctx.textAlign = 'left';
            ctx.fillText(`${m + 1}`, lastPt.x + 2, lastPt.y + 3);
          }
        }
      });

      // ── 危険速度: 1X/2X/3X と、各系列それぞれのモード曲線との交点 ──
      const criticalSpeeds = []; // {rpm, freq, order, modeIdx, seriesIdx, isForward, undampedModeIdx}
      series.forEach((s, si) => {
        const modeCount = s.campbellData[0]?.modes?.length || 0;
        [1, 2, 3].forEach(n => {
          for (let m = 0; m < modeCount; m++) {
            for (let i = 0; i < s.campbellData.length - 1; i++) {
              const pt0 = s.campbellData[i], pt1 = s.campbellData[i + 1];
              if (!pt0.modes[m] || !pt1.modes[m]) continue;
              const rpm0 = pt0.rpm, rpm1 = pt1.rpm;
              const f0 = pt0.modes[m].freq, f1 = pt1.modes[m].freq;
              const modeMeta = { isForward: pt0.modes[m].isForward, undampedModeIdx: pt0.modes[m].undampedModeIdx };
              const g0 = f0 - n * rpm0 / 60;
              const g1 = f1 - n * rpm1 / 60;
              if (g0 === 0) {
                criticalSpeeds.push({ rpm: rpm0, freq: f0, order: n, modeIdx: m, seriesIdx: si, ...modeMeta });
              } else if (g0 * g1 < 0) {
                const t = g0 / (g0 - g1);
                const rpmX = rpm0 + t * (rpm1 - rpm0);
                const freqX = f0 + t * (f1 - f0);
                criticalSpeeds.push({ rpm: rpmX, freq: freqX, order: n, modeIdx: m, seriesIdx: si, ...modeMeta });
              }
            }
          }
        });
      });

      const orderColors = { 1: COLORS.danger, 2: COLORS.warning, 3: '#A78BFA' };
      const visibleCriticalSpeeds = [];
      criticalSpeeds.forEach(cs => {
        if (cs.rpm < rpmMin || cs.rpm > rpmMax || cs.freq < freqMin || cs.freq > freqMax) return;
        visibleCriticalSpeeds.push(cs);
        const x = tx(cs.rpm), y = ty(cs.freq);
        const col = orderColors[cs.order] || COLORS.textBright;
        ctx.beginPath();
        ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
        ctx.closePath();
        if (cs.seriesIdx === 0) {
          // 基準：塗りつぶしひし形
          ctx.fillStyle = col; ctx.fill();
          ctx.strokeStyle = COLORS.surface; ctx.lineWidth = 1; ctx.stroke();
        } else {
          // 比較対象：白抜き(枠のみ)のひし形にして基準側と見分けられるようにする
          ctx.fillStyle = COLORS.surface; ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
        }
      });
      if (onCriticalSpeeds) {
        const sorted = [...visibleCriticalSpeeds].sort((a, b) => a.rpm - b.rpm);
        setTimeout(() => onCriticalSpeeds(sorted), 0);
      }
      scaleRef.current.visibleCriticalSpeeds = visibleCriticalSpeeds;
      scaleRef.current.orderColors = orderColors;

      // Axes
      ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

      ctx.fillStyle = COLORS.textMuted; ctx.font = '10px JetBrains Mono'; ctx.textAlign = 'right';
      for (let i = 0; i <= 5; i++) {
        const f = freqMin + (freqMax - freqMin) * i / 5;
        ctx.fillText(Math.round(f), pad.left - 6, ty(f) + 4);
      }
      ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        const rpm = rpmMin + (rpmMax - rpmMin) * i / 5;
        ctx.fillText(Math.round(rpm), tx(rpm), pad.top + ph + 15);
      }
      ctx.fillStyle = COLORS.textMuted; ctx.font = '10px Inter';
      ctx.fillText('Rotational Speed [rpm]', pad.left + pw / 2, height - 5);
      ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText('Natural Frequency [Hz]', 0, 0); ctx.restore();
      ctx.fillStyle = COLORS.textBright; ctx.font = '500 11px Inter'; ctx.textAlign = 'left';
      ctx.fillText('Campbell Diagram（重ね描き）', pad.left, 18);

      // 凡例：系列名と線種（実線／破線）
      series.forEach((s, si) => {
        const ly = 30, lx = pad.left + si * 160;
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
        ctx.setLineDash(si === 0 ? [] : [5, 3]);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 18, ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = s.color; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
        ctx.fillText(s.label, lx + 22, ly + 3);
      });

      // ── ホバー位置のクロスヘア描画 ──
      if (hoverPt && hoverPt.px >= pad.left && hoverPt.px <= pad.left + pw &&
          hoverPt.py >= pad.top && hoverPt.py <= pad.top + ph) {
        ctx.strokeStyle = COLORS.textMuted + '99';
        ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(hoverPt.px, pad.top); ctx.lineTo(hoverPt.px, pad.top + ph); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad.left, hoverPt.py); ctx.lineTo(pad.left + pw, hoverPt.py); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = hoverPt.color || COLORS.accent;
        ctx.beginPath(); ctx.arc(hoverPt.px, hoverPt.py, 3.5, 0, 2 * Math.PI); ctx.fill();
      }
    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [series, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width, height, hoverPt]);

  // マウス位置に最も近い「実データ点」に、両系列を横断してスナップする。
  // 危険速度の交点（ひし形マーカー）に十分近い場合は、そちらを系列を問わず優先的に表示する。
  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const s = scaleRef.current;
    if (!s || !s.series) return;

    // ── ① 危険速度の交点にピクセル距離的に近ければ、系列を問わず優先スナップ ──
    const SNAP_PX = 14;
    if (s.visibleCriticalSpeeds && s.visibleCriticalSpeeds.length > 0) {
      let bestCs = null, bestCsDist = Infinity;
      s.visibleCriticalSpeeds.forEach(cs => {
        const cx = s.tx(cs.rpm), cy = s.ty(cs.freq);
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestCsDist) { bestCsDist = d; bestCs = cs; }
      });
      if (bestCs && bestCsDist <= SNAP_PX) {
        const col = (s.orderColors && s.orderColors[bestCs.order]) || COLORS.textBright;
        const seriesInfo = s.series[bestCs.seriesIdx];
        const modeLabel = bestCs.isForward !== undefined
          ? `Mode ${bestCs.undampedModeIdx + 1}${bestCs.isForward ? 'F' : 'B'}`
          : `Mode ${bestCs.modeIdx + 1}`;
        setHoverPt({
          px: s.tx(bestCs.rpm), py: s.ty(bestCs.freq),
          rpm: bestCs.rpm, freq: bestCs.freq, color: col,
          label: `⬥ ${seriesInfo.label}: 危険速度 ${bestCs.order}X (${modeLabel})`,
        });
        return;
      }
    }

    // ── ② 通常時: 両系列すべてのモード曲線点の中から、rpm・freqとも最も近い点を探す ──
    const mouseRpm = s.rpmMin + (px - s.pad.left) / s.pw * (s.rpmMax - s.rpmMin);
    const mouseFreq = s.freqMin + (s.pad.top + s.ph - py) / s.ph * (s.freqMax - s.freqMin);

    let best = null, bestDist = Infinity;
    s.series.forEach((seriesInfo, si) => {
      let bestPt = seriesInfo.campbellData[0], bestDx = Infinity;
      seriesInfo.campbellData.forEach(pt => {
        const dx = Math.abs(pt.rpm - mouseRpm);
        if (dx < bestDx) { bestDx = dx; bestPt = pt; }
      });
      (bestPt.modes || []).forEach((mode, mi) => {
        if (!mode) return;
        // rpm方向・freq方向を軸レンジで正規化した疑似距離。系列間でも公平に比較できるようにする
        const dxN = Math.abs(bestPt.rpm - mouseRpm) / (s.rpmMax - s.rpmMin || 1);
        const dyN = Math.abs(mode.freq - mouseFreq) / (s.freqMax - s.freqMin || 1);
        const d = dxN * dxN + dyN * dyN;
        if (d < bestDist) { bestDist = d; best = { pt: bestPt, mode, modeIdx: mi, seriesIdx: si }; }
      });
    });
    if (!best) return;

    const seriesInfo = s.series[best.seriesIdx];
    const label = best.mode.isForward !== undefined
      ? `${seriesInfo.label}: Mode ${best.mode.undampedModeIdx + 1}${best.mode.isForward ? 'F' : 'B'}`
      : `${seriesInfo.label}: Mode ${best.modeIdx + 1}`;

    setHoverPt({
      px: s.tx(best.pt.rpm), py: s.ty(best.mode.freq),
      rpm: best.pt.rpm, freq: best.mode.freq, color: seriesInfo.color, label,
    });
  };

  const inPlotArea = (() => {
    if (!hoverPt || !scaleRef.current) return false;
    const s = scaleRef.current;
    return hoverPt.px >= s.pad.left && hoverPt.px <= s.pad.left + s.pw &&
           hoverPt.py >= s.pad.top && hoverPt.py <= s.pad.top + s.ph;
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
          left: Math.min(hoverPt.px + 12, (canvasRef.current?.clientWidth || width) - 210),
          top: Math.max(hoverPt.py - 48, 4),
          background: COLORS.surface2, border: `1px solid ${COLORS.border}`,
          borderRadius: 5, padding: '5px 8px', pointerEvents: 'none',
          fontSize: 10, fontFamily: 'JetBrains Mono', color: COLORS.textBright,
          whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}>
          <div style={{ color: hoverPt.color || COLORS.accent, fontWeight: 700, marginBottom: 2 }}>{hoverPt.label}</div>
          <div>回転数: <span style={{ color: hoverPt.color || COLORS.accent }}>{hoverPt.rpm.toFixed(0)} rpm</span></div>
          <div>周波数: <span style={{ color: hoverPt.color || COLORS.accent }}>{formatAdaptive(hoverPt.freq)} Hz</span></div>
        </div>
      )}
    </div>
  );
}
