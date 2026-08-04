// ─── Shaft Overview ───
// シャフト・ディスク・軸受・アンバランスの配置を一枚の断面図として表示する、
// 入力パネル用の軽量プレビュー(3Dビューとは別の、常に表示される簡易図)。
import { useEffect, useRef } from "react";
import { COLORS } from "./chartTheme.js";

export function ShaftOverview({ shaftElems, disks, bearings }) {
  const canvasRef = useRef();
  const totalLen = shaftElems.reduce((s, e) => s + e.length, 0) || 1;

  // Build node positions
  const nodePositions = [0];
  shaftElems.forEach(el => nodePositions.push(nodePositions[nodePositions.length-1] + el.length));

  const findNode = x => {
    let best = 0, bd = Infinity;
    nodePositions.forEach((xn, i) => { const d = Math.abs(xn-x); if(d<bd){bd=d;best=i;} });
    return best;
  };

  const maxOD = Math.max(...shaftElems.map(e => e.outerDiam), 0.01);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 260, H = 90;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const padX = 14, padY = 14;
    const pw = W - padX*2;
    const cy = H / 2;
    const maxR = (H/2 - padY) * 0.85;

    const tx = x => padX + (x / totalLen) * pw;
    const scaleR = r => Math.max(2, (r / maxOD) * maxR);

    // Draw shaft segments
    shaftElems.forEach((el, i) => {
      const x0 = tx(nodePositions[i]);
      const x1 = tx(nodePositions[i+1]);
      const ro = scaleR(el.outerDiam / 2);
      const ri = scaleR(el.innerDiam / 2);
      // outer
      ctx.fillStyle = COLORS.surface2;
      ctx.strokeStyle = COLORS.accent + 'AA';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x0, cy - ro, x1 - x0, ro*2);
      ctx.fill(); ctx.stroke();
      // inner bore
      if (el.innerDiam > 0) {
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(x0+1, cy - ri, x1 - x0 - 2, ri*2);
      }
      // segment label (x range)
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '8px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText(`${(nodePositions[i]).toFixed(2)}`, x0, H - 3);
    });
    // last node label
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '8px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(`${totalLen.toFixed(2)}`, tx(totalLen), H - 3);

    // Draw disks
    disks.forEach(d => {
      const x = tx(d.position);
      const r = maxR * 0.85;
      ctx.strokeStyle = '#A78BFA';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, cy - r); ctx.lineTo(x, cy + r); ctx.stroke();
      ctx.fillStyle = '#A78BFA33';
      ctx.strokeStyle = '#A78BFA';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(x-3, cy - r, 6, r*2); ctx.fill(); ctx.stroke();
    });

    // Draw bearings
    bearings.forEach(b => {
      const x = tx(b.position);
      ctx.strokeStyle = COLORS.warning;
      ctx.lineWidth = 2;
      const r = maxR * 0.5;
      // Triangle symbol
      ctx.beginPath();
      ctx.moveTo(x, cy + r);
      ctx.lineTo(x - 6, cy + r + 9);
      ctx.lineTo(x + 6, cy + r + 9);
      ctx.closePath();
      ctx.fillStyle = COLORS.warning + '44';
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, cy - r);
      ctx.lineTo(x - 6, cy - r - 9);
      ctx.lineTo(x + 6, cy - r - 9);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    });

    // Draw unbalances (from disks that have unbalance set)
    disks.filter(d => d.hasUnbalance).forEach(d => {
      const x = tx(d.position);
      ctx.fillStyle = COLORS.danger;
      ctx.beginPath(); ctx.arc(x, cy - maxR * 0.4, 3.5, 0, 2*Math.PI); ctx.fill();
    });

    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [shaftElems, disks, bearings, totalLen]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 5, flexWrap: 'wrap' }}>
        {[
          [COLORS.accent, 'シャフト'],
          ['#A78BFA', 'ディスク'],
          [COLORS.warning, '軸受'],
          [COLORS.danger, 'アンバランス'],
        ].map(([c, label]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: c }} />
            <span style={{ fontSize: 9, color: COLORS.textMuted }}>{label}</span>
          </div>
        ))}
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', borderRadius: 4, display: 'block', border: `1px solid ${COLORS.border}` }} />
    </div>
  );
}
