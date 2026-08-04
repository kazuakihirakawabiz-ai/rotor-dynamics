// ─── Rotor 3D Model Viewer ───
// シャフト・ディスク・軸受を簡易3D投影(Zソート式ペインターズアルゴリズム)で描画するビューア。
// ドラッグで回転・ホイールでズーム操作ができる。inline=true で右カラム常設表示、
// false でモーダルオーバーレイ表示になる。解析ロジックへの依存はなく、純粋な描画コンポーネント。
import { useState, useEffect, useRef } from "react";
import { COLORS } from "./chartTheme.js";

export function RotorModel3DViewer({ shaftElems, disks, bearings, onClose, inline = false }) {
  const canvasRef = useRef();
  const [yaw, setYaw] = useState(-0.6);     // 水平方向の回転角 [rad]
  const [pitch, setPitch] = useState(0.35); // 垂直方向の回転角 [rad]
  const [zoom, setZoom] = useState(1.0);
  const dragState = useRef(null);

  const totalLen = shaftElems.reduce((s, e) => s + e.length, 0) || 1;
  const nodePositions = [0];
  shaftElems.forEach(el => nodePositions.push(nodePositions[nodePositions.length - 1] + el.length));
  const maxOD = Math.max(...shaftElems.map(e => e.outerDiam), 0.01, ...disks.map(() => 0));

  const DEFAULT_DISK_COLOR = COLORS.textMuted;

  // ── マウス操作 ──
  const onPointerDown = (e) => {
    dragState.current = { x: e.clientX, y: e.clientY, yaw, pitch };
  };
  const onPointerMove = (e) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    setYaw(dragState.current.yaw + dx * 0.01);
    setPitch(Math.max(-1.5, Math.min(1.5, dragState.current.pitch - dy * 0.01)));
  };
  const onPointerUp = () => { dragState.current = null; };
  const onWheel = (e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(4, z * (e.deltaY > 0 ? 0.92 : 1.08))));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 800, H = canvas.offsetHeight || 560;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // ── 3D → 2D 投影ヘルパー ──
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    // ロータ軸をワールドX軸に沿わせ、原点を全長の中心に置く
    const cx0 = totalLen / 2;
    const scale = Math.min(W, H) / (totalLen * 1.6) * zoom;
    const project = (x, y, z) => {
      // モデル座標: x=軸方向, y,z=断面内
      let px = x - cx0;
      // Yaw回転 (X-Z平面内)
      let rx = px * cosY - z * sinY;
      let rz = px * sinY + z * cosY;
      // Pitch回転 (X-Y平面内、実際にはY-Z')
      let ry = y * cosP - rz * sinP;
      let rz2 = y * sinP + rz * cosP;
      // 簡易パースペクティブ（奥のものを少し小さく）
      const persp = 1 / (1 + rz2 * 0.6);
      const sx = W / 2 + rx * scale * persp;
      const sy = H / 2 - ry * scale * persp;
      return { x: sx, y: sy, depth: rz2 };
    };

    // ── 円周点を生成するヘルパー（断面リング） ──
    const nSeg = 20;
    const ringPoints = (x, r) => {
      const pts = [];
      for (let i = 0; i <= nSeg; i++) {
        const th = (i / nSeg) * 2 * Math.PI;
        pts.push({ x, y: r * Math.cos(th), z: r * Math.sin(th) });
      }
      return pts;
    };

    // 描画要素をZバッファ的にまとめて、depthでソートしてから描く
    const drawables = [];

    // ── シャフト要素（円柱） ──
    shaftElems.forEach((el, i) => {
      const x0 = nodePositions[i], x1 = nodePositions[i + 1];
      const r = el.outerDiam / 2;
      const ring0 = ringPoints(x0, r).map(p => project(p.x, p.y, p.z));
      const ring1 = ringPoints(x1, r).map(p => project(p.x, p.y, p.z));
      const avgDepth = (ring0.reduce((s, p) => s + p.depth, 0) + ring1.reduce((s, p) => s + p.depth, 0)) / (ring0.length + ring1.length);
      drawables.push({
        depth: avgDepth,
        draw: () => {
          // 側面の帯（簡易シェーディング: yawに応じた明暗）
          ctx.fillStyle = COLORS.accent + '33';
          ctx.strokeStyle = COLORS.accent + 'AA';
          ctx.lineWidth = 1;
          for (let i2 = 0; i2 < nSeg; i2++) {
            ctx.beginPath();
            ctx.moveTo(ring0[i2].x, ring0[i2].y);
            ctx.lineTo(ring1[i2].x, ring1[i2].y);
            ctx.lineTo(ring1[i2 + 1].x, ring1[i2 + 1].y);
            ctx.lineTo(ring0[i2 + 1].x, ring0[i2 + 1].y);
            ctx.closePath();
            ctx.fill();
          }
          // 輪郭リング
          ctx.beginPath();
          ring0.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.stroke();
          ctx.beginPath();
          ring1.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.stroke();
        },
      });
    });

    // ── ディスク（円盤） ──
    disks.forEach(d => {
      const localOD = shaftElems.length > 0
        ? shaftElems.reduce((best, el, i) => {
            const x0 = nodePositions[i], x1 = nodePositions[i + 1];
            return (d.position >= x0 && d.position <= x1) ? el.outerDiam : best;
          }, maxOD)
        : maxOD;
      const r = Math.max(localOD / 2 * 1.9, localOD / 2 + 0.015);
      const thickness = Math.max(totalLen * 0.012, 0.006);
      const x0 = d.position - thickness / 2, x1 = d.position + thickness / 2;
      const ring0 = ringPoints(x0, r).map(p => project(p.x, p.y, p.z));
      const ring1 = ringPoints(x1, r).map(p => project(p.x, p.y, p.z));
      const avgDepth = (ring0.reduce((s, p) => s + p.depth, 0) + ring1.reduce((s, p) => s + p.depth, 0)) / (ring0.length + ring1.length);
      const color = d.color || DEFAULT_DISK_COLOR;
      drawables.push({
        depth: avgDepth + 0.001, // ほんの少し手前に描画優先
        draw: () => {
          ctx.fillStyle = color + '55';
          ctx.strokeStyle = color + 'DD';
          ctx.lineWidth = 1.3;
          for (let i2 = 0; i2 < nSeg; i2++) {
            ctx.beginPath();
            ctx.moveTo(ring0[i2].x, ring0[i2].y);
            ctx.lineTo(ring1[i2].x, ring1[i2].y);
            ctx.lineTo(ring1[i2 + 1].x, ring1[i2 + 1].y);
            ctx.lineTo(ring0[i2 + 1].x, ring0[i2 + 1].y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.beginPath();
          ring1.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.closePath();
          ctx.stroke();
        },
      });
    });

    // ── 軸受（ハウジングブロック＋支持脚。2D側面図の△▽支持マークに相当） ──
    bearings.forEach(b => {
      const localOD = shaftElems.reduce((best, el, i) => {
        const x0 = nodePositions[i], x1 = nodePositions[i + 1];
        return (b.position >= x0 && b.position <= x1) ? el.outerDiam : best;
      }, maxOD);
      const rShaft = localOD / 2;
      const rOuter = rShaft * 1.9;   // ハウジング外径
      const rInner = rShaft * 1.08;  // シャフトとの隙間
      const thickness = Math.max(totalLen * 0.035, 0.014); // ハウジングの軸方向厚み（太めのブロックにする）
      const xc = b.position;
      const x0 = xc - thickness / 2, x1 = xc + thickness / 2;

      const outer0 = ringPoints(x0, rOuter).map(p => project(p.x, p.y, p.z));
      const outer1 = ringPoints(x1, rOuter).map(p => project(p.x, p.y, p.z));
      const inner0 = ringPoints(x0, rInner).map(p => project(p.x, p.y, p.z));
      const inner1 = ringPoints(x1, rInner).map(p => project(p.x, p.y, p.z));
      const avgDepth = outer0.reduce((s, p) => s + p.depth, 0) / outer0.length;

      // 支持脚（4本、外周から放射状に伸びる棒。地面に固定されている印象を与える）
      const legLen = rOuter * 1.6;
      const legPts = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map(ang => {
        const base = { x: xc, y: rOuter * Math.cos(ang), z: rOuter * Math.sin(ang) };
        const tip  = { x: xc, y: legLen * Math.cos(ang), z: legLen * Math.sin(ang) };
        return {
          base: project(base.x, base.y, base.z),
          tip: project(tip.x, tip.y, tip.z),
          depth: project(base.x, base.y, base.z).depth,
        };
      });

      drawables.push({
        depth: avgDepth - 0.002, // 軸受は少し手前に優先描画（見やすさのため）
        draw: () => {
          // ハウジングの円筒側面（外周）
          ctx.fillStyle = COLORS.warning + '99';
          ctx.strokeStyle = COLORS.warning;
          ctx.lineWidth = 1.3;
          for (let i2 = 0; i2 < nSeg; i2++) {
            ctx.beginPath();
            ctx.moveTo(outer0[i2].x, outer0[i2].y);
            ctx.lineTo(outer1[i2].x, outer1[i2].y);
            ctx.lineTo(outer1[i2 + 1].x, outer1[i2 + 1].y);
            ctx.lineTo(outer0[i2 + 1].x, outer0[i2 + 1].y);
            ctx.closePath();
            ctx.fill();
          }
          // 前面・背面のドーナツ面（内側の穴を見せる）
          [[outer0, inner0], [outer1, inner1]].forEach(([outerRing, innerRing]) => {
            ctx.fillStyle = COLORS.warning + 'CC';
            ctx.beginPath();
            outerRing.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.closePath();
            innerRing.slice().reverse().forEach(p => ctx.lineTo(p.x, p.y));
            ctx.closePath();
            ctx.fill();
          });
          // 外周の輪郭線
          ctx.strokeStyle = COLORS.warning;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          outer0.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.closePath();
          ctx.stroke();
          ctx.beginPath();
          outer1.forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.closePath();
          ctx.stroke();

          // 支持脚（放射状の棒 — 固定支持であることを視覚的に強調）
          ctx.strokeStyle = COLORS.warning + 'CC';
          ctx.lineWidth = 2.2;
          legPts.forEach(leg => {
            ctx.beginPath();
            ctx.moveTo(leg.base.x, leg.base.y);
            ctx.lineTo(leg.tip.x, leg.tip.y);
            ctx.stroke();
            // 脚先端の固定点マーカー
            ctx.fillStyle = COLORS.warning;
            ctx.beginPath();
            ctx.arc(leg.tip.x, leg.tip.y, 3, 0, 2 * Math.PI);
            ctx.fill();
          });
        },
      });
    });

    // 中心軸線（基準線）
    const axisStart = project(0, 0, 0);
    const axisEnd = project(totalLen, 0, 0);
    drawables.push({
      depth: -999, // 最背面ではなく常に描画されるよう最初に処理してもOKだが、ここでは適当な深度
      draw: () => {
        ctx.strokeStyle = COLORS.border + '88';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(axisStart.x, axisStart.y);
        ctx.lineTo(axisEnd.x, axisEnd.y);
        ctx.stroke();
        ctx.setLineDash([]);
      },
    });

    // depthでソートして奥から手前へ描画（簡易Zソート、painter's algorithm）
    drawables.sort((a, b) => a.depth - b.depth);
    drawables.forEach(d => d.draw());

    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [shaftElems, disks, bearings, yaw, pitch, zoom]);

  const canvasEl = (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
      onMouseDown={onPointerDown}
      onMouseMove={onPointerMove}
      onMouseUp={onPointerUp}
      onMouseLeave={onPointerUp}
      onWheel={onWheel}
    />
  );

  const legendEl = (
    <div style={{
      position: 'absolute', bottom: 14, left: 14,
      background: COLORS.surface + 'EE', border: `1px solid ${COLORS.border}`,
      borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.accent + '55', border: `1px solid ${COLORS.accent}` }} />
        <span style={{ fontSize: 10, color: COLORS.textMuted }}>シャフト</span>
      </div>
      {disks.map((d, i) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: (d.color || DEFAULT_DISK_COLOR) + '55', border: `1px solid ${d.color || DEFAULT_DISK_COLOR}` }} />
          <span style={{ fontSize: 10, color: COLORS.textMuted }}>{d.name || `ディスク #${i + 1}`}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.warning + '55', border: `1px solid ${COLORS.warning}` }} />
        <span style={{ fontSize: 10, color: COLORS.textMuted }}>軸受</span>
      </div>
    </div>
  );

  if (inline) {
    // 右カラムに常設表示する簡易版（オーバーレイなし、閉じるボタンなし）
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 8 }}>
          ドラッグで回転・ホイールでズーム
        </div>
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {canvasEl}
          {legendEl}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000000CC', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: '86vw', height: '82vh', maxWidth: 1100,
        background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* ヘッダー */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 18px', borderBottom: `1px solid ${COLORS.border}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, fontFamily: 'JetBrains Mono' }}>
              3D モデルビュー
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>
              ドラッグで回転・ホイールでズーム
            </div>
          </div>
          <button onClick={onClose} style={{
            padding: '6px 14px', fontSize: 12, fontFamily: 'JetBrains Mono',
            background: 'transparent', color: COLORS.textMuted,
            border: `1px solid ${COLORS.border}`, borderRadius: 6, cursor: 'pointer',
          }}>
            ✕ 閉じる
          </button>
        </div>

        {/* Canvas本体 */}
        <div style={{ flex: 1, position: 'relative' }}>
          {canvasEl}
          {legendEl}
        </div>
      </div>
    </div>
  );
}
