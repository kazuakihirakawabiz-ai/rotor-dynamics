// ─────────────────────────────────────────────
// FEM CORE  (共通基盤: 要素マトリクス組立 + 線形代数)
// ①固有値解析・②複素固有値解析・③キャンベル線図・④周波数応答解析、
// すべてがこのモジュールの assembleSystem() で組み立てた M, K, G, Kb, Cb を使う。
// ─────────────────────────────────────────────

// ── Helpers ──
export function zeros(n, m) { return Array.from({length:n}, () => new Array(m).fill(0)); }
export function matAdd(A, B) { return A.map((r,i) => r.map((v,j) => v + B[i][j])); }
export function matScale(A, s) { return A.map(r => r.map(v => v * s)); }

// ── Euler-Bernoulli beam element  (4-DOF/node: vy θz vz θy) ──
export function beamElementMatrices(L, E, I, rho, A_area) {
  const EI = E * I, L2 = L*L, L3 = L*L*L;
  const m = (rho * A_area * L) / 420;
  const ke = (EI/L3);
  // 8×8 stiffness (y-plane + z-plane coupled via DOF ordering)
  const Ke = [
    [ 12*ke,  6*L*ke,   0,       0,      -12*ke,  6*L*ke,   0,       0      ],
    [ 6*L*ke, 4*L2*ke,  0,       0,      -6*L*ke, 2*L2*ke,  0,       0      ],
    [ 0,      0,        12*ke,  -6*L*ke,  0,       0,       -12*ke, -6*L*ke  ],
    [ 0,      0,       -6*L*ke,  4*L2*ke, 0,       0,        6*L*ke, 2*L2*ke ],
    [-12*ke, -6*L*ke,   0,       0,       12*ke,  -6*L*ke,   0,       0      ],
    [ 6*L*ke, 2*L2*ke,  0,       0,      -6*L*ke,  4*L2*ke,  0,       0      ],
    [ 0,      0,       -12*ke,   6*L*ke,  0,       0,        12*ke,   6*L*ke  ],
    [ 0,      0,       -6*L*ke,  2*L2*ke, 0,       0,        6*L*ke,  4*L2*ke ],
  ];
  const Me = [
    [156*m,  22*L*m,  0,       0,       54*m,   -13*L*m,  0,       0       ],
    [22*L*m,  4*L2*m, 0,       0,       13*L*m,  -3*L2*m, 0,       0       ],
    [0,       0,      156*m,  -22*L*m,  0,        0,       54*m,   13*L*m  ],
    [0,       0,      -22*L*m,  4*L2*m, 0,        0,       13*L*m, -3*L2*m ],
    [54*m,   13*L*m,  0,       0,      156*m,   -22*L*m,   0,       0       ],
    [-13*L*m,-3*L2*m, 0,       0,      -22*L*m,   4*L2*m,  0,       0       ],
    [0,       0,       54*m,  -13*L*m,  0,        0,      156*m,   22*L*m  ],
    [0,       0,       13*L*m, -3*L2*m, 0,        0,       22*L*m,  4*L2*m  ],
  ];
  return { Ke, Me };
}

