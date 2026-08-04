// ─── Whirl Orbit Visualizer ───
// ④周波数応答解析・②複素固有値解析の結果から、指定モードのふれまわり軌跡を可視化する。
// シャフト側面図アニメーション(Canvas 1)と断面ふれまわり軌道図(Canvas 2)の2枚を描画する。
// このコンポーネント自身は解析ロジックを持たず、complexResults(②の結果配列)を受け取るだけ。
import { useState, useEffect, useRef } from "react";
import { COLORS } from "./chartTheme.js";

export function WhirlOrbitVisualizer({ complexResults, selectedMode, nodePositions, disks, bearings, settings }) {
  const canvasAnimRef = useRef();   // アニメーション canvas (シャフト側面図)
  const canvasOrbitRef = useRef();  // 静止軌跡 canvas (断面ふれまわり軌道図)
  // 実際にレイアウトされた幅をキャッシュしておく（アニメーション中は毎フレーム描画するため、
  // 都度clientWidthを読むと強制リフローが毎フレーム発生してしまう。ResizeObserverで
  // リサイズ時だけ更新し、描画自体はrefを読むだけにして負荷を避ける）
  const animWRef = useRef(500);
  const orbitWRef = useRef(500);
  useEffect(() => {
    const c1 = canvasAnimRef.current, c2 = canvasOrbitRef.current;
    const ros = [];
    if (c1) {
      c1.style.width = '100%'; c1.style.maxWidth = '500px';
      const ro1 = new ResizeObserver(entries => {
        for (const e of entries) animWRef.current = Math.max(240, Math.round(e.contentRect.width) || 500);
      });
      ro1.observe(c1); ros.push(ro1);
    }
    if (c2) {
      // このcanvasは断面数に応じて明示的なpx幅を持たせ、必要なら親のスクロール領域内で
      // はみ出させる方式（100%にはしない）。そのため監視するのは親(スクロールラッパー)の幅。
      const target = c2.parentElement || c2;
      const ro2 = new ResizeObserver(entries => {
        for (const e of entries) orbitWRef.current = Math.max(240, Math.round(e.contentRect.width) || 500);
      });
      ro2.observe(target); ros.push(ro2);
    }
    return () => ros.forEach(ro => ro.disconnect());
  }, []);
  const animRef = useRef();
  const [animating, setAnimating] = useState(false);
  const [animPhase, setAnimPhase] = useState(0);
  const [animSpeed, setAnimSpeed] = useState(2.2);   // アニメーション速度 [rad/s]（見た目の角速度。モード固有のω・Ωの大きさとは無関係の固定値）
  const [selectedNodes, setSelectedNodes] = useState(null); // null=自動(変位上位3), 配列=手動選択ノード番号
  const [orbitView, setOrbitView] = useState('cog'); // 'cog'=重心軌跡(楕円) | 'surface'=シャフト表面マーク点軌跡(花びら, Backwardで顕著)
  const [markCycles, setMarkCycles] = useState(3); // シャフト表面マーク点モードの描画周回数（公転周期の何倍か）

  // カラーパレット（アプリ全体の COLORS テーマに追従）
  const PC = {
    bg: COLORS.surface, text: COLORS.textBright, textMuted: COLORS.textMuted, border: COLORS.border,
    accent: COLORS.accent, purple: COLORS.purple, warning: COLORS.warning, success: COLORS.success, danger: COLORS.danger,
  };

  const modeData = complexResults?.[selectedMode];
  // 公転角速度 ω [rad/s]、自転角速度 Ω [rad/s]
  const omega_whirl = modeData ? modeData.omega : 100;           // ふれまわり ω
  const Omega_spin  = settings ? (settings.maxRpm * Math.PI / 30) : omega_whirl; // 自転 Ω

  // ── アニメーションループ ──
  useEffect(() => {
    if (!animating) { cancelAnimationFrame(animRef.current); return; }
    let last = null;
    const loop = t => {
      // 位相(animPhase)は「公転の見た目上の位相」であり、実際の物理速度ωには依存させない。
      // 高次モードほどωが大きくなるため、従来のように増分をωに比例させると
      // スライダーを最遅にしてもコマ送りのように速く回ってしまう問題があったための変更。
      // ※自転マーク点の周回比（Ω/ω）は ph_now_spin = Ω·(animPhase/ω) の式でそのまま物理的に正しく保たれる。
      if (last !== null) setAnimPhase(p => (p + (t - last) * 0.001 * animSpeed) % (2 * Math.PI));
      last = t;
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [animating, omega_whirl, animSpeed]);

  // ── モード変更時にリセット ──
  useEffect(() => { setAnimPhase(0); setAnimating(false); }, [selectedMode]);

  // ─────────────────────────────────────────
  // 共通: モードベクトル取得
  // ─────────────────────────────────────────
  const getDispVectors = () => {
    if (!modeData?.mode || !nodePositions) return null;
    const phi = modeData.mode;
    // DOF: n*4=Vy, n*4+1=θz, n*4+2=Vz, n*4+3=θy
    const yDisps = nodePositions.map((_, n) => (phi[n*4]   || 0));
    const zDisps = nodePositions.map((_, n) => (phi[n*4+2] || 0));
    const maxAmp = Math.max(...nodePositions.map((_, n) => Math.sqrt(yDisps[n]**2 + zDisps[n]**2)), 1e-12);
    // 正規化
    return { yDisps: yDisps.map(v => v/maxAmp), zDisps: zDisps.map(v => v/maxAmp) };
  };

  // ─────────────────────────────────────────
  // Canvas 1: シャフト側面図アニメーション
  // 自転Ωと公転ωの合成 → 各ノードの瞬時変位
  //   公転: r_whirl(t) = A·cos(ω·t)  [y方向]
  //         r_whirl(t) = A·sin(ω·t)  [z方向] (Forward) / -sin (Backward)
  //   シャフト表面マーカー (自転): 半径R上の点
  //     px = R·cos(Ω·t), py = R·sin(Ω·t)
  //   合成変位: y_total = A·cos(ω·t) + R·cos(Ω·t) ← 側面図では y成分のみ表示
  // ─────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasAnimRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // 実際の表示幅はCSS側(100%、上限500px)に任せ、キャッシュしておいた実測幅(ResizeObserver由来)を
    // canvasの内部解像度・描画座標の計算に使う（毎フレーム強制リフローを避けるため）。
    const W = animWRef.current || 500, H = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W*dpr; canvas.height = H*dpr;
    canvas.style.height = H+'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = PC.bg; ctx.fillRect(0,0,W,H);

    if (!modeData || !nodePositions) return;
    const vecs = getDispVectors();
    if (!vecs) return;
    const { yDisps, zDisps } = vecs;

    const totalLen = nodePositions[nodePositions.length-1] || 1;
    const nNodes   = nodePositions.length;
    const padL=52, padR=18, padT=26, padB=28;
    const PW = W-padL-padR, PH = H-padT-padB;
    const tx = x => padL + (x/totalLen)*PW;
    const cy = padT + PH/2;

    const dir = modeData.isForward ? 1 : -1;
    const ph  = animPhase;

    // 公転による瞬時 y 変位 (側面図は y 成分のみ)
    // y(t) = yDisp·cos(ω·t) - dir·zDisp·sin(ω·t)
    const instY = nodePositions.map((_,n) =>
      yDisps[n]*Math.cos(ph) - dir*zDisps[n]*Math.sin(ph)
    );
    const scaleD = PH * 0.38;

    // タイトル
    const modeColor = modeData.isForward ? PC.accent : PC.purple;
    ctx.fillStyle = PC.text; ctx.font = '500 11px Inter'; ctx.textAlign='left';
    const ratioStr = (Math.abs(omega_whirl)/Math.max(Omega_spin,1)).toFixed(2);
    const modeLabel = `Mode ${modeData.undampedModeIdx+1}${modeData.isForward?'F':'B'}`;
    ctx.fillText(
      `${modeLabel}: ${modeData.freq.toFixed(1)} Hz  `+
      `${modeData.isForward?'↻ Forward':'↺ Backward'}  ω/Ω=${ratioStr}`,
      padL, 17
    );

    // グリッド
    ctx.strokeStyle = PC.border+'44'; ctx.lineWidth=0.5;
    [-2,-1,0,1,2].forEach(i => {
      ctx.beginPath(); ctx.moveTo(padL, cy+i*PH/4); ctx.lineTo(padL+PW, cy+i*PH/4); ctx.stroke();
    });
    ctx.strokeStyle=PC.border+'88'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(padL,cy); ctx.lineTo(padL+PW,cy); ctx.stroke();
    ctx.setLineDash([]);

    // 軸ラベル
    ctx.fillStyle=PC.textMuted; ctx.font='9px JetBrains Mono'; ctx.textAlign='center';
    for (let i=0;i<=4;i++){
      const xp=nodePositions[Math.round(i*(nNodes-1)/4)];
      if(xp!==undefined) ctx.fillText((xp*1000).toFixed(0)+'mm', tx(xp), H-8);
    }
    ctx.save(); ctx.translate(13,cy); ctx.rotate(-Math.PI/2);
    ctx.fillText('変位 [norm]',0,0); ctx.restore();

    // 包絡線（全周 nTrail ステップ）
    const nTrail=48;
    for(let ti=0;ti<nTrail;ti++){
      const ph2=(ti/nTrail)*2*Math.PI;
      const trY=nodePositions.map((_,n)=>yDisps[n]*Math.cos(ph2)-dir*zDisps[n]*Math.sin(ph2));
      const alpha=0.04+0.08*(ti/nTrail);
      ctx.strokeStyle=modeColor+Math.round(alpha*255).toString(16).padStart(2,'0');
      ctx.lineWidth=0.8;
      ctx.beginPath();
      nodePositions.forEach((xpos,n)=>{
        const px=tx(xpos), py=cy-trY[n]*scaleD;
        n===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
      });
      ctx.stroke();
    }

    // 軸受
    bearings.forEach(b=>{
      const xi=tx(b.position);
      ctx.strokeStyle=PC.warning+'AA'; ctx.lineWidth=1.5; ctx.setLineDash([3,2]);
      ctx.beginPath(); ctx.moveTo(xi,padT); ctx.lineTo(xi,H-padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=PC.warning; ctx.font='8px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText('Brg',xi,padT+8);
    });
    // ディスク
    disks.forEach(d=>{
      const xi=tx(d.position);
      ctx.strokeStyle='#A78BFA55'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(xi,cy-16); ctx.lineTo(xi,cy+16); ctx.stroke();
    });

    // 現在形状
    ctx.strokeStyle=modeColor; ctx.lineWidth=2.5;
    ctx.beginPath();
    nodePositions.forEach((xpos,n)=>{
      const px=tx(xpos), py=cy-instY[n]*scaleD;
      n===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    });
    ctx.stroke();

    // 最大変位ノードマーカー
    const maxN=yDisps.reduce((mi,v,i)=>Math.abs(v)>Math.abs(yDisps[mi])?i:mi,0);
    ctx.fillStyle=modeColor;
    ctx.beginPath(); ctx.arc(tx(nodePositions[maxN]), cy-instY[maxN]*scaleD, 5, 0, 2*Math.PI); ctx.fill();

  }, [complexResults, selectedMode, animPhase, nodePositions, disks, bearings, settings, animSpeed]);

  // ─────────────────────────────────────────
  // Canvas 2: ふれまわり軌跡（静止断面図）
  // 各ノード（パーツの重心）が固定座標系で実際に描く軌跡＝1本の閉じた楕円。
  //   x_orb(t) = Ay·cos(ω·t) − dir·Az·sin(ω·t)
  //   y_orb(t) = Ay·sin(ω·t) + dir·Az·cos(ω·t)
  // dir=+1 (Forward): 反時計回り、dir=-1 (Backward): 時計回り
  // ─────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasOrbitRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const vecs = getDispVectors();
    if (!vecs || !modeData) {
      const W=orbitWRef.current||500,H=200;
      canvas.width=W; canvas.height=H;
      canvas.style.width=W+'px'; canvas.style.height=H+'px';
      ctx.fillStyle=PC.bg; ctx.fillRect(0,0,W,H);
      return;
    }
    const { yDisps, zDisps } = vecs;

    // 代表ノード: 選択がなければ変位上位3、選択があればそれを使用
    let topNodes;
    if (selectedNodes && selectedNodes.length > 0) {
      topNodes = selectedNodes.filter(n => n >= 0 && n < nodePositions.length);
    } else {
      const nodeAmps=nodePositions.map((_,n)=>({n,amp:Math.sqrt(yDisps[n]**2+zDisps[n]**2)}));
      nodeAmps.sort((a,b)=>b.amp-a.amp);
      const topN=Math.min(3,nodePositions.length);
      topNodes = nodeAmps.slice(0,topN).map(x=>x.n);
    }
    if (topNodes.length === 0) topNodes = [0]; // フォールバック

    // 断面数の上限は設けない代わりに、選んだ数に応じてcanvas幅を広げる
    // （幅を固定したままセルを詰めると、断面数が多いときに図が潰れて読めなくなるため）。
    // 逆に、断面数が少ない時の基準幅は実際の画面幅(スマホ等)に合わせて縮める
    // （そうしないと1〜2断面だけでもスマホ画面よりはみ出してしまうため）。
    const minCellW = 110;
    const availW = orbitWRef.current || 500;
    const baseW = Math.min(500, availW);
    const W = Math.max(baseW, topNodes.length * minCellW), H = 234;
    const dpr=window.devicePixelRatio||1;
    canvas.width=W*dpr; canvas.height=H*dpr;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    ctx.scale(dpr,dpr);
    ctx.fillStyle=PC.bg; ctx.fillRect(0,0,W,H);

    const cellW=W/topNodes.length;
    const modeColor=modeData.isForward?PC.accent:PC.purple;
    const dir=modeData.isForward?1:-1;

    const titleStr = orbitView==='cog'
      ? '重心の振れまわり軌跡（固定座標系・ふれまわり成分のみ）'
      : 'シャフト表面マーク点の軌跡（自転Ω＋公転ωの合成・固定座標系）';
    ctx.fillStyle=PC.textMuted; ctx.font='10px Inter'; ctx.textAlign='center';
    ctx.fillText(titleStr, W/2, 14);

    // ── シャフト表面点モード用: 軌跡が閉じる周期を有理数近似で求める ──
    // 自転Ωは常に正方向、公転は dir·ω（Forwardは同方向、Backwardは逆方向）。
    // 固定座標系で見たマーク点の角速度差は (dir·ω − Ω)。
    // ω/Ω が有理数 p/q に近いとき、q×(2π/ω) で軌道が閉じる。
    let T_total = 2*Math.PI/Math.max(omega_whirl,1e-6); // cogモードは1周で十分
    let nPts = 140;
    let bestQ = 1; // 完全に閉じる理論上の周回数（参考表示用）
    if (orbitView === 'surface') {
      const ratio = Math.abs(omega_whirl/Math.max(Math.abs(Omega_spin),1e-6));
      let bestErr=Infinity;
      for (let q=1; q<=200; q++){
        const p=Math.round(ratio*q);
        if (p===0) continue;
        const err=Math.abs(ratio - p/q);
        if (err<bestErr){ bestErr=err; bestQ=q; if(err<1e-6) break; }
      }
      const T_omega = 2*Math.PI/Math.max(omega_whirl,1e-6);
      // 実際の描画周期はユーザー指定の周回数(markCycles)を使用。
      // bestQはあくまで「理論上ぴったり閉じる周回数」の参考値として別途表示する。
      T_total = markCycles * T_omega;
      nPts = Math.min(6000, Math.max(300, markCycles*150));
    }

    topNodes.forEach((n,idx)=>{
      const cx=cellW*idx+cellW/2;
      const cy=H/2+8;
      const r=Math.min(cellW,H)*0.36;
      const Ay=yDisps[n], Az=zDisps[n];
      const maxA=Math.max(Math.abs(Ay),Math.abs(Az),1e-12);
      const sc=r/maxA;

      // 軸
      ctx.strokeStyle=PC.border+'66'; ctx.lineWidth=0.5;
      ctx.beginPath(); ctx.moveTo(cx-r*1.15,cy); ctx.lineTo(cx+r*1.15,cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx,cy-r*1.15); ctx.lineTo(cx,cy+r*1.15); ctx.stroke();
      // 参照円
      ctx.strokeStyle=PC.border+'33'; ctx.lineWidth=0.5;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,2*Math.PI); ctx.stroke();

      if (orbitView === 'cog') {
        // ① 重心の振れまわり軌跡（公転のみ）→ 楕円
        ctx.strokeStyle=modeColor+'AA'; ctx.lineWidth=1.8;
        ctx.beginPath();
        for(let i=0;i<=nPts;i++){
          const ph=(i/nPts)*2*Math.PI;
          const ox=(Ay*Math.cos(ph)-dir*Az*Math.sin(ph))*sc;
          const oy=-(dir*Ay*Math.sin(ph)+Az*Math.cos(ph))*sc;
          i===0?ctx.moveTo(cx+ox,cy+oy):ctx.lineTo(cx+ox,cy+oy);
        }
        ctx.closePath(); ctx.stroke();
        ctx.fillStyle=modeColor+'14'; ctx.fill();

        // 回転方向の矢印
        const ph0 = Math.PI*0.25;
        const ph1 = ph0 + (dir>0 ? 0.18 : -0.18);
        const p0x=(Ay*Math.cos(ph0)-dir*Az*Math.sin(ph0))*sc, p0y=-(dir*Ay*Math.sin(ph0)+Az*Math.cos(ph0))*sc;
        const p1x=(Ay*Math.cos(ph1)-dir*Az*Math.sin(ph1))*sc, p1y=-(dir*Ay*Math.sin(ph1)+Az*Math.cos(ph1))*sc;
        const aAng=Math.atan2(p1y-p0y,p1x-p0x);
        ctx.strokeStyle=modeColor; ctx.lineWidth=1.5;
        ctx.beginPath();
        ctx.moveTo(cx+p1x+Math.cos(aAng+2.5)*6, cy+p1y+Math.sin(aAng+2.5)*6);
        ctx.lineTo(cx+p1x, cy+p1y);
        ctx.lineTo(cx+p1x+Math.cos(aAng-2.5)*6, cy+p1y+Math.sin(aAng-2.5)*6);
        ctx.stroke();

        // 現在位置
        const ph_now=animPhase;
        const ox_now=(Ay*Math.cos(ph_now)-dir*Az*Math.sin(ph_now))*sc;
        const oy_now=(dir*Ay*Math.sin(ph_now)+Az*Math.cos(ph_now))*sc;
        ctx.fillStyle=modeColor;
        ctx.beginPath(); ctx.arc(cx+ox_now,cy-oy_now,4.5,0,2*Math.PI); ctx.fill();
        ctx.strokeStyle=PC.bg; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.arc(cx+ox_now,cy-oy_now,4.5,0,2*Math.PI); ctx.stroke();

      } else {
        // ② シャフト表面マーク点の軌跡（自転Ω＋公転ωの合成）→ Backwardで花びら
        // 自転Ωは常に正方向（反時計回り）が基準。マーク点はシャフト表面の半径 eps（視覚化用）。
        //   重心位置: x_orb(t)=Ay·cos(ωt)-dir·Az·sin(ωt),  y_orb(t)=dir·Ay·sin(ωt)+Az·cos(ωt)
        //   ※以前は y_orb 側の dir の掛け方が誤っており(Az·cos側に付いていた)、
        //     Forward/Backwardどちらの式も回転方向が常にCCWになってしまうバグがあった。
        //     （dirをAy·sin側に掛けることで、位相反転(θ→-θ)として正しくCW/CCWが分岐する）
        //   マーク点: x_mark(t) = x_orb(t) + eps·cos(Ω t),  y_mark(t) = y_orb(t) + eps·sin(Ω t)
        const eps = maxA*0.22;
        ctx.strokeStyle=modeColor+'CC'; ctx.lineWidth=1.1;
        ctx.beginPath();
        for(let i=0;i<=nPts;i++){
          const t=(i/nPts)*T_total;
          const ph_orb=omega_whirl*t;
          const ph_spin=Omega_spin*t;
          const x_orb=(Ay*Math.cos(ph_orb)-dir*Az*Math.sin(ph_orb))*sc;
          const y_orb=(dir*Ay*Math.sin(ph_orb)+Az*Math.cos(ph_orb))*sc;
          const x_mark=x_orb+eps*sc*Math.cos(ph_spin);
          const y_mark=y_orb+eps*sc*Math.sin(ph_spin);
          i===0?ctx.moveTo(cx+x_mark,cy-y_mark):ctx.lineTo(cx+x_mark,cy-y_mark);
        }
        ctx.stroke();

        // 重心軌跡を薄く参考表示（楕円の中心線）
        ctx.strokeStyle=PC.textMuted+'55'; ctx.lineWidth=0.8; ctx.setLineDash([3,3]);
        ctx.beginPath();
        for(let i=0;i<=120;i++){
          const ph=(i/120)*2*Math.PI;
          const ox=(Ay*Math.cos(ph)-dir*Az*Math.sin(ph))*sc;
          const oy=-(dir*Ay*Math.sin(ph)+Az*Math.cos(ph))*sc;
          i===0?ctx.moveTo(cx+ox,cy+oy):ctx.lineTo(cx+ox,cy+oy);
        }
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);

        // 現在位置（重心 + マーク点）
        const ph_now_orb=animPhase;
        const ph_now_spin=Omega_spin*(animPhase/Math.max(omega_whirl,1e-6));
        const ox_now=(Ay*Math.cos(ph_now_orb)-dir*Az*Math.sin(ph_now_orb))*sc;
        const oy_now=(dir*Ay*Math.sin(ph_now_orb)+Az*Math.cos(ph_now_orb))*sc;
        const mx_now=ox_now+eps*sc*Math.cos(ph_now_spin);
        const my_now=oy_now+eps*sc*Math.sin(ph_now_spin);
        // 連結線
        ctx.strokeStyle=PC.textMuted+'88'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(cx+ox_now,cy-oy_now); ctx.lineTo(cx+mx_now,cy-my_now); ctx.stroke();
        // 重心点
        ctx.fillStyle=PC.textMuted;
        ctx.beginPath(); ctx.arc(cx+ox_now,cy-oy_now,3,0,2*Math.PI); ctx.fill();
        // マーク点
        ctx.fillStyle=modeColor;
        ctx.beginPath(); ctx.arc(cx+mx_now,cy-my_now,4.5,0,2*Math.PI); ctx.fill();
        ctx.strokeStyle=PC.bg; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.arc(cx+mx_now,cy-my_now,4.5,0,2*Math.PI); ctx.stroke();
      }

      // ノードラベル
      ctx.fillStyle=PC.textMuted; ctx.font='8px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText(`Node ${n}  x=${(nodePositions[n]*1000).toFixed(0)}mm`, cx, H-6);
    });

    // 凡例
    ctx.textAlign='left';
    ctx.fillStyle=modeColor; ctx.font='9px Inter';
    if (orbitView === 'cog') {
      ctx.fillText(`─ 重心の振れまわり軌跡 (${modeData.isForward?'Forward 反時計回り':'Backward 時計回り'})`, 8, H-12);
    } else {
      ctx.fillText(`─ シャフト表面マーク点の軌跡 (${modeData.isForward?'Forward':'Backward'}, ω=${modeData.freq.toFixed(1)}Hz / Ω=${(Omega_spin/2/Math.PI).toFixed(1)}Hz)`, 8, H-12);
      ctx.fillStyle=PC.textMuted; ctx.font='8px JetBrains Mono';
      ctx.fillText(`完全に閉じる理論周回数: ${bestQ}周 （現在表示: ${markCycles}周）`, 8, H-2);
    }

  }, [complexResults, selectedMode, animPhase, nodePositions, settings, selectedNodes, orbitView, markCycles]);

  return (
    <div>
      {/* アニメーション: シャフト側面図 */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 6 }}>
          シャフト側面図（公転アニメーション）
        </div>
        <canvas ref={canvasAnimRef} style={{ borderRadius:8, display:'block', border:`1px solid ${COLORS.border}` }} />
      </div>

      {/* コントロール */}
      <div style={{ display:'flex', gap:10, marginBottom:8, alignItems:'center', flexWrap:'wrap' }}>
        <button onClick={()=>setAnimating(a=>!a)} style={{
          padding:'6px 18px', fontSize:11, fontFamily:'JetBrains Mono',
          background: animating?COLORS.danger+'22':COLORS.accent+'22',
          color: animating?COLORS.danger:COLORS.accent,
          border:`1px solid ${animating?COLORS.danger+'66':COLORS.accent+'66'}`,
          borderRadius:6, cursor:'pointer',
        }}>
          {animating?'⏹ 停止':'▶ アニメーション'}
        </button>
        <div style={{ fontSize:10, color:COLORS.textMuted, fontFamily:'JetBrains Mono' }}>
          ω={modeData?.freq.toFixed(1)??'—'} Hz &nbsp;|&nbsp;
          Ω={(settings?.maxRpm/60).toFixed(1)??'—'} Hz &nbsp;|&nbsp;
          ω/Ω={(modeData&&settings)?(modeData.omega/(settings.maxRpm*Math.PI/30)).toFixed(2):'—'} &nbsp;|&nbsp;
          {modeData?.isForward?'↻ Forward':'↺ Backward'}
        </div>
      </div>

      {/* スライダー: アニメーション速度 */}
      <div style={{
        marginBottom:14, padding:'10px 12px',
        background: COLORS.surface2, borderRadius:6, border:`1px solid ${COLORS.border}`,
        maxWidth: 320,
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:10, color:COLORS.textMuted }}>アニメーション速度（モードのωによらず一定）</span>
          <span style={{ fontSize:10, color:COLORS.accent, fontFamily:'JetBrains Mono' }}>{(2*Math.PI/animSpeed).toFixed(1)}秒/周</span>
        </div>
        <input
          type="range" min="0.3" max="6.0" step="0.1"
          value={animSpeed}
          onChange={e => setAnimSpeed(parseFloat(e.target.value))}
          style={{ width:'100%' }}
        />
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:8, color:COLORS.textMuted, marginTop:2 }}>
          <span>ゆっくり</span><span>速い</span>
        </div>
      </div>

      {/* 軌跡の種類トグル */}
      <div style={{ display:'flex', gap:8, marginBottom:10 }}>
        <button onClick={() => setOrbitView('cog')} style={{
          flex: 1, padding: '8px 12px', fontSize: 11, fontFamily: 'JetBrains Mono',
          borderRadius: 6, cursor: 'pointer',
          background: orbitView==='cog' ? COLORS.accent+'22' : 'transparent',
          color: orbitView==='cog' ? COLORS.accent : COLORS.textMuted,
          border: `1px solid ${orbitView==='cog' ? COLORS.accent+'88' : COLORS.border}`,
        }}>
          ① 重心の振れまわり軌跡（楕円）
        </button>
        <button onClick={() => setOrbitView('surface')} style={{
          flex: 1, padding: '8px 12px', fontSize: 11, fontFamily: 'JetBrains Mono',
          borderRadius: 6, cursor: 'pointer',
          background: orbitView==='surface' ? COLORS.accent+'22' : 'transparent',
          color: orbitView==='surface' ? COLORS.accent : COLORS.textMuted,
          border: `1px solid ${orbitView==='surface' ? COLORS.accent+'88' : COLORS.border}`,
        }}>
          ② シャフト表面マーク点の軌跡（Backwardで花びら状）
        </button>
      </div>
      <div style={{ fontSize: 9, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
        {orbitView === 'cog'
          ? '①は各パーツの重心がふれまわり運動だけで描く軌跡（公転成分のみ）。Forward/Backwardいずれも閉じた楕円になります。'
          : '②はシャフト表面に印を付けた点（自転Ωを伴う）が固定座標系で描く軌跡。自転と公転が逆方向のBackwardでは、両者の相対運動により花びら状のパターンが現れます。'}
      </div>

      {/* マーク点モード専用: 周回数スライダー（重なりすぎ対策） */}
      {orbitView === 'surface' && (
        <div style={{
          marginBottom:14, padding:'10px 12px',
          background: COLORS.surface2, borderRadius:6, border:`1px solid ${COLORS.border}`,
          maxWidth: 380,
        }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <span style={{ fontSize:10, color:COLORS.textMuted }}>軌跡の周回数（公転周期の倍数）</span>
            <span style={{ fontSize:10, color:COLORS.accent, fontFamily:'JetBrains Mono' }}>{markCycles} 周</span>
          </div>
          <input
            type="range" min="1" max="40" step="1"
            value={markCycles}
            onChange={e => setMarkCycles(parseInt(e.target.value))}
            style={{ width:'100%' }}
          />
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:8, color:COLORS.textMuted, marginTop:2 }}>
            <span>少ない（形が見やすい）</span><span>多い（完全な閉軌道に近づく）</span>
          </div>
          <div style={{ fontSize:8, color:COLORS.textMuted, marginTop:4 }}>
            高次モードでは ω/Ω が複雑な比になり、完全に閉じるまでの周回数が非常に大きくなることがあります。
            まずは少ない周回数（2〜5周）で花びらの基本形を確認し、必要なら増やしてください。
          </div>
        </div>
      )}

      {/* 断面（ノード）選択 */}
      <div style={{
        marginBottom: 10, padding:'10px 12px',
        background: COLORS.surface2, borderRadius:6, border:`1px solid ${COLORS.border}`,
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
          <span style={{ fontSize:10, color:COLORS.textMuted }}>
            表示する断面（未選択時は変位上位3を自動表示。選んだ数に応じて図の幅が広がります）
          </span>
          {selectedNodes && selectedNodes.length > 0 && (
            <button onClick={() => setSelectedNodes(null)} style={{
              fontSize: 9, padding: '3px 8px', background: 'transparent',
              border: `1px solid ${COLORS.border}`, borderRadius: 4,
              color: COLORS.textMuted, cursor: 'pointer',
            }}>
              自動選択に戻す
            </button>
          )}
        </div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          {(nodePositions || []).map((xpos, n) => {
            // このノード近傍のディスク・軸受名を取得
            const nearDisk = disks.find(d => Math.abs(d.position - xpos) < 0.02);
            const nearBrg  = bearings.find(b => Math.abs(b.position - xpos) < 0.02);
            let tag = nearBrg ? (nearBrg.name || '軸受') : (nearDisk ? (nearDisk.name || 'ディスク') : null);
            const checked = selectedNodes ? selectedNodes.includes(n) : false;
            return (
              <button
                key={n}
                onClick={() => {
                  setSelectedNodes(prev => {
                    const cur = prev || [];
                    if (cur.includes(n)) return cur.filter(x => x !== n);
                    return [...cur, n];
                  });
                }}
                style={{
                  padding: '5px 10px', fontSize: 9, fontFamily: 'JetBrains Mono',
                  borderRadius: 5, cursor: 'pointer',
                  background: checked ? COLORS.accent + '22' : 'transparent',
                  color: checked ? COLORS.accent : COLORS.textMuted,
                  border: `1px solid ${checked ? COLORS.accent + '88' : COLORS.border}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, minWidth: 56,
                }}>
                <span>Node {n}</span>
                <span style={{ fontSize: 8, opacity: 0.8 }}>{(xpos*1000).toFixed(0)}mm</span>
                {tag && <span style={{ fontSize: 8, color: nearBrg ? COLORS.warning : COLORS.purple }}>{tag}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* 静止軌跡図: 断面ふれまわり軌道 */}
      <div>
        <div style={{ fontSize:10, color:COLORS.textMuted, marginBottom:6 }}>
          ふれまわり軌跡（断面ビュー）— 各パーツ（重心）が描く実際の振れまわり軌道
        </div>
        <div style={{ overflowX: 'auto', borderRadius: 8 }}>
          <canvas ref={canvasOrbitRef} style={{ borderRadius:8, display:'block', border:`1px solid ${COLORS.border}` }} />
        </div>
      </div>
    </div>
  );
}
