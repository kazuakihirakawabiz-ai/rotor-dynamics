// ─── Mode Shape Visualizer ───
// ①固有値解析・②複素固有値解析いずれの結果表示でも使われる、モード形状の描画コンポーネント。
// Shows:  shaft centerline, deformed shape (y-disp), rotation arrows (θ),
//         bearing supports (triangle), disk markers, node displacement values.
import { useEffect, useRef } from "react";
import { COLORS } from "./chartTheme.js";

export function ModeShape({ mode, nodePositions, bearings = [], disks = [], width = 520, height = 190 }) {
  const canvasRef = useRef();
  useEffect(() => {
    if (!mode || !nodePositions || nodePositions.length < 2) return;
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

    const pad = { top: 28, right: 24, bottom: 36, left: 24 };
    const pw = W - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;
    const totalLen = nodePositions[nodePositions.length - 1] || 1;
    const tx = x => pad.left + (x / totalLen) * pw;
    const cy = pad.top + ph / 2;

    // ── y-displacements (DOF index n*4) and rotations (n*4+1) ──
    const nNodes = nodePositions.length;
    const yDisps = nodePositions.map((_, n) => mode[n * 4] ?? 0);
    const thetas = nodePositions.map((_, n) => mode[n * 4 + 1] ?? 0);
    const maxDisp = Math.max(...yDisps.map(Math.abs), 1e-12);
    const dispScale = (ph / 2) * 0.72 / maxDisp;

    const py = (n) => cy - yDisps[n] * dispScale;

    // ── background grid ──
    ctx.strokeStyle = COLORS.border + '33'; ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      const y = pad.top + ph * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
    }

    // ── zero line (shaft axis) ──
    ctx.strokeStyle = COLORS.border + '88'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(tx(0), cy); ctx.lineTo(tx(totalLen), cy); ctx.stroke();
    ctx.setLineDash([]);

    // ── bearing supports — draw BEFORE mode shape so they appear "under" ──
    const findNearestNode = (xpos) => {
      let best = 0, bd = Infinity;
      nodePositions.forEach((xn, i) => { const d = Math.abs(xn - xpos); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    bearings.forEach(b => {
      const xi = tx(b.position);
      const ni = findNearestNode(b.position);
      const nodeY = py(ni);
      const triH = 12, triW = 10;

      // vertical line from node to triangle tip
      ctx.strokeStyle = COLORS.warning + 'CC'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(xi, nodeY); ctx.lineTo(xi, nodeY + triH + 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xi, nodeY); ctx.lineTo(xi, nodeY - triH - 2); ctx.stroke();

      // triangle below
      ctx.fillStyle = COLORS.warning + '44';
      ctx.strokeStyle = COLORS.warning; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xi, nodeY + triH + 2);
      ctx.lineTo(xi - triW, nodeY + triH + 2 + triH);
      ctx.lineTo(xi + triW, nodeY + triH + 2 + triH);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // ground hatch
      ctx.strokeStyle = COLORS.warning + '88'; ctx.lineWidth = 1;
      const gY = nodeY + triH*2 + 4;
      ctx.beginPath(); ctx.moveTo(xi - triW, gY); ctx.lineTo(xi + triW, gY); ctx.stroke();
      for (let d = -triW; d <= triW; d += 5) {
        ctx.beginPath(); ctx.moveTo(xi + d, gY); ctx.lineTo(xi + d - 4, gY + 5); ctx.stroke();
      }

      // triangle above (mirror)
      ctx.fillStyle = COLORS.warning + '44';
      ctx.strokeStyle = COLORS.warning; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xi, nodeY - triH - 2);
      ctx.lineTo(xi - triW, nodeY - triH - 2 - triH);
      ctx.lineTo(xi + triW, nodeY - triH - 2 - triH);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      const gY2 = nodeY - triH*2 - 4;
      ctx.strokeStyle = COLORS.warning + '88'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xi - triW, gY2); ctx.lineTo(xi + triW, gY2); ctx.stroke();
      for (let d = -triW; d <= triW; d += 5) {
        ctx.beginPath(); ctx.moveTo(xi + d, gY2); ctx.lineTo(xi + d + 4, gY2 - 5); ctx.stroke();
      }

      // displacement value at bearing node
      const dispPct = (yDisps[ni] / maxDisp * 100).toFixed(0);
      ctx.fillStyle = Math.abs(yDisps[ni]/maxDisp) < 0.05 ? COLORS.success : COLORS.warning;
      ctx.font = 'bold 9px JetBrains Mono'; ctx.textAlign = 'center';
      ctx.fillText(`${dispPct}%`, xi, nodeY - triH - 18);
    });

    // ── disk markers ──
    disks.forEach(d => {
      const xi = tx(d.position);
      const ni = findNearestNode(d.position);
      const nodeY = py(ni);
      ctx.strokeStyle = '#A78BFA'; ctx.lineWidth = 2;
      ctx.fillStyle = '#A78BFA22';
      ctx.beginPath(); ctx.rect(xi - 4, nodeY - 14, 8, 28); ctx.fill(); ctx.stroke();
    });

    // ── deformed shape line (cubic spline-like via Catmull-Rom) ──
    ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2.5;
    ctx.beginPath();
    nodePositions.forEach((xpos, n) => {
      const x = tx(xpos), y = py(n);
      n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill area between baseline and deformed shape
    ctx.beginPath();
    ctx.moveTo(tx(nodePositions[0]), cy);
    nodePositions.forEach((xpos, n) => ctx.lineTo(tx(xpos), py(n)));
    ctx.lineTo(tx(nodePositions[nNodes-1]), cy);
    ctx.closePath();
    ctx.fillStyle = COLORS.accent + '18';
    ctx.fill();

    // ── node dots with displacement % label ──
    nodePositions.forEach((xpos, n) => {
      const x = tx(xpos), y = py(n);
      // dot
      const isBearing = bearings.some(b => Math.abs(b.position - xpos) < totalLen * 0.01);
      ctx.fillStyle = isBearing ? COLORS.warning : COLORS.accent;
      ctx.beginPath(); ctx.arc(x, y, isBearing ? 5 : 3.5, 0, 2*Math.PI); ctx.fill();
      ctx.strokeStyle = COLORS.surface; ctx.lineWidth = 1;
      ctx.stroke();
    });

    // ── rotation arrows at each node (small arc arrows showing θ) ──
    const maxTheta = Math.max(...thetas.map(Math.abs), 1e-12);
    nodePositions.forEach((xpos, n) => {
      const th = thetas[n];
      if (Math.abs(th) < maxTheta * 0.05) return; // skip negligible
      const x = tx(xpos), y = py(n);
      const r = 8, arrowScale = Math.min(Math.abs(th)/maxTheta, 1);
      const sweepAngle = arrowScale * Math.PI * 0.7 * Math.sign(th);
      ctx.strokeStyle = '#A78BFA99'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI/2, -Math.PI/2 + sweepAngle, sweepAngle < 0);
      ctx.stroke();
      // arrowhead
      const endAngle = -Math.PI/2 + sweepAngle;
      const ax = x + r * Math.cos(endAngle);
      const ay = y + r * Math.sin(endAngle);
      const perpAngle = endAngle + (sweepAngle > 0 ? Math.PI/2 : -Math.PI/2);
      ctx.fillStyle = '#A78BFA99';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + 4*Math.cos(perpAngle-0.4), ay + 4*Math.sin(perpAngle-0.4));
      ctx.lineTo(ax + 4*Math.cos(perpAngle+0.4), ay + 4*Math.sin(perpAngle+0.4));
      ctx.closePath(); ctx.fill();
    });

    // ── x-axis positions ──
    ctx.fillStyle = COLORS.textMuted; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'center';
    nodePositions.forEach((xpos, n) => {
      if (n % Math.max(1, Math.floor(nNodes/6)) === 0 || n === nNodes-1) {
        ctx.fillText(xpos.toFixed(2), tx(xpos), height - 4);
      }
    });

    // ── legend ──
    ctx.fillStyle = COLORS.textMuted; ctx.font = '9px Inter'; ctx.textAlign = 'left';
    ctx.fillText('変位 (% of max)', pad.left, 12);
    ctx.fillStyle = COLORS.accent; ctx.fillRect(pad.left + 90, 5, 16, 6);
    ctx.fillStyle = COLORS.warning;
    ctx.beginPath(); ctx.arc(pad.left + 120, 8, 3, 0, 2*Math.PI); ctx.fill();
    ctx.fillStyle = COLORS.textMuted; ctx.font = '9px Inter';
    ctx.fillText('軸受', pad.left + 126, 12);

    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [mode, nodePositions, bearings, disks, width, height]);
  return <canvas ref={canvasRef} style={{ borderRadius: 6, display: 'block', width: '100%', maxWidth: width }} />;
}