// ── Assemble global matrices ──
export function assembleSystem(shaftElements, disks, bearings) {
  const nElem = shaftElements.length;
  const nNodes = nElem + 1;
  const nDOF = nNodes * 4;
  const K = zeros(nDOF, nDOF);
  const M = zeros(nDOF, nDOF);
  const G = zeros(nDOF, nDOF);
  const Cb = zeros(nDOF, nDOF);
  const Kb = zeros(nDOF, nDOF);

  shaftElements.forEach((el, e) => {
    const L = el.length;
    const D = el.outerDiam, d = el.innerDiam;
    const E = el.youngMod * 1e9;
    const rho = el.density;
    const I = Math.PI * (Math.pow(D,4) - Math.pow(d,4)) / 64;
    const A_area = Math.PI * (D*D - d*d) / 4;
    const { Ke, Me } = beamElementMatrices(L, E, I, rho, A_area);
    const base = e * 4;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      K[base+i][base+j] += Ke[i][j];
      M[base+i][base+j] += Me[i][j];
    }
  });

  const nodePositions = [0];
  shaftElements.forEach(el => nodePositions.push(nodePositions[nodePositions.length-1] + el.length));
  const findNode = x => {
    let best = 0, bd = Infinity;
    nodePositions.forEach((xn,i) => { const d=Math.abs(xn-x); if(d<bd){bd=d;best=i;} });
    return best;
  };

  disks.forEach(disk => {
    const n = findNode(disk.position);
    const cnt = disk.count || 1;
    const tm = disk.mass * cnt, tJp = disk.polarInertia * cnt, tJd = disk.diametralInertia * cnt;
    M[n*4][n*4]   += tm; M[n*4+2][n*4+2] += tm;
    M[n*4+1][n*4+1] += tJd; M[n*4+3][n*4+3] += tJd;
    G[n*4+1][n*4+3] += tJp; G[n*4+3][n*4+1] -= tJp;

    // ── RD流体力係数 (ロータダイナミック係数) ──
    // 運動方程式: M_rd*ẍ + (C_rd + c_rd)*ẋ + (K_rd + k_rd)*x = fRD
    // DOF順: [vy(n*4), θz(n*4+1), vz(n*4+2), θy(n*4+3)]
    // vy-vz 平面にのみ作用 (並進DOF: n*4, n*4+2)
    if (disk.hasRdForce) {
      // 付加剛性 K (対角) — ベルヌーイ効果、通常負
      Kb[n*4  ][n*4  ] += disk.rd_K || 0;
      Kb[n*4+2][n*4+2] += disk.rd_K || 0;
      // 連成剛性 k (交差剛性) — 不安定化の主原因, K_xy = k, K_yx = -k
      Kb[n*4  ][n*4+2] += disk.rd_k || 0;
      Kb[n*4+2][n*4  ] -= disk.rd_k || 0;
      // 付加減衰 C (対角) — 安定化寄与
      Cb[n*4  ][n*4  ] += disk.rd_C || 0;
      Cb[n*4+2][n*4+2] += disk.rd_C || 0;
      // 連成減衰 c (交差減衰) — 安定/不安定どちらにも影響
      Cb[n*4  ][n*4+2] += disk.rd_c || 0;
      Cb[n*4+2][n*4  ] -= disk.rd_c || 0;
      // 付加質量 M_rd (対角)
      M[n*4  ][n*4  ] += disk.rd_M || 0;
      M[n*4+2][n*4+2] += disk.rd_M || 0;
      // 連成付加質量 m (交差)
      M[n*4  ][n*4+2] += disk.rd_m || 0;
      M[n*4+2][n*4  ] -= disk.rd_m || 0;
    }

    // ── Thomas/Alford力 ──
    // K_xy = β * T_total / (D * L)  [N/m]
    // T: 軸トルク[N·m], D: タービン径[m], L: 翼高さ[m], β: Thomas係数[-]
    if (disk.hasThomas) {
      const T = disk.thomas_torque || 0;
      const D = disk.thomas_diameter || 0.1;
      const H = disk.thomas_height || 0.02;
      const beta = disk.thomas_beta || 0.5;
      const Kxy_thomas = (D > 0 && H > 0) ? beta * T / (D * H) : 0;
      Kb[n*4  ][n*4+2] += Kxy_thomas;
      Kb[n*4+2][n*4  ] -= Kxy_thomas;
    }
  });
  bearings.forEach(b => {
    const n = findNode(b.position);
    Kb[n*4][n*4] += b.kxx; Kb[n*4+2][n*4+2] += b.kyy;
    Kb[n*4][n*4+2] += b.kxy; Kb[n*4+2][n*4] += b.kyx;
    Cb[n*4][n*4] += b.cxx; Cb[n*4+2][n*4+2] += b.cyy;
  });

  return { M, K, G, Kb, Cb, nDOF, nodePositions };
}

// ═══════════════════════════════════════════════════════
//  線形代数ユーティリティ
//  Algorithm: LU factorization + Simultaneous Inverse Iteration
//  - Fully deterministic (no random vectors)
//  - Full K matrix used → bearing constraints correctly reflected
//  - M-orthonormal Gram-Schmidt keeps modes independent
// ═══════════════════════════════════════════════════════

// LU decomposition with partial pivoting; returns {L_flat, piv}
export function luFactor(A) {
  const n = A.length;
  const a = A.map(r => r.slice()); // working copy
  const piv = Array.from({length:n}, (_,i) => i);
  for (let k = 0; k < n; k++) {
    // find pivot in column k
    let maxv = Math.abs(a[k][k]), maxr = k;
    for (let i = k+1; i < n; i++) {
      if (Math.abs(a[i][k]) > maxv) { maxv = Math.abs(a[i][k]); maxr = i; }
    }
    if (maxr !== k) {
      [a[k], a[maxr]] = [a[maxr], a[k]];
      [piv[k], piv[maxr]] = [piv[maxr], piv[k]];
    }
    if (Math.abs(a[k][k]) < 1e-15) continue;
    for (let i = k+1; i < n; i++) {
      a[i][k] /= a[k][k];
      for (let j = k+1; j < n; j++) a[i][j] -= a[i][k] * a[k][j];
    }
  }
  return { a, piv };
}

// Solve LU * x = b using factored result
export function luSolveFactored({ a, piv }, b) {
  const n = a.length;
  const x = b.slice();
  // Apply permutation
  const y = Array(n);
  for (let i = 0; i < n; i++) y[i] = x[piv[i]];
  // Forward substitution (L is unit lower triangular, stored in a[i][j] for j<i)
  for (let i = 1; i < n; i++)
    for (let j = 0; j < i; j++) y[i] -= a[i][j] * y[j];
  // Back substitution (U is upper triangular)
  for (let i = n-1; i >= 0; i--) {
    for (let j = i+1; j < n; j++) y[i] -= a[i][j] * y[j];
    y[i] = Math.abs(a[i][i]) > 1e-15 ? y[i] / a[i][i] : 0;
  }
  return y;
}
