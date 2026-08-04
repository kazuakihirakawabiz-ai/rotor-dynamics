// ─── Canvas Chart ───
// 汎用の折れ線グラフ。①固有値解析のモード一覧、④周波数応答の振幅/位相グラフなど、
// 複数の解析タブから共通で使われる。
import { useState, useEffect, useRef } from "react";
import { COLORS, formatAdaptive } from "./chartTheme.js";

export function LineChart({ data, xKey, yKey, title, xLabel, yLabel, color = COLORS.accent, lines, vLines, yMin, yMax, width = 500, height = 260 }) {
  const canvasRef = useRef();
  const wrapRef = useRef();
  const scaleRef = useRef(null); // 直近描画時の座標変換情報を保持 (マウス位置の逆変換に使う)
  const [hoverPt, setHoverPt] = useState(null); // { px, py, x, y }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;

    const draw = () => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // 親要素の幅に合わせて縮小できるように、CSS表示幅は100%(上限は指定のwidth)にし、
    // 実際にレイアウトされた幅(clientWidth)を読み取ってcanvasの解像度計算に使う。
    // スマホなど画面が狭い環境でも、はみ出さずに縮小して表示されるようにするため。
    canvas.style.width = '100%';
    canvas.style.maxWidth = width + 'px';
    const W = canvas.clientWidth || width;
    canvas.width = W * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, W, height);

    const pad = { top: 30, right: 20, bottom: 45, left: 65 };
    const pw = W - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;

    const allData = lines ? lines.flatMap(l => l.data || []) : data;
    const xs = allData.map(d => d[xKey]);
    const ys = allData.map(d => Array.isArray(d[yKey]) ? d[yKey] : [d[yKey]]).flat();
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const dataMinY = Math.min(...ys), dataMaxY = Math.max(...ys);
    // Use explicit yMin/yMax if provided (e.g. phase: fixed -180 to +180)
    const minY = yMin !== undefined ? yMin : (dataMinY < 0 ? dataMinY * 1.1 : 0);
    const maxY = yMax !== undefined ? yMax : (dataMaxY >= 0 ? dataMaxY * 1.1 || 1 : dataMaxY * 0.9 || 1);
    const yRange = maxY - minY || 1;

    const tx = x => pad.left + (x - minX) / (maxX - minX || 1) * pw;
    const ty = y => pad.top + ph - (y - minY) / yRange * ph;

    // マウス位置の逆変換・最近傍データ点探索用に、この描画時点での情報を保存しておく
    scaleRef.current = { pad, pw, ph, minX, maxX, minY, maxY, yRange, tx, ty };

    // Grid
    ctx.strokeStyle = COLORS.border + '55';
    ctx.lineWidth = 0.5;
    // Zero line (if range spans negative)
    if (minY < 0 && maxY > 0) {
      ctx.strokeStyle = COLORS.border + 'AA'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, ty(0)); ctx.lineTo(pad.left + pw, ty(0)); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const y = minY + yRange * i / 5;
      ctx.beginPath(); ctx.moveTo(pad.left, ty(y)); ctx.lineTo(pad.left + pw, ty(y)); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const x = minX + (maxX - minX) * i / 5;
      ctx.beginPath(); ctx.moveTo(tx(x), pad.top); ctx.lineTo(tx(x), pad.top + ph); ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

    // Labels
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const y = minY + yRange * i / 5;
      ctx.fillText(formatAdaptive(y), pad.left - 6, ty(y) + 4);
    }
    ctx.textAlign = 'center';
    for (let i = 0; i <= 5; i++) {
      const x = minX + (maxX - minX) * i / 5;
      ctx.fillText(Math.round(x), tx(x), pad.top + ph + 15);
    }
    ctx.fillStyle = COLORS.textMuted; ctx.font = '10px Inter';
    ctx.fillText(xLabel || xKey, pad.left + pw / 2, height - 5);
    ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel || yKey, 0, 0); ctx.restore();

    // Title
    ctx.fillStyle = COLORS.textBright; ctx.font = '500 11px Inter'; ctx.textAlign = 'left';
    ctx.fillText(title || '', pad.left, 18);

    // Vertical marker lines (e.g. eigenfrequencies)
    if (vLines) {
      vLines.forEach(({ x: vx, color: vc, label: vl }) => {
        const px = tx(vx);
        if (px < pad.left || px > pad.left + pw) return;
        ctx.strokeStyle = vc || COLORS.danger;
        ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, pad.top + ph); ctx.stroke();
        ctx.setLineDash([]);
        if (vl) {
          ctx.save(); ctx.translate(px + 3, pad.top + 10); ctx.rotate(Math.PI/2);
          ctx.fillStyle = vc || COLORS.danger; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
          ctx.fillText(vl, 0, 0); ctx.restore();
        }
      });
    }

    // Lines
    const drawLine = (pts, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
      pts.forEach((d, i) => {
        const x = tx(d[xKey]), y = ty(typeof d[yKey] === 'number' ? d[yKey] : d[yKey][0]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    if (lines) {
      lines.forEach(l => drawLine(l.data, l.color || color));
    } else {
      drawLine(data, color);
    }

    // ── ホバー位置のクロスヘア描画 ──
    if (hoverPt && hoverPt.px >= pad.left && hoverPt.px <= pad.left + pw &&
        hoverPt.py >= pad.top && hoverPt.py <= pad.top + ph) {
      ctx.strokeStyle = COLORS.textMuted + '99';
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hoverPt.px, pad.top); ctx.lineTo(hoverPt.px, pad.top + ph); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.left, hoverPt.py); ctx.lineTo(pad.left + pw, hoverPt.py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = hoverPt.color || color;
      ctx.beginPath(); ctx.arc(hoverPt.px, hoverPt.py, 3.5, 0, 2 * Math.PI); ctx.fill();
    }
    };

    draw();
    // 画面回転やウィンドウリサイズがあった時に、幅に合わせて再描画する
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [data, xKey, yKey, title, xLabel, yLabel, color, lines, vLines, yMin, yMax, width, height, hoverPt]);

  // マウスのx位置に最も近い「実データ点」にスナップする（線の上の実際の値を表示するため）
  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const s = scaleRef.current;
    if (!s) return;
    const mouseDataX = s.minX + (px - s.pad.left) / s.pw * (s.maxX - s.minX);

    // 対象データ（単一系列 or 複数系列）から、mouseDataXに最も近い点を探す
    const series = lines ? lines : [{ data, color }];
    let best = null;
    series.forEach(ser => {
      (ser.data || []).forEach(d => {
        const dx = Math.abs(d[xKey] - mouseDataX);
        if (!best || dx < best.dx) {
          const yVal = typeof d[yKey] === 'number' ? d[yKey] : d[yKey][0];
          best = { dx, x: d[xKey], y: yVal, color: ser.color || color, label: ser.label };
        }
      });
    });
    if (!best) return;
    setHoverPt({ px: s.tx(best.x), py: s.ty(best.y), x: best.x, y: best.y, color: best.color, label: best.label });
  };

  const inPlotArea = (() => {
    if (!hoverPt || !scaleRef.current) return false;
    const s = scaleRef.current;
    return hoverPt.px >= s.pad.left && hoverPt.px <= s.pad.left + s.pw &&
           hoverPt.py >= s.pad.top && hoverPt.py <= s.pad.top + s.ph;
  })();

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: width, height }}>
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
          top: Math.max(hoverPt.py - (hoverPt.label ? 48 : 34), 4),
          background: COLORS.surface2, border: `1px solid ${COLORS.border}`,
          borderRadius: 5, padding: '5px 8px', pointerEvents: 'none',
          fontSize: 10, fontFamily: 'JetBrains Mono', color: COLORS.textBright,
          whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}>
          {hoverPt.label && <div style={{ color: hoverPt.color || color, fontWeight: 700, marginBottom: 2 }}>{hoverPt.label}</div>}
          <div>{xLabel || xKey}: <span style={{ color: hoverPt.color || color }}>{formatAdaptive(hoverPt.x)}</span></div>
          <div>{yLabel || yKey}: <span style={{ color: hoverPt.color || color }}>{formatAdaptive(hoverPt.y)}</span></div>
        </div>
      )}
    </div>
  );
}
