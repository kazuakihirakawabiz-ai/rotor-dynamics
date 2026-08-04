// ─── Campbell Diagram ───
// ③キャンベル線図の描画本体。回転数-固有振動数平面にモード曲線と1X/2X/3X線を描き、
// その交点(危険速度)をひし形マーカーで表示する。データ自体は
// analysis/campbell.js の solveCampbellSweep() で生成されたものを受け取るだけで、
// このコンポーネント自身は解析ロジックを持たない。
import { useState, useEffect, useRef } from "react";
import { COLORS, formatAdaptive } from "./chartTheme.js";

export function CampbellDiagram({ campbellData, maxRpm, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width = 520, height = 300, onCriticalSpeeds }) {
  const canvasRef = useRef();
  const scaleRef = useRef(null);
  const [hoverPt, setHoverPt] = useState(null);
  useEffect(() => {
    if (!campbellData || campbellData.length === 0) return;
    const canvas = canvasRef.current;

    const draw = () => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // スマホなど狭い画面でもはみ出さないよう、実際にレイアウトされた幅(clientWidth)を使う
    canvas.style.width = '100%';
    canvas.style.maxWidth = width + 'px';
    const W = canvas.clientWidth || width;
    canvas.width = W * dpr; canvas.height = height * dpr;
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.surface; ctx.fillRect(0, 0, W, height);

    const pad = { top: 30, right: 30, bottom: 45, left: 65 };
    const pw = W - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;

    const dataMaxFreq = Math.max(...campbellData.flatMap(pt => pt.modes.map(m => m.freq))) * 1.15 || 200;
    const rpmMin = minRpmLim ?? 0;
    const rpmMax = maxRpmLim ?? maxRpm;
    const freqMin = minFreqLim ?? 0;
    const freqMax = maxFreqLim ?? dataMaxFreq;
    const tx = rpm => pad.left + (rpm - rpmMin) / (rpmMax - rpmMin || 1) * pw;
    const ty = f   => pad.top + ph - (f - freqMin) / (freqMax - freqMin || 1) * ph;

    // マウス位置の逆変換・最近傍モード曲線探索用に、この描画時点での情報を保存
    scaleRef.current = { pad, pw, ph, rpmMin, rpmMax, freqMin, freqMax, tx, ty, campbellData };

    // Grid
    ctx.strokeStyle = COLORS.border + '44'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const f = freqMin + (freqMax - freqMin) * i / 5;
      ctx.beginPath(); ctx.moveTo(pad.left, ty(f)); ctx.lineTo(pad.left + pw, ty(f)); ctx.stroke();
    }

    // EO lines (1X, 2X, 3X)
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

    // Mode branches
    const modeCount = campbellData[0]?.modes?.length || 0;
    const modeColors = [COLORS.accent, COLORS.success, '#A78BFA', COLORS.warning, '#F472B6'];
    scaleRef.current.modeColors = modeColors;
    scaleRef.current.modeCount = modeCount;
    for (let m = 0; m < modeCount; m++) {
      const col = modeColors[m % modeColors.length];
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
      let started = false;
      campbellData.forEach(pt => {
        if (!pt.modes[m]) return;
        const x = tx(pt.rpm), y = ty(pt.modes[m].freq);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // ── Critical speeds: 1X/2X/3X とモード曲線の交点 ──
    // 各セグメント [rpm_i, rpm_{i+1}] 上で line(rpm) = n*rpm/60 と
    // mode_freq(rpm)（線形補間）が一致する点を探す。
    const criticalSpeeds = []; // {rpm, freq, order, modeIdx, isForward, undampedModeIdx}
    [1, 2, 3].forEach(n => {
      for (let m = 0; m < modeCount; m++) {
        for (let i = 0; i < campbellData.length - 1; i++) {
          const pt0 = campbellData[i], pt1 = campbellData[i + 1];
          if (!pt0.modes[m] || !pt1.modes[m]) continue;
          const rpm0 = pt0.rpm, rpm1 = pt1.rpm;
          const f0 = pt0.modes[m].freq, f1 = pt1.modes[m].freq;
          const modeMeta = { isForward: pt0.modes[m].isForward, undampedModeIdx: pt0.modes[m].undampedModeIdx };
          // g(rpm) = modeFreq(rpm) - n*rpm/60 の符号変化を見る（線形補間内で交差判定）
          const g0 = f0 - n * rpm0 / 60;
          const g1 = f1 - n * rpm1 / 60;
          if (g0 === 0) {
            criticalSpeeds.push({ rpm: rpm0, freq: f0, order: n, modeIdx: m, ...modeMeta });
          } else if (g0 * g1 < 0) {
            // 線形補間で交点を求める
            const t = g0 / (g0 - g1);
            const rpmX = rpm0 + t * (rpm1 - rpm0);
            const freqX = f0 + t * (f1 - f0);
            criticalSpeeds.push({ rpm: rpmX, freq: freqX, order: n, modeIdx: m, ...modeMeta });
          }
        }
      }
    });

    // 描画範囲内のもののみマーカー表示
    const orderColors = { 1: COLORS.danger, 2: COLORS.warning, 3: '#A78BFA' };
    const visibleCriticalSpeeds = [];
    criticalSpeeds.forEach(cs => {
      if (cs.rpm < rpmMin || cs.rpm > rpmMax || cs.freq < freqMin || cs.freq > freqMax) return;
      visibleCriticalSpeeds.push(cs);
      const x = tx(cs.rpm), y = ty(cs.freq);
      const col = orderColors[cs.order] || COLORS.textBright;
      // マーカー（ひし形）
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = COLORS.surface; ctx.lineWidth = 1; ctx.stroke();
    });
    if (onCriticalSpeeds) {
      // rpm昇順でソートして親コンポーネントに通知（毎フレーム呼ばないようsetTimeoutで非同期化）
      const sorted = [...visibleCriticalSpeeds].sort((a, b) => a.rpm - b.rpm);
      setTimeout(() => onCriticalSpeeds(sorted), 0);
    }
    // ホバー時に危険速度の交点を優先的にスナップできるよう保存しておく
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
    ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI/2);
    ctx.fillText('Natural Frequency [Hz]', 0, 0); ctx.restore();
    ctx.fillStyle = COLORS.textBright; ctx.font = '500 11px Inter'; ctx.textAlign = 'left';
    ctx.fillText('Campbell Diagram', pad.left, 18);

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
  }, [campbellData, maxRpm, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width, height, hoverPt]);

  // マウス位置に最も近い「実データ点」にスナップする。
  // 危険速度の交点（ひし形マーカー）に十分近い場合は、そちらを優先的に表示する。
  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const s = scaleRef.current;
    if (!s || !s.campbellData || s.campbellData.length === 0) return;

    // ── ① 危険速度の交点にピクセル距離的に近ければ、それを優先スナップ ──
    const SNAP_PX = 14; // この距離[px]以内ならマーカー優先
    if (s.visibleCriticalSpeeds && s.visibleCriticalSpeeds.length > 0) {
      let bestCs = null, bestCsDist = Infinity;
      s.visibleCriticalSpeeds.forEach(cs => {
        const cx = s.tx(cs.rpm), cy = s.ty(cs.freq);
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestCsDist) { bestCsDist = d; bestCs = cs; }
      });
      if (bestCs && bestCsDist <= SNAP_PX) {
        const col = (s.orderColors && s.orderColors[bestCs.order]) || COLORS.textBright;
        const modeLabel = bestCs.isForward !== undefined
          ? `Mode ${bestCs.undampedModeIdx + 1}${bestCs.isForward ? 'F' : 'B'}`
          : `Mode ${bestCs.modeIdx + 1}`;
        setHoverPt({
          px: s.tx(bestCs.rpm), py: s.ty(bestCs.freq),
          rpm: bestCs.rpm, freq: bestCs.freq, color: col,
          label: `⬥ 危険速度 ${bestCs.order}X (${modeLabel})`,
        });
        return;
      }
    }

    // ── ② 通常時: 最も近いモード曲線上のデータ点にスナップ ──
    const mouseRpm = s.rpmMin + (px - s.pad.left) / s.pw * (s.rpmMax - s.rpmMin);
    const mouseFreq = s.freqMin + (s.pad.top + s.ph - py) / s.ph * (s.freqMax - s.freqMin);

    // rpm方向で最も近いデータ行を探す
    let bestPt = s.campbellData[0], bestDx = Infinity;
    s.campbellData.forEach(pt => {
      const dx = Math.abs(pt.rpm - mouseRpm);
      if (dx < bestDx) { bestDx = dx; bestPt = pt; }
    });

    // その行の中で、freq方向に最も近いモードを探す
    let bestMode = null, bestDy = Infinity, bestIdx = -1;
    (bestPt.modes || []).forEach((m, i) => {
      if (!m) return;
      const dy = Math.abs(m.freq - mouseFreq);
      if (dy < bestDy) { bestDy = dy; bestMode = m; bestIdx = i; }
    });
    if (!bestMode) return;

    const col = (s.modeColors && s.modeColors[bestIdx % s.modeColors.length]) || COLORS.accent;
    const label = bestMode.isForward !== undefined
      ? `Mode ${bestMode.undampedModeIdx + 1}${bestMode.isForward ? 'F' : 'B'}`
      : `Mode ${bestIdx + 1}`;

    setHoverPt({
      px: s.tx(bestPt.rpm), py: s.ty(bestMode.freq),
      rpm: bestPt.rpm, freq: bestMode.freq, color: col, label,
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
          left: Math.min(hoverPt.px + 12, (canvasRef.current?.clientWidth || width) - 150),
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
