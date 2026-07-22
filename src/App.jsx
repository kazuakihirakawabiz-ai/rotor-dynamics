import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// FEM MATH ENGINE  (lightweight closed-form + fast numeric)
// ─────────────────────────────────────────────

// ── Helpers ──
function zeros(n, m) { return Array.from({length:n}, () => new Array(m).fill(0)); }
function matAdd(A, B) { return A.map((r,i) => r.map((v,j) => v + B[i][j])); }
function matScale(A, s) { return A.map(r => r.map(v => v * s)); }

// ── Euler-Bernoulli beam element  (4-DOF/node: vy θz vz θy) ──
function beamElementMatrices(L, E, I, rho, A_area) {
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
function assembleSystem(shaftElements, disks, bearings) {
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

    // ── Thomas/Alford力 (タービン用) ──
    // K_xy = β * T_total / (D * L)  [N/m]
    // T: 軸トルク[N·m], D: タービン径[m], L: 翼高さ[m], β: Thomas係数[-]
    if (disk.hasThomas && disk.type === 'turbine') {
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
//  DETERMINISTIC EIGEN-SOLVER
//  Algorithm: LU factorization + Simultaneous Inverse Iteration
//  - Fully deterministic (no random vectors)
//  - Full K matrix used → bearing constraints correctly reflected
//  - M-orthonormal Gram-Schmidt keeps modes independent
// ═══════════════════════════════════════════════════════

// LU decomposition with partial pivoting; returns {L_flat, piv}
function luFactor(A) {
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
function luSolveFactored({ a, piv }, b) {
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

// Rayleigh quotient ω² = ϕᵀKϕ / ϕᵀMϕ
function rayleighQuotient(K, M, phi) {
  const n = phi.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    let Kp = 0, Mp = 0;
    for (let j = 0; j < n; j++) { Kp += K[i][j]*phi[j]; Mp += M[i][j]*phi[j]; }
    num += phi[i]*Kp; den += phi[i]*Mp;
  }
  return den > 1e-20 ? num/den : 0;
}

// M-normalize: scale so ϕᵀMϕ = 1, then make largest-magnitude component positive
function mNormalize(M, phi) {
  const n = phi.length;
  let den = 0;
  for (let i = 0; i < n; i++) {
    let Mp = 0;
    for (let j = 0; j < n; j++) Mp += M[i][j]*phi[j];
    den += phi[i]*Mp;
  }
  const scale = Math.sqrt(Math.abs(den)) || 1;
  const v = phi.map(p => p/scale);
  // sign convention: largest |component| is positive
  let maxAbs = 0, sign = 1;
  for (let i = 0; i < n; i++) if (Math.abs(v[i]) > maxAbs) { maxAbs = Math.abs(v[i]); sign = v[i] < 0 ? -1 : 1; }
  return v.map(p => p*sign);
}

// Modified Gram-Schmidt M-orthogonalization against set of M-normal vectors
function mOrthogonalize(M, phi, basis) {
  const n = phi.length;
  const v = phi.slice();
  for (const b of basis) {
    // dot = bᵀ M v
    let dot = 0;
    for (let i = 0; i < n; i++) {
      let Mp = 0;
      for (let j = 0; j < n; j++) Mp += M[i][j]*v[j];
      dot += b[i]*Mp;
    }
    for (let i = 0; i < n; i++) v[i] -= dot*b[i];
  }
  return v;
}

// ── solveEigenvalue: Simultaneous Inverse Iteration (deterministic) ──
//
// Uses p deterministic start vectors (unit impulses at well-chosen DOFs),
// then repeatedly applies  v ← (K - σM)⁻¹ M v  with M-orthonormalization.
// After convergence, Rayleigh quotients give accurate ω² for each mode.
// The full K (shaft + bearing stiffness) is used, so bearing DOFs are
// properly stiffened and the mode shapes are physically correct.
function solveEigenvalue(M, K, nModes) {
  const n = M.length;

  // ── Step 1: choose shift σ just below the lowest expected ω²
  // Use smallest non-trivial K[i][i]/M[i][i] as estimate
  let sigmaLow = Infinity;
  for (let i = 0; i < n; i++) {
    const mi = M[i][i], ki = K[i][i];
    if (mi > 1e-12 && ki > 1.0) sigmaLow = Math.min(sigmaLow, ki/mi);
  }
  // Shift slightly below lowest estimate so (K - σM) is non-singular
  const sigma = sigmaLow === Infinity ? 0 : sigmaLow * 0.01;

  // ── Step 2: factor (K - σM) once — reused for every iteration
  const Kshift = K.map((row,i) => row.map((v,j) => i===j ? v - sigma*M[i][j] : v - sigma*M[i][j]));
  const LU = luFactor(Kshift);

  // ── Step 3: build p = nModes+2 deterministic start vectors
  // Use unit impulse at the p translational DOFs with largest M[i][i]
  // (i.e., the heaviest nodes) — these are always good starting guesses
  // for bending modes.
  const p = nModes + 2;
  // Score each translational DOF (every 4th starting from 0: vy DOFs)
  const dofScores = [];
  for (let i = 0; i < n; i += 4) dofScores.push({ dof: i, mass: M[i][i] });
  // Also add rotation DOFs
  for (let i = 1; i < n; i += 4) dofScores.push({ dof: i, mass: M[i][i] * 100 });
  dofScores.sort((a,b) => b.mass - a.mass);

  // Build start matrix V (n × p), columns = unit vectors at chosen DOFs
  let V = Array.from({length:p}, (_, col) => {
    const v = Array(n).fill(0);
    const dof = dofScores[col % dofScores.length]?.dof ?? col;
    v[dof] = 1.0;
    return v;
  });

  // ── Step 4: simultaneous inverse iteration with M-orthonormalization
  const ITER = 12; // sufficient for typical FEM sizes ≤ 80 DOF
  for (let it = 0; it < ITER; it++) {
    // Apply (K-σM)⁻¹ M to each column
    const W = V.map(v => {
      const Mv = Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Mv[i] += M[i][j]*v[j];
      return luSolveFactored(LU, Mv);
    });
    // M-orthonormalize W (modified Gram-Schmidt)
    const Q = [];
    for (let col = 0; col < p; col++) {
      let w = W[col].slice();
      w = mOrthogonalize(M, w, Q);
      const norm2 = w.reduce((s,x) => {
        let Mp = 0;
        for (let j = 0; j < n; j++) Mp += M[col < n ? col : 0][j] * w[j]; // approx norm
        return s + w[col < n ? col : 0] * w[col < n ? col : 0];
      }, 0);
      // Simple Euclidean normalization then M-normalize
      const enorm = Math.sqrt(w.reduce((s,x)=>s+x*x,0)) || 1;
      w = w.map(x=>x/enorm);
      w = mNormalize(M, w);
      Q.push(w);
    }
    V = Q;
  }

  // ── Step 5: extract eigenvalues via Rayleigh quotients and deduplicate
  const candidates = V.map(v => {
    const omega2 = rayleighQuotient(K, M, v);
    return { omega2, freq: omega2 > 0 ? Math.sqrt(omega2)/(2*Math.PI) : 0, mode: mNormalize(M, v) };
  }).filter(c => c.freq > 0.5 && c.freq < 10000);

  candidates.sort((a,b) => a.freq - b.freq);

  // Deduplicate: keep unique frequencies (within 2%)
  const unique = [];
  for (const c of candidates) {
    if (unique.some(u => Math.abs(u.freq - c.freq)/c.freq < 0.02)) continue;
    unique.push(c);
    if (unique.length >= nModes) break;
  }

  return unique.map(c => ({ omega: Math.sqrt(c.omega2), freq: c.freq, mode: c.mode }));
}

// ── Complex eigenvalue analysis (damped + gyroscopic) ──
// Re-uses the undamped eigenvectors (which already encode bearing constraints)
// then projects each mode onto the damped quadratic eigenvalue problem:
//   λ² (ϕᵀMϕ) + λ (ϕᵀ(C+ΩG)ϕ) + (ϕᵀKϕ) = 0
// This gives damped λ = σ ± jω per mode, with correct mode shapes.
// ── Complex eigenvalue analysis with gyroscopic effect ──
//
// The undamped eigenvectors from solveEigenvalue live in either the y-plane
// or z-plane (real modes). Gyroscopic splitting cannot be extracted via
// ϕᵀGϕ (=0 always for skew-symmetric G).
//
// Correct approach: for each undamped mode with natural frequency ωₙ,
// compute the modal polar inertia Jp_modal = Σ_nodes Jp_node * |ϕ[θ_node]|²
// Then the gyroscopic split for small damping is:
//   ωf = ωₙ + ½ · Ω · Jp_modal / mm   (forward whirl, freq increases with Ω)
//   ωb = ωₙ - ½ · Ω · Jp_modal / mm   (backward whirl, freq decreases with Ω)
//
// This is the standard first-order perturbation result used in textbooks
// (e.g. Rao "Mechanical Vibrations", Childs "Turbomachinery Rotordynamics").
function solveComplexEigenvalue(M, K, C, G, Omega, nModes, undampedModes) {
  const n = M.length;
  const modes = undampedModes || solveEigenvalue(M, K, nModes);
  if (modes.length === 0) return [];

  const results = [];

  modes.forEach((mode, undampedIdx) => {
    const phi = mode.mode;

    // Modal mass, stiffness, damping
    let mm = 0, km = 0, cm = 0;
    for (let i = 0; i < n; i++) {
      let Mp = 0, Kp = 0, Cp = 0;
      for (let j = 0; j < n; j++) {
        Mp += M[i][j] * phi[j];
        Kp += K[i][j] * phi[j];
        Cp += C[i][j] * phi[j];
      }
      mm += phi[i] * Mp;
      km += phi[i] * Kp;
      cm += phi[i] * Cp;
    }
    if (mm < 1e-20 || km < 0) return;

    const omegaN = Math.sqrt(km / mm);  // undamped natural frequency [rad/s]
    const zeta   = cm / (2 * mm * omegaN);  // modal damping ratio
    const sigma  = -zeta * omegaN;          // decay rate

    // ── Modal polar inertia (gyroscopic coupling strength) ──
    // Extract Jp at each node from G matrix: G[θz_node][θy_node] = +Jp
    // DOF order per node: [vy=n*4, θz=n*4+1, vz=n*4+2, θy=n*4+3]
    // Jp_modal = Σ_nodes  Jp_node * (phi[θz]² + phi[θy]²) / 2
    // (average of both rotation DOFs since mode lives in one plane)
    let Jp_modal = 0;
    const nNodes = Math.floor(n / 4);
    for (let nd = 0; nd < nNodes; nd++) {
      const dof_tz = nd * 4 + 1;
      const dof_ty = nd * 4 + 3;
      // Read Jp from G: G[dof_tz][dof_ty] = +Jp
      const Jp_node = G[dof_tz][dof_ty] || 0;  // stored as +Jp
      Jp_modal += Jp_node * (phi[dof_tz] * phi[dof_tz] + phi[dof_ty] * phi[dof_ty]);
    }

    // First-order gyroscopic frequency split:
    // Δω = ½ · Ω · Jp_modal / mm
    const deltaOmega = 0.5 * Omega * Jp_modal / mm;

    [[true, +deltaOmega], [false, -deltaOmega]].forEach(([isForward, dw]) => {
      const omega_d = omegaN + dw;
      if (omega_d < 1) return;
      const freq = omega_d / (2 * Math.PI);
      if (freq < 0.5 || freq > 10000) return;

      results.push({
        freq,
        omega: omega_d,
        sigma,
        zeta: Math.abs(zeta),
        mode: phi,
        isForward,
        undampedModeIdx: undampedIdx, // 元の固有値解析(solveEigenvalue)でのモード番号(0始まり)
      });
    });
  });

  // 周波数順ではなく「元のモード番号→Forward→Backward」の順に並べる。
  // こうすることで固有値解析のMode Nと複素固有値解析のMode N(F/B)が対応する。
  return results
    .sort((a, b) => (a.undampedModeIdx - b.undampedModeIdx) || (b.isForward - a.isForward))
    .slice(0, nModes * 2);
}

// ── Frequency response — Modal Superposition Method ──
//
// Physical equation: [−Ω²M + jΩ(C+ΩG) + K+Kb] Q = F_unbalance
//
// Modal approach:
//   1. Get undamped modes ϕᵣ from solveEigenvalue (already computed externally,
//      passed in as `modes`).  If not available, fall back to direct 1-DOF.
//   2. For each mode r, compute modal quantities:
//        m_r = ϕᵣᵀ M ϕᵣ  (= 1 if M-normalized)
//        k_r = ϕᵣᵀ K ϕᵣ  → ωₙᵣ² = k_r / m_r
//        c_r = ϕᵣᵀ (C+Cb+ΩG) ϕᵣ  → ζᵣ = c_r / (2 mᵣ ωₙᵣ)
//        f_r = ϕᵣᵀ F  (modal force from unbalance)
//   3. Modal response (complex):
//        H_r(Ω) = f_r / (k_r − Ω² m_r + jΩ c_r)
//   4. Physical response at each DOF:
//        Q = Σ_r ϕᵣ H_r(Ω)
//   5. Amplitude at disk node = √(Re²+Im²), phase = atan2(Im,Re)
//
// This correctly places resonance peaks at each natural frequency, with
// amplitude proportional to how much unbalance force projects onto each mode.
function solveFrequencyResponse(M, Ktotal, Ctotal, G, Kb, Cb, unbalances, omegaRange, nodePositions, modes) {
  // Ktotal = K+Kb and Ctotal = C+Cb are pre-built by the caller
  const n = M.length;

  const findNode = x => {
    let best=0, bd=Infinity;
    nodePositions.forEach((xn,i) => { const d=Math.abs(xn-x); if(d<bd){bd=d;best=i;} });
    return best;
  };

  // If no modes provided, can't do modal superposition — return empty
  if (!modes || modes.length === 0) return [];

  // ── Precompute modal quantities (frequency-independent) ──
  const modalData = modes.map(mode => {
    const phi = mode.mode;
    // Modal mass, stiffness (frequency-independent part)
    let mr = 0, kr = 0;
    for (let i = 0; i < n; i++) {
      let Mp = 0, Kp = 0;
      for (let j = 0; j < n; j++) {
        Mp += M[i][j] * phi[j];
        Kp += Ktotal[i][j] * phi[j];
      }
      mr += phi[i] * Mp;
      kr += phi[i] * Kp;
    }
    if (mr < 1e-20) return null;
    const omegaN2 = kr / mr;  // natural frequency squared

    // Modal unbalance force — complex to account for phase angle φ_u
    // Physical force at unbalance u:
    //   F_y = me·e·Ω²·cos(φ_u)   (real part, y-direction)
    //   F_z = me·e·Ω²·sin(φ_u)   (imaginary part, z-direction)
    // Modal projection: f_r = ϕᵣᵀ F  (Ω² factored out)
    // frCoeffRe = Σ_u  me_u·e_u·cos(φ_u)·phi[dof_y_u]
    // frCoeffIm = Σ_u  me_u·e_u·sin(φ_u)·phi[dof_z_u]
    let frCoeffRe = 0, frCoeffIm = 0;
    unbalances.forEach(u => {
      const node = findNode(u.position);
      const dofY = node * 4;      // y-displacement DOF
      const dofZ = node * 4 + 2;  // z-displacement DOF
      const phiRad = (u.phase || 0) * Math.PI / 180;
      const me = u.mass * u.eccentricity;
      frCoeffRe += me * Math.cos(phiRad) * phi[dofY];
      frCoeffIm += me * Math.sin(phiRad) * phi[dofZ];
    });

    return { phi, mr, kr, omegaN2, frCoeffRe, frCoeffIm };
  }).filter(Boolean);

  // ── Response at each frequency ──
  return omegaRange.map(Omega => {
    // Frequency-dependent modal damping: c_r(Ω) = ϕᵣᵀ (C + Cb + Ω·G) ϕᵣ
    const Ceff = matAdd(Ctotal, matScale(G, Omega));

    // Accumulate complex response at all DOFs: Q[i] = {re, im}
    const Qre = Array(n).fill(0);
    const Qim = Array(n).fill(0);

    modalData.forEach(({ phi, mr, kr, omegaN2, frCoeffRe, frCoeffIm }) => {
      // Modal damping at this Ω
      let cr = 0;
      for (let i = 0; i < n; i++) {
        let Cp = 0;
        for (let j = 0; j < n; j++) Cp += Ceff[i][j] * phi[j];
        cr += phi[i] * Cp;
      }

      // Modal force (complex): F_r = (frCoeffRe + j·frCoeffIm) · Ω²
      const frRe = frCoeffRe * Omega * Omega;
      const frIm = frCoeffIm * Omega * Omega;

      // Complex denominator: D = (kr − Ω²·mr) + j·Ω·cr
      const ReD = kr - Omega * Omega * mr;
      const ImD = Omega * cr;
      const denom2 = ReD * ReD + ImD * ImD;
      if (denom2 < 1e-30) return;

      // H_r = F_r / D = (frRe + j·frIm)(ReD − j·ImD) / denom2
      const Hre = (frRe * ReD + frIm * ImD) / denom2;
      const Him = (frIm * ReD - frRe * ImD) / denom2;

      // Add modal contribution: Q += phi · H_r
      for (let i = 0; i < n; i++) {
        Qre[i] += phi[i] * Hre;
        Qim[i] += phi[i] * Him;
      }
    });

    // Find the DOF with maximum amplitude (typically the disk node y-DOF)
    // Report amplitude at the unbalance location(s) y-DOF
    let maxAmp = 0;
    let totalPhaseRe = 0, totalPhaseIm = 0;
    unbalances.forEach(u => {
      const node = findNode(u.position);
      const dof = node * 4;
      const amp = Math.sqrt(Qre[dof]*Qre[dof] + Qim[dof]*Qim[dof]);
      if (amp > maxAmp) {
        maxAmp = amp;
        totalPhaseRe = Qre[dof];
        totalPhaseIm = Qim[dof];
      }
    });

    const phase = Math.atan2(totalPhaseIm, totalPhaseRe) * 180 / Math.PI;

    return {
      omega: Omega,
      freq: Omega / (2 * Math.PI),
      rpm: Omega * 60 / (2 * Math.PI),
      amplitude: maxAmp * 1000,  // m → mm
      phase,
    };
  });
}

// ─────────────────────────────────────────────
// DEFAULT DATA
// ─────────────────────────────────────────────
// Rocket turbopump layout (Inconel shaft, total length = 0.60 m):
//   Node0 --[El1:100mm]-- Node1 --[El2:120mm]-- Node2 --[El3:140mm]-- Node3 --[El4:120mm]-- Node4 --[El5:120mm]-- Node5
//
//   x=0.00  Inducer
//   x=0.10  Bearing A  (ball bearing, pump side)
//   x=0.22  Impeller
//   x=0.36  Balance Disk
//   x=0.50  Bearing B  (roller bearing, turbine side)
//   x=0.60  Turbine    (overhung)
const DEFAULT_SHAFT = [
  { id: 1, length: 0.10, outerDiam: 0.04, innerDiam: 0.00, youngMod: 200, density: 8190 }, // Inducer → Bearing A
  { id: 2, length: 0.12, outerDiam: 0.05, innerDiam: 0.01, youngMod: 200, density: 8190 }, // Bearing A → Impeller
  { id: 3, length: 0.14, outerDiam: 0.05, innerDiam: 0.01, youngMod: 200, density: 8190 }, // Impeller → Balance Disk
  { id: 4, length: 0.14, outerDiam: 0.05, innerDiam: 0.01, youngMod: 200, density: 8190 }, // Balance Disk → Bearing B
  { id: 5, length: 0.10, outerDiam: 0.04, innerDiam: 0.00, youngMod: 200, density: 8190 }, // Bearing B → Turbine (overhung)
];
// RD係数デフォルト値の参考（内海2016セミナー資料より）
// Closed impeller: K≈-2.6, k≈1.1, C≈3.1, c≈8.7, M≈6.7, m≈-0.6 (無次元→実寸変換要)
// 各コンポーネントのrd_*** フィールドは FEM マトリクスに直接加算される実寸値 [SI単位]
const DEFAULT_DISKS = [
  { id: 1, type: 'inducer',      position: 0.00, count: 1,
    mass: 1.2, polarInertia: 0.0030, diametralInertia: 0.0018,
    hasUnbalance: true,  unbalanceMass: 5e-4, eccentricity: 5e-4, unbalancePhase: 0,
    // RD流体力係数 (Rotordynamic Force Coefficients)
    hasRdForce: false,
    rd_K: -2e5, rd_k: 5e4, rd_C: 200, rd_c: 500, rd_M: 0, rd_m: 0,
    // Thomas/Alford力 (タービン用 - turbineのみ有効)
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.1, thomas_height: 0.02,
  },
  { id: 2, type: 'impeller',     position: 0.22, count: 1,
    mass: 5.5, polarInertia: 0.0180, diametralInertia: 0.0100,
    hasUnbalance: true,  unbalanceMass: 1e-3, eccentricity: 1e-3, unbalancePhase: 0,
    hasRdForce: false,
    rd_K: -3e5, rd_k: 1e5, rd_C: 300, rd_c: 800, rd_M: 0, rd_m: 0,
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.15, thomas_height: 0.03,
  },
  { id: 3, type: 'balance_disk', position: 0.36, count: 1,
    mass: 1.8, polarInertia: 0.0055, diametralInertia: 0.0030,
    hasUnbalance: false, unbalanceMass: 1e-4, eccentricity: 5e-4, unbalancePhase: 0,
    hasRdForce: false,
    rd_K: -1e5, rd_k: 2e4, rd_C: 100, rd_c: 200, rd_M: 0, rd_m: 0,
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.1, thomas_height: 0.02,
  },
  { id: 4, type: 'turbine',      position: 0.60, count: 1,
    mass: 4.0, polarInertia: 0.0140, diametralInertia: 0.0080,
    hasUnbalance: true,  unbalanceMass: 8e-4, eccentricity: 8e-4, unbalancePhase: 180,
    hasRdForce: false,
    rd_K: -1e5, rd_k: 3e4, rd_C: 150, rd_c: 400, rd_M: 0, rd_m: 0,
    // Thomas/Alford力: K_xy = β × T / (D × L), タービン軸動力から自動計算
    hasThomas: false, thomas_beta: 0.56, thomas_torque: 5000, thomas_diameter: 0.12, thomas_height: 0.025,
  },
];
const DEFAULT_BEARINGS = [
  { id: 1, position: 0.10, kxx: 8e8, kyy: 8e8, kxy: 0, kyx: 0, cxx: 500, cyy: 500 }, // Bearing A (ball, pump side)
  { id: 2, position: 0.50, kxx: 5e8, kyy: 5e8, kxy: 0, kyx: 0, cxx: 300, cyy: 300 }, // Bearing B (roller, turbine side)
];
const DEFAULT_SETTINGS = { nModes: 5, minRpm: 0, maxRpm: 30000, alphaRayleigh: 0.1, betaRayleigh: 1e-5 };

// ─────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────

// ── 機能フラグ ──
// RD流体力・Thomas/Alford力の計算ロジックは残したまま、UI上の表示だけをオフにする。
// (精度にまだ自信が持てないため、公開後に自信がついたタイミングで true に戻す想定)
const SHOW_RD_FORCE_UI = false;

// ライトテーマ（白背景）— レポート・印刷に貼り付けやすい配色
const COLORS = {
  bg: "#FFFFFF",
  surface: "#FFFFFF",
  surface2: "#F4F6FA",
  border: "#D7DCE6",
  accent: "#0B6FB0",
  accent2: "#085A8C",
  danger: "#C0392B",
  warning: "#B8860B",
  success: "#1E7A3D",
  text: "#1F2937",
  textMuted: "#6B7280",
  textBright: "#0A0E1A",
  purple: "#6B3FA0",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@300;400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: 'Inter', sans-serif; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: ${COLORS.surface}; }
  ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 2px; }
  input, select { background: ${COLORS.bg}; border: 1px solid ${COLORS.border}; color: ${COLORS.text};
    font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 4px 8px; border-radius: 4px; width: 100%; outline: none; }
  input:focus, select:focus { border-color: ${COLORS.accent}; }
  button { font-family: 'Inter', sans-serif; cursor: pointer; border: none; border-radius: 4px; }
  .util-btn {
    font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 500;
    padding: 7px 10px; border-radius: 6px; display: flex; align-items: center;
    justify-content: center; gap: 6px; transition: background 0.12s ease, border-color 0.12s ease;
  }
  .util-btn:not(:disabled):hover { background: ${COLORS.accent}14; border-color: ${COLORS.accent}AA !important; }
  .util-btn:disabled { cursor: not-allowed; opacity: 0.5; }
  .util-btn-icon { font-size: 12px; line-height: 1; }
  table { border-collapse: collapse; width: 100%; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  th { background: ${COLORS.surface2}; color: ${COLORS.accent}; font-weight: 500; padding: 6px 10px; text-align: left; border-bottom: 1px solid ${COLORS.border}; }
  td { padding: 5px 10px; border-bottom: 1px solid ${COLORS.border}22; color: ${COLORS.text}; }
  tr:hover td { background: ${COLORS.surface2}22; }
`;

// ─── Canvas Chart ───
function LineChart({ data, xKey, yKey, title, xLabel, yLabel, color = COLORS.accent, lines, vLines, yMin, yMax, width = 500, height = 260 }) {
  const canvasRef = useRef();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, width, height);

    const pad = { top: 30, right: 20, bottom: 45, left: 65 };
    const pw = width - pad.left - pad.right;
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
      ctx.fillText(y.toFixed(1), pad.left - 6, ty(y) + 4);
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
  }, [data, xKey, yKey, title, xLabel, yLabel, color, lines, width, height]);
  return <canvas ref={canvasRef} style={{ borderRadius: 6, display: 'block' }} />;
}


// ─── Whirl Orbit Visualizer ───
// 各モードのふれまわり軌跡（楕円）をアニメーション表示
// Forward whirl: 反時計回り, Backward whirl: 時計回り
function WhirlOrbitVisualizer({ complexResults, selectedMode, nodePositions, disks, bearings, settings }) {
  const canvasAnimRef = useRef();   // アニメーション canvas (シャフト側面図)
  const canvasOrbitRef = useRef();  // 静止軌跡 canvas (断面ふれまわり軌道図)
  const animRef = useRef();
  const [animating, setAnimating] = useState(false);
  const [animPhase, setAnimPhase] = useState(0);
  const [animSpeed, setAnimSpeed] = useState(0.3);   // アニメーション速度倍率 (0.02〜1.0)
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
      if (last !== null) setAnimPhase(p => (p + (t - last) * Math.abs(omega_whirl) * 0.001 * animSpeed) % (2 * Math.PI));
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
    const W = 500, H = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W*dpr; canvas.height = H*dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
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
      const W=500,H=200;
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

    const W=500, H=234;
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
          const oy=-(Ay*Math.sin(ph)+dir*Az*Math.cos(ph))*sc;
          i===0?ctx.moveTo(cx+ox,cy+oy):ctx.lineTo(cx+ox,cy+oy);
        }
        ctx.closePath(); ctx.stroke();
        ctx.fillStyle=modeColor+'14'; ctx.fill();

        // 回転方向の矢印
        const ph0 = Math.PI*0.25;
        const ph1 = ph0 + (dir>0 ? 0.18 : -0.18);
        const p0x=(Ay*Math.cos(ph0)-dir*Az*Math.sin(ph0))*sc, p0y=-(Ay*Math.sin(ph0)+dir*Az*Math.cos(ph0))*sc;
        const p1x=(Ay*Math.cos(ph1)-dir*Az*Math.sin(ph1))*sc, p1y=-(Ay*Math.sin(ph1)+dir*Az*Math.cos(ph1))*sc;
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
        const oy_now=(Ay*Math.sin(ph_now)+dir*Az*Math.cos(ph_now))*sc;
        ctx.fillStyle=modeColor;
        ctx.beginPath(); ctx.arc(cx+ox_now,cy-oy_now,4.5,0,2*Math.PI); ctx.fill();
        ctx.strokeStyle=PC.bg; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.arc(cx+ox_now,cy-oy_now,4.5,0,2*Math.PI); ctx.stroke();

      } else {
        // ② シャフト表面マーク点の軌跡（自転Ω＋公転ωの合成）→ Backwardで花びら
        // 自転Ωは常に正方向（反時計回り）が基準。マーク点はシャフト表面の半径 eps（視覚化用）。
        //   重心位置: x_orb(t)=Ay·cos(dirω t)-dir·Az·sin... ※公転式は cog と同じ式を t に対して評価
        //   マーク点: x_mark(t) = x_orb(t) + eps·cos(Ω t),  y_mark(t) = y_orb(t) + eps·sin(Ω t)
        const eps = maxA*0.22;
        ctx.strokeStyle=modeColor+'CC'; ctx.lineWidth=1.1;
        ctx.beginPath();
        for(let i=0;i<=nPts;i++){
          const t=(i/nPts)*T_total;
          const ph_orb=omega_whirl*t;
          const ph_spin=Omega_spin*t;
          const x_orb=(Ay*Math.cos(ph_orb)-dir*Az*Math.sin(ph_orb))*sc;
          const y_orb=(Ay*Math.sin(ph_orb)+dir*Az*Math.cos(ph_orb))*sc;
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
          const oy=-(Ay*Math.sin(ph)+dir*Az*Math.cos(ph))*sc;
          i===0?ctx.moveTo(cx+ox,cy+oy):ctx.lineTo(cx+ox,cy+oy);
        }
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);

        // 現在位置（重心 + マーク点）
        const ph_now_orb=animPhase;
        const ph_now_spin=Omega_spin*(animPhase/Math.max(omega_whirl,1e-6));
        const ox_now=(Ay*Math.cos(ph_now_orb)-dir*Az*Math.sin(ph_now_orb))*sc;
        const oy_now=(Ay*Math.sin(ph_now_orb)+dir*Az*Math.cos(ph_now_orb))*sc;
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
          <span style={{ fontSize:10, color:COLORS.textMuted }}>アニメーション速度</span>
          <span style={{ fontSize:10, color:COLORS.accent, fontFamily:'JetBrains Mono' }}>{animSpeed.toFixed(2)}×</span>
        </div>
        <input
          type="range" min="0.02" max="1.0" step="0.02"
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
            表示する断面（最大5つ・未選択時は変位上位3を自動表示）
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
            const labelMap = { inducer:'インデューサ', impeller:'インペラ', balance_disk:'バランスD', turbine:'タービン' };
            let tag = nearBrg ? '軸受' : (nearDisk ? (labelMap[nearDisk.type] || nearDisk.type) : null);
            const checked = selectedNodes ? selectedNodes.includes(n) : false;
            return (
              <button
                key={n}
                onClick={() => {
                  setSelectedNodes(prev => {
                    const cur = prev || [];
                    if (cur.includes(n)) return cur.filter(x => x !== n);
                    if (cur.length >= 5) return cur; // 最大5つ
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
        <canvas ref={canvasOrbitRef} style={{ borderRadius:8, display:'block', border:`1px solid ${COLORS.border}` }} />
      </div>
    </div>
  );
}

// ─── Campbell Diagram ───
function CampbellDiagram({ campbellData, maxRpm, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width = 520, height = 300, onCriticalSpeeds }) {
  const canvasRef = useRef();
  useEffect(() => {
    if (!campbellData || campbellData.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.surface; ctx.fillRect(0, 0, width, height);

    const pad = { top: 30, right: 30, bottom: 45, left: 65 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;

    const dataMaxFreq = Math.max(...campbellData.flatMap(pt => pt.modes.map(m => m.freq))) * 1.15 || 200;
    const rpmMin = minRpmLim ?? 0;
    const rpmMax = maxRpmLim ?? maxRpm;
    const freqMin = minFreqLim ?? 0;
    const freqMax = maxFreqLim ?? dataMaxFreq;
    const tx = rpm => pad.left + (rpm - rpmMin) / (rpmMax - rpmMin || 1) * pw;
    const ty = f   => pad.top + ph - (f - freqMin) / (freqMax - freqMin || 1) * ph;

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
    const criticalSpeeds = []; // {rpm, freq, order, modeIdx}
    [1, 2, 3].forEach(n => {
      for (let m = 0; m < modeCount; m++) {
        for (let i = 0; i < campbellData.length - 1; i++) {
          const pt0 = campbellData[i], pt1 = campbellData[i + 1];
          if (!pt0.modes[m] || !pt1.modes[m]) continue;
          const rpm0 = pt0.rpm, rpm1 = pt1.rpm;
          const f0 = pt0.modes[m].freq, f1 = pt1.modes[m].freq;
          // g(rpm) = modeFreq(rpm) - n*rpm/60 の符号変化を見る（線形補間内で交差判定）
          const g0 = f0 - n * rpm0 / 60;
          const g1 = f1 - n * rpm1 / 60;
          if (g0 === 0) {
            criticalSpeeds.push({ rpm: rpm0, freq: f0, order: n, modeIdx: m });
          } else if (g0 * g1 < 0) {
            // 線形補間で交点を求める
            const t = g0 / (g0 - g1);
            const rpmX = rpm0 + t * (rpm1 - rpm0);
            const freqX = f0 + t * (f1 - f0);
            criticalSpeeds.push({ rpm: rpmX, freq: freqX, order: n, modeIdx: m });
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
  }, [campbellData, maxRpm, minFreqLim, maxFreqLim, minRpmLim, maxRpmLim, width, height]);
  return <canvas ref={canvasRef} style={{ borderRadius: 6, display: 'block' }} />;
}

// ─── Mode Shape Visualizer ───
// Shows:  shaft centerline, deformed shape (y-disp), rotation arrows (θ),
//         bearing supports (triangle), disk markers, node displacement values.
function ModeShape({ mode, nodePositions, bearings = [], disks = [], width = 520, height = 190 }) {
  const canvasRef = useRef();
  useEffect(() => {
    if (!mode || !nodePositions || nodePositions.length < 2) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.surface; ctx.fillRect(0, 0, width, height);

    const pad = { top: 28, right: 24, bottom: 36, left: 24 };
    const pw = width - pad.left - pad.right;
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
    ctx.fillText('ベアリング', pad.left + 126, 12);

  }, [mode, nodePositions, bearings, disks, width, height]);
  return <canvas ref={canvasRef} style={{ borderRadius: 6, display: 'block' }} />;
}

// ─── Input Panel ───
function FieldRow({ label, value, onChange, unit, step = "any", min = 0 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 40px', gap: 4, alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: COLORS.textMuted }}>{label}</span>
      <input type="number" value={value} step={step} min={min}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={{ textAlign: 'right' }} />
      <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>{unit}</span>
    </div>
  );
}

function Section({ title, children, accent }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 3, height: 14, background: accent || COLORS.accent, borderRadius: 2 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, letterSpacing: '0.05em' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function AddRemoveList({ items, onAdd, onRemove, onUpdate, renderItem, defaultItem, onReorder, onDuplicate }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  const canReorder = typeof onReorder === 'function';

  const handleDrop = (targetIdx) => {
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setOverIdx(null); return; }
    const next = items.slice();
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);
    onReorder(next);
    setDragIdx(null);
    setOverIdx(null);
  };

  return (
    <div>
      {items.map((item, idx) => (
        <div
          key={item.id}
          draggable={canReorder}
          onDragStart={canReorder ? ((e) => {
            setDragIdx(idx);
            // ブラウザ(特にFirefox/Safari)は、ドラッグ開始時にdataTransferへ何かデータを
            // セットしないとドラッグ操作自体を継続してくれないことがあるため、明示的に設定する。
            e.dataTransfer.setData('text/plain', String(idx));
            e.dataTransfer.effectAllowed = 'move';
          }) : undefined}
          onDragOver={canReorder ? ((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverIdx(idx); }) : undefined}
          onDragLeave={canReorder ? (() => setOverIdx(o => o === idx ? null : o)) : undefined}
          onDrop={canReorder ? ((e) => { e.preventDefault(); handleDrop(idx); }) : undefined}
          onDragEnd={canReorder ? (() => { setDragIdx(null); setOverIdx(null); }) : undefined}
          style={{
            background: COLORS.surface2,
            border: `1px solid ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? COLORS.accent : COLORS.border}`,
            borderRadius: 6, padding: '8px 10px', marginBottom: 8,
            opacity: dragIdx === idx ? 0.4 : 1,
            transition: 'border-color 0.1s ease, opacity 0.1s ease',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {canReorder && (
                <span
                  title="ドラッグして順序を入れ替え"
                  style={{ cursor: 'grab', color: COLORS.textMuted, fontSize: 13, lineHeight: 1, userSelect: 'none' }}>
                  ⠿
                </span>
              )}
              <span style={{ fontSize: 11, color: COLORS.accent, fontFamily: 'JetBrains Mono' }}>#{idx + 1}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {typeof onDuplicate === 'function' && (
                <button
                  onClick={() => onDuplicate(item.id)}
                  title="この要素を複製"
                  style={{ background: 'transparent', color: COLORS.textMuted, fontSize: 12, padding: '2px 5px', borderRadius: 4 }}>
                  ⧉
                </button>
              )}
              <button onClick={() => onRemove(item.id)}
                title="削除"
                style={{ background: 'transparent', color: COLORS.textMuted, fontSize: 14, padding: '0 4px' }}>×</button>
            </div>
          </div>
          {renderItem(item, v => onUpdate(item.id, v))}
        </div>
      ))}
      <button onClick={onAdd} style={{
        width: '100%', padding: '5px', background: 'transparent',
        border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, fontSize: 11,
      }}>+ 追加</button>
    </div>
  );
}


// ─── Shaft Overview Visualizer ───
// ─── Rotor Model 3D Viewer (dependency-free, canvas-based) ───
// マウスドラッグで回転・ホイールでズームできる、簡易3Dロータモデルビューア。
// 外部ライブラリなしで、手動の回転行列・投影計算により実現している。
function RotorModel3DViewer({ shaftElems, disks, bearings, onClose }) {
  const canvasRef = useRef();
  const [yaw, setYaw] = useState(-0.6);     // 水平方向の回転角 [rad]
  const [pitch, setPitch] = useState(0.35); // 垂直方向の回転角 [rad]
  const [zoom, setZoom] = useState(1.0);
  const dragState = useRef(null);

  const totalLen = shaftElems.reduce((s, e) => s + e.length, 0) || 1;
  const nodePositions = [0];
  shaftElems.forEach(el => nodePositions.push(nodePositions[nodePositions.length - 1] + el.length));
  const maxOD = Math.max(...shaftElems.map(e => e.outerDiam), 0.01, ...disks.map(() => 0));

  const typeColors = {
    inducer: '#22C55E', impeller: '#A78BFA', balance_disk: COLORS.warning,
    turbine: COLORS.danger, other: COLORS.textMuted,
  };
  const typeLabels = {
    inducer: 'インデューサ', impeller: 'インペラ', balance_disk: 'バランスディスク',
    turbine: 'タービン', other: 'その他',
  };

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
      const color = typeColors[d.type] || typeColors.other;
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

  }, [shaftElems, disks, bearings, yaw, pitch, zoom]);

  // 使われている種類の凡例を集める
  const usedTypes = [...new Set(disks.map(d => d.type || 'other'))];

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
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onMouseLeave={onPointerUp}
            onWheel={onWheel}
          />
          {/* 凡例 */}
          <div style={{
            position: 'absolute', bottom: 14, left: 14,
            background: COLORS.surface + 'EE', border: `1px solid ${COLORS.border}`,
            borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.accent + '55', border: `1px solid ${COLORS.accent}` }} />
              <span style={{ fontSize: 10, color: COLORS.textMuted }}>シャフト</span>
            </div>
            {usedTypes.map(t => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: (typeColors[t] || typeColors.other) + '55', border: `1px solid ${typeColors[t] || typeColors.other}` }} />
                <span style={{ fontSize: 10, color: COLORS.textMuted }}>{typeLabels[t] || t}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: COLORS.warning + '55', border: `1px solid ${COLORS.warning}` }} />
              <span style={{ fontSize: 10, color: COLORS.textMuted }}>軸受</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShaftOverview({ shaftElems, disks, bearings }) {
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



  }, [shaftElems, disks, bearings, totalLen]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 5, flexWrap: 'wrap' }}>
        {[
          [COLORS.accent, 'シャフト'],
          ['#A78BFA', 'ディスク'],
          [COLORS.warning, 'ベアリング'],
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

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function RotorDynamicsApp() {
  const [tab, setTab] = useState('model');
  const [analysisTab, setAnalysisTab] = useState('eigen');
  const [shaftElems, setShaftElems] = useState(DEFAULT_SHAFT);
  const [disks, setDisks] = useState(DEFAULT_DISKS);
  const [bearings, setBearings] = useState(DEFAULT_BEARINGS);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState({ step: '', progress: 0, error: null, elapsed: 0 });
  const [selectedMode, setSelectedMode] = useState(0);
  const [selectedAnalyses, setSelectedAnalyses] = useState({ eigen: true, complex: false, campbell: false, freq: false });
  const [campbellView, setCampbellView] = useState({ minRpm: null, maxRpm: null, minFreq: null, maxFreq: null });
  const [criticalSpeeds, setCriticalSpeeds] = useState([]); // 1X/2X/3X とモード曲線の交点リスト
  const [show3DView, setShow3DView] = useState(false); // 3Dモデルビューの表示/非表示
  const runStartRef = useRef(null);

  const nextId = useRef(100);
  const getId = () => ++nextId.current;

  const listHelpers = (setter) => ({
    onAdd: (def) => setter(s => [...s, { ...def, id: getId() }]),
    onRemove: (id) => setter(s => s.filter(x => x.id !== id)),
    onUpdate: (id, vals) => setter(s => s.map(x => x.id === id ? { ...x, ...vals } : x)),
    // 指定したidの要素をそのまま複製し、直後に挿入する
    onDuplicate: (id) => setter(s => {
      const idx = s.findIndex(x => x.id === id);
      if (idx === -1) return s;
      const copy = { ...s[idx], id: getId() };
      const next = s.slice();
      next.splice(idx + 1, 0, copy);
      return next;
    }),
  });

  const runAnalysis = useCallback(() => {
    const sel = selectedAnalyses;
    if (!sel.eigen && !sel.complex && !sel.campbell && !sel.freq) return;

    // 実行開始と同時に前回の結果を即クリアする。
    // （計算中にエラーが起きた場合でも、古いモデルの結果が画面に残り続けないように）
    setResults({});
    setCriticalSpeeds([]);
    setRunning(true);
    setRunStatus({ step: 'FEMモデル構築中...', progress: 0, error: null, elapsed: 0 });
    runStartRef.current = performance.now();

    // Calculate progress steps based on selected analyses
    const steps = ['base', sel.eigen && 'eigen', (sel.complex || sel.campbell) && 'complex', sel.campbell && 'campbell', sel.freq && 'freq'].filter(Boolean);
    const totalSteps = steps.length;
    let stepIdx = 0;
    const progressOf = () => Math.round((stepIdx / totalSteps) * 95) + 5;

    const tick = (step, fn) => new Promise((resolve, reject) => {
      stepIdx++;
      setRunStatus(s => ({ ...s, step, progress: progressOf(), elapsed: Math.round(performance.now() - runStartRef.current) }));
      setTimeout(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            try { resolve(fn()); } catch(e) { reject(e); }
          }, 0);
        });
      }, 16);
    });

    (async () => {
      try {
        const sys = await tick('FEMマトリクス組み立て中...', () => assembleSystem(shaftElems, disks, bearings));
        const { M, K, G, Kb, Cb, nDOF, nodePositions } = sys;
        const C = M.map((row, i) => row.map((v, j) =>
          settings.alphaRayleigh * M[i][j] + settings.betaRayleigh * K[i][j]
        ));
        const Ktotal = matAdd(K, Kb);
        const Ctotal = matAdd(C, Cb);

        // 前回の結果は引き継がず、常にクリアした状態から今回の解析結果だけを積む。
        // （モデル設定を変えてから一部の解析だけ再実行した場合に、古いモデルの結果が
        //   別解析タブに残ってしまう不整合を防ぐため）
        const newResults = { nodePositions, nDOF };

        if (sel.eigen) {
          // nodePositions を results に保存 (WhirlOrbit等で使用)
          newResults.nodePositions = sys.nodePositions;

          newResults.eigenResults = await tick('① 固有値解析 実行中...', () =>
            solveEigenvalue(M, Ktotal, settings.nModes)
          );
        }

        if (sel.complex || sel.campbell) {
          // Pre-compute undamped modes once — reused for all Campbell steps
          const undampedForGyro = newResults.eigenResults && newResults.eigenResults.length > 0
            ? newResults.eigenResults
            : solveEigenvalue(M, Ktotal, settings.nModes);

          const Omega_rated = settings.maxRpm * Math.PI / 30;
          newResults.complexResults = await tick('② 複素固有値解析 実行中...', () =>
            solveComplexEigenvalue(M, Ktotal, Ctotal, G, Omega_rated, settings.nModes, undampedForGyro)
          );
        }

        if (sel.campbell) {
          const undampedForCampbell = newResults.eigenResults && newResults.eigenResults.length > 0
            ? newResults.eigenResults
            : solveEigenvalue(M, Ktotal, settings.nModes);

          newResults.campbellData = await tick('キャンベル線図 計算中...', () => {
            const rpmSteps = 30;
            const data = [];
            for (let i = 0; i <= rpmSteps; i++) {
              const rpm = settings.maxRpm * i / rpmSteps;
              const Omega = rpm * Math.PI / 30;
              // Pass undamped modes — only gyroscopic term changes with Omega
              const modes = solveComplexEigenvalue(M, Ktotal, Ctotal, G, Omega, settings.nModes, undampedForCampbell);
              data.push({ rpm, modes });
            }
            return data;
          });
        }

        if (sel.freq) {
          setRunStatus(s => ({ ...s, step: '③ 周波数応答解析 実行中...', progress: 90 }));
          await new Promise(r => setTimeout(r, 32)); // let UI repaint

          try {
            const nOmegaSteps = 300;
            const eigenFreqs = (newResults.eigenResults || []).map(r => r.freq * 60);
            const freqMaxRpm = eigenFreqs.length > 0
              ? Math.max(settings.maxRpm, eigenFreqs[eigenFreqs.length - 1] * 1.5)
              : settings.maxRpm;
            newResults.freqMaxRpm = freqMaxRpm;

            const omegaRange = Array.from({ length: nOmegaSteps }, (_, i) =>
              (settings.minRpm + (freqMaxRpm - settings.minRpm) * i / (nOmegaSteps - 1)) * Math.PI / 30
            );
            const unbalancesFromDisks = disks.filter(d => d.hasUnbalance).map(d => ({
              position: d.position,
              mass: d.unbalanceMass || 0,
              eccentricity: d.eccentricity || 0,
              phase: d.unbalancePhase || 0,
            }));
            const modesForResp = (newResults.eigenResults || []).length > 0
              ? newResults.eigenResults
              : solveEigenvalue(M, Ktotal, settings.nModes);

            if (unbalancesFromDisks.length === 0) {
              newResults.freqResponse = omegaRange.map(Omega => ({
                omega: Omega, freq: Omega/(2*Math.PI), rpm: Omega*60/(2*Math.PI), amplitude: 0, phase: 0,
              }));
            } else {
              newResults.freqResponse = solveFrequencyResponse(
                M, Ktotal, Ctotal, G, Kb, Cb,
                unbalancesFromDisks, omegaRange, nodePositions, modesForResp
              );
            }
          } catch(freqErr) {
            newResults._freqError = freqErr?.message || String(freqErr);
            newResults.freqResponse = [];
          }
        }

        const elapsed = Math.round(performance.now() - runStartRef.current);
        // Store diagnostics for in-app display
        newResults._diag = {
          hasFreqResponse: Array.isArray(newResults.freqResponse),
          freqResponseLen: newResults.freqResponse?.length ?? 'null',
          freqResponseType: typeof newResults.freqResponse,
          unbalanceCount: disks.filter(d => d.hasUnbalance).length,
          eigenCount: newResults.eigenResults?.length ?? 0,
          freqMaxRpm: newResults.freqMaxRpm,
        };
        setResults(newResults);
        setRunStatus({ step: '解析完了', progress: 100, error: null, elapsed });
        // Switch to first selected tab
        const firstTab = sel.eigen ? 'eigen' : sel.complex ? 'complex' : sel.campbell ? 'campbell' : 'freq';
        setAnalysisTab(firstTab);
      } catch (e) {
        console.error('Analysis error:', e);
        setRunStatus(s => ({ ...s, step: 'エラー発生', progress: 0, error: (e?.message || String(e) || '解析に失敗しました') }));
      }
      setRunning(false);
    })();
  }, [shaftElems, disks, bearings, settings, selectedAnalyses]);

  const shaftH = listHelpers(setShaftElems);
  const diskH = listHelpers(setDisks);
  const bearingH = listHelpers(setBearings);

  const totalLength = shaftElems.reduce((s, e) => s + e.length, 0);

  const fileInputRef = useRef(null);

  // ── モデルの保存（JSONダウンロード） ──
  const handleSaveModel = () => {
    const modelData = {
      _meta: {
        app: 'rotor-dynamics',
        version: 1,
        savedAt: new Date().toISOString(),
      },
      shaftElems,
      disks,
      bearings,
      settings,
    };
    const blob = new Blob([JSON.stringify(modelData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `rotor-model-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── モデルの読み込み（JSONアップロード） ──
  const handleLoadModelClick = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  // 配列内のidの欠損・重複を検出し、振り直す。振り直しが発生したらtrueを返す。
  const fixDuplicateOrMissingIds = (arr) => {
    const seen = new Set();
    let fixed = false;
    let nextId = 1;
    const usedIds = new Set(
      arr.map(item => item.id).filter(id => typeof id === 'number' && !isNaN(id))
    );
    const getNextFreeId = () => {
      while (usedIds.has(nextId)) nextId++;
      usedIds.add(nextId);
      return nextId;
    };
    const result = arr.map(item => {
      const hasValidId = typeof item.id === 'number' && !isNaN(item.id);
      if (!hasValidId || seen.has(item.id)) {
        fixed = true;
        return { ...item, id: getNextFreeId() };
      }
      seen.add(item.id);
      return item;
    });
    return { result, fixed };
  };

  // 指定フィールドが有限の数値かどうかチェックし、問題のあるフィールド名を集める
  const findInvalidNumericFields = (arr, fields, label) => {
    const problems = [];
    arr.forEach((item, i) => {
      fields.forEach(f => {
        const v = item[f];
        if (v !== undefined && (typeof v !== 'number' || !isFinite(v))) {
          problems.push(`${label}#${i + 1} の「${f}」`);
        }
      });
    });
    return problems;
  };

  const handleLoadModelFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);

        // ① 最低限の構造チェック（配列であり、かつ1件以上あるか）
        const isNonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
        if (!isNonEmptyArray(data.shaftElems) || !Array.isArray(data.disks) ||
            !Array.isArray(data.bearings) || !data.settings || typeof data.settings !== 'object') {
          alert('このファイルは正しいロータダイナミクスのモデルファイルではないようです。\n（シャフト要素・ディスク・軸受・設定のいずれかが見つからないか、シャフト要素が0件です）');
          return;
        }

        // ② 数値フィールドの妥当性チェック
        const numericProblems = [
          ...findInvalidNumericFields(data.shaftElems, ['length', 'outerDiam', 'innerDiam', 'youngMod', 'density'], 'シャフト要素'),
          ...findInvalidNumericFields(data.disks, ['position', 'mass', 'polarInertia', 'diametralInertia'], 'ディスク'),
          ...findInvalidNumericFields(data.bearings, ['position', 'kxx', 'kyy'], '軸受'),
        ];
        if (numericProblems.length > 0) {
          alert(
            'モデルファイルの中に、数値であるべき項目に不正な値が含まれています。読み込みを中止しました。\n\n' +
            numericProblems.slice(0, 8).join('\n') +
            (numericProblems.length > 8 ? `\n...ほか${numericProblems.length - 8}件` : '')
          );
          return;
        }

        // ③ idの欠損・重複を検出して振り直し（ユーザーには通知する）
        const shaftFix = fixDuplicateOrMissingIds(data.shaftElems);
        const diskFix = fixDuplicateOrMissingIds(data.disks);
        const bearingFix = fixDuplicateOrMissingIds(data.bearings);
        const anyIdFixed = shaftFix.fixed || diskFix.fixed || bearingFix.fixed;

        setShaftElems(shaftFix.result);
        setDisks(diskFix.result);
        setBearings(bearingFix.result);
        setSettings(data.settings);
        // 前回の解析結果や表示範囲はリセット（古いモデルの結果が残らないように）
        setResults({});
        setCampbellView({ minRpm: null, maxRpm: null, minFreq: null, maxFreq: null });
        setCriticalSpeeds([]);

        if (anyIdFixed) {
          const targets = [
            shaftFix.fixed && 'シャフト要素',
            diskFix.fixed && 'ディスク',
            bearingFix.fixed && '軸受',
          ].filter(Boolean).join('・');
          alert(`モデルは読み込まれましたが、${targets}のID（識別番号）に欠損または重複があったため、自動的に振り直しました。`);
        }
      } catch (err) {
        alert('ファイルの読み込みに失敗しました。JSON形式が正しいか確認してください。');
      }
    };
    reader.readAsText(file);
    // 同じファイルを連続して選択してもonChangeが発火するようにリセット
    e.target.value = '';
  };

  // ── 実行済みの全解析結果をまとめてCSVダウンロード ──
  const handleExportAllResults = () => {
    const lines = [];
    const push = (s = '') => lines.push(s);
    const hasAny =
      (results.eigenResults && results.eigenResults.length > 0) ||
      (results.complexResults && results.complexResults.length > 0) ||
      (results.campbellData && results.campbellData.length > 0) ||
      (results.freqResponse && results.freqResponse.length > 0);

    if (!hasAny) {
      alert('まだ解析結果がありません。先に「解析実行」を行ってください。');
      return;
    }

    push('ロータダイナミクス解析結果');
    push(`出力日時,${new Date().toLocaleString('ja-JP')}`);
    push('');

    // ① 固有値解析
    if (results.eigenResults && results.eigenResults.length > 0) {
      push('■ 固有値解析（Undamped Eigenvalue Analysis）');
      push('Mode,固有振動数[Hz],固有振動数[rpm]');
      results.eigenResults.forEach((r, i) => {
        push(`${i + 1},${r.freq.toFixed(4)},${(r.freq * 60).toFixed(1)}`);
      });
      push('');
    }

    // ② 複素固有値解析
    if (results.complexResults && results.complexResults.length > 0) {
      push('■ 複素固有値解析（Complex Eigenvalue Analysis）');
      push('Mode,回転方向,固有振動数[Hz],減衰比ζ,実部σ,安定性');
      results.complexResults.forEach(r => {
        const label = `Mode ${r.undampedModeIdx + 1}${r.isForward ? 'F' : 'B'}`;
        const dir = r.isForward ? 'Forward' : 'Backward';
        const stable = r.sigma < 0 ? '安定' : '不安定';
        push(`${label},${dir},${r.freq.toFixed(4)},${r.zeta.toFixed(5)},${r.sigma.toFixed(4)},${stable}`);
      });
      push('');
    }

    // ③ キャンベル線図（回転数ごとの各モード固有振動数）
    if (results.campbellData && results.campbellData.length > 0) {
      const modeCount = results.campbellData[0]?.modes?.length || 0;
      push('■ キャンベル線図（Campbell Diagram）');
      const header = ['回転数[rpm]'];
      for (let m = 0; m < modeCount; m++) {
        const sample = results.campbellData.find(pt => pt.modes[m])?.modes[m];
        const suffix = sample ? `${sample.undampedModeIdx + 1}${sample.isForward ? 'F' : 'B'}` : `${m + 1}`;
        header.push(`Mode${suffix}[Hz]`);
      }
      push(header.join(','));
      results.campbellData.forEach(pt => {
        const row = [pt.rpm.toFixed(0)];
        for (let m = 0; m < modeCount; m++) {
          row.push(pt.modes[m] ? pt.modes[m].freq.toFixed(3) : '');
        }
        push(row.join(','));
      });
      push('');
    }

    // ④ 危険速度一覧（1X/2X/3X 交点）
    if (criticalSpeeds && criticalSpeeds.length > 0) {
      push('■ 危険速度一覧（1X/2X/3X 励振線との交点）');
      push('次数,モード,回転数[rpm],周波数[Hz]');
      criticalSpeeds.forEach(cs => {
        push(`${cs.order}X,Mode ${cs.modeIdx + 1},${cs.rpm.toFixed(1)},${cs.freq.toFixed(2)}`);
      });
      push('');
    }

    // ⑤ 周波数応答（不釣合い応答）
    if (results.freqResponse && results.freqResponse.length > 0) {
      push('■ 周波数応答（アンバランス応答）');
      push('回転数[rpm],周波数[Hz],振幅[mm],位相[deg]');
      results.freqResponse.forEach(r => {
        push(`${r.rpm.toFixed(0)},${r.freq.toFixed(2)},${r.amplitude.toFixed(5)},${(r.phase || 0).toFixed(1)}`);
      });
      push('');
    }

    const csv = '\uFEFF' + lines.join('\n'); // BOM付き（Excelでの文字化け防止）
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `rotor-dynamics-results-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: COLORS.bg }}>
      <style>{css}</style>

      {/* 読み込み用の隠しファイル入力 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={handleLoadModelFile}
      />

      {/* ─── LEFT PANEL ─── */}
      <div style={{ width: 320, flexShrink: 0, background: COLORS.surface, borderRight: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '16px 18px 12px', borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, letterSpacing: '0.08em', fontFamily: 'JetBrains Mono' }}>
                ROTOR DYNAMICS
              </div>
              <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>FEM Analysis Suite</div>
            </div>
          </div>
          <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 10, marginBottom: 4, letterSpacing: '0.04em' }}>
            入力モデル（シャフト・ディスク・軸受・設定）
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="util-btn" onClick={handleLoadModelClick} title="JSONファイルからモデルを読み込み" style={{
              flex: 1, background: 'transparent', color: COLORS.textMuted,
              border: `1px solid ${COLORS.border}`,
            }}>
              <span className="util-btn-icon">📂</span>モデル読込
            </button>
            <button className="util-btn" onClick={handleSaveModel} title="モデルをJSONファイルとして保存" style={{
              flex: 1, background: 'transparent', color: COLORS.accent,
              border: `1px solid ${COLORS.accent}77`,
            }}>
              <span className="util-btn-icon">💾</span>モデル保存
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}` }}>
          {['model', 'analysis'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '9px 0', fontSize: 11, fontWeight: tab === t ? 600 : 400,
              background: 'transparent', color: tab === t ? COLORS.accent : COLORS.textMuted,
              borderBottom: tab === t ? `2px solid ${COLORS.accent}` : '2px solid transparent',
            }}>{t === 'model' ? 'モデル入力' : '解析設定'}</button>
          ))}
        </div>

        {/* Input area */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px' }}>
          {tab === 'model' && (
            <>
              {/* Structure overview */}
              <Section title="構造" accent={COLORS.accent}>
                <ShaftOverview
                  shaftElems={shaftElems}
                  disks={disks}
                  bearings={bearings}
                />
                <button
                  className="util-btn"
                  onClick={() => setShow3DView(true)}
                  disabled={shaftElems.length === 0}
                  style={{
                    width: '100%', marginTop: 8,
                    background: 'transparent', color: shaftElems.length === 0 ? COLORS.textMuted : COLORS.accent,
                    border: `1px solid ${shaftElems.length === 0 ? COLORS.border : COLORS.accent + '77'}`,
                  }}>
                  <span className="util-btn-icon">🔄</span>3Dで表示
                </button>
              </Section>

              {/* Shaft */}
              <Section title="シャフト要素" accent={COLORS.accent}>
                <div style={{ fontSize: 9, color: COLORS.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
                  ⠿ をドラッグして順序を入れ替えられます（左から右への連結順）。
                  並び替えるとシャフト全体の物理配置が変わるため、ディスク・軸受の位置がずれる場合があります。ずれた場合は「構造」の全体図で確認・再調整してください。
                </div>
                {(() => {
                  const positions = [0];
                  shaftElems.forEach(el => positions.push(+(positions[positions.length-1] + el.length).toFixed(4)));
                  return (
                    <AddRemoveList
                      items={shaftElems}
                      onAdd={() => shaftH.onAdd({ length: 0.1, outerDiam: 0.05, innerDiam: 0, youngMod: 200, density: 7800 })}
                      onRemove={shaftH.onRemove}
                      onUpdate={shaftH.onUpdate}
                      onDuplicate={shaftH.onDuplicate}
                      onReorder={setShaftElems}
                      renderItem={(el, upd) => {
                        const idx = shaftElems.findIndex(e => e.id === el.id);
                        const xStart = positions[idx] ?? 0;
                        const xEnd = positions[idx + 1] ?? 0;
                        return (
                          <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                              <span style={{ fontSize: 10, color: COLORS.textMuted }}>区間</span>
                              <span style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono' }}>
                                {xStart.toFixed(3)} → {xEnd.toFixed(3)} m
                              </span>
                            </div>
                            <FieldRow label="長さ L" value={el.length} onChange={v => upd({ length: v })} unit="m" step="0.01" />
                            <FieldRow label="外径 D" value={el.outerDiam} onChange={v => upd({ outerDiam: v })} unit="m" step="0.001" />
                            <FieldRow label="内径 d" value={el.innerDiam} onChange={v => upd({ innerDiam: v })} unit="m" step="0.001" />
                            <FieldRow label="ヤング率 E" value={el.youngMod} onChange={v => upd({ youngMod: v })} unit="GPa" />
                            <FieldRow label="密度 ρ" value={el.density} onChange={v => upd({ density: v })} unit="kg/m³" />
                          </>
                        );
                      }}
                    />
                  );
                })()}
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 6, fontFamily: 'JetBrains Mono' }}>
                  総長さ: {totalLength.toFixed(3)} m　|　ノード数: {shaftElems.length + 1}
                </div>
              </Section>

              {/* Disks */}
              <Section title="ディスク・取付部品" accent="#A78BFA">
                <AddRemoveList
                  items={disks}
                  onAdd={() => diskH.onAdd({
                    type: 'inducer', position: totalLength / 2, count: 1,
                    mass: 1.0, polarInertia: 0.005, diametralInertia: 0.003,
                    hasUnbalance: false, unbalanceMass: 0.001, eccentricity: 0.001, unbalancePhase: 0,
                  })}
                  onRemove={diskH.onRemove}
                  onUpdate={diskH.onUpdate}
                  onDuplicate={diskH.onDuplicate}
                  renderItem={(d, upd) => (
                    <>
                      {/* Type selector */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 134px', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: COLORS.textMuted }}>種類</span>
                        <select value={d.type || 'inducer'} onChange={e => upd({ type: e.target.value })}>
                          <option value="inducer">インデューサ</option>
                          <option value="impeller">インペラ</option>
                          <option value="balance_disk">バランスディスク</option>
                          <option value="turbine">タービン</option>
                          <option value="other">その他</option>
                        </select>
                      </div>
                      <FieldRow label="位置 x" value={d.position} onChange={v => upd({ position: v })} unit="m" step="0.01" />
                      <FieldRow label="個数 N" value={d.count||1} onChange={v => upd({ count: Math.max(1,Math.round(v)) })} unit="" min={1} />
                      <FieldRow label="質量 m (1個)" value={d.mass} onChange={v => upd({ mass: v })} unit="kg" step="0.1" />
                      <FieldRow label="極慣性 Jp" value={d.polarInertia} onChange={v => upd({ polarInertia: v })} unit="kg·m²" step="0.001" />
                      <FieldRow label="横慣性 Jd" value={d.diametralInertia} onChange={v => upd({ diametralInertia: v })} unit="kg·m²" step="0.001" />
                      {/* Unbalance toggle */}
                      <div
                        onClick={() => upd({ hasUnbalance: !d.hasUnbalance })}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, marginBottom: d.hasUnbalance ? 6 : 0,
                          padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                          background: d.hasUnbalance ? COLORS.danger+'18' : 'transparent',
                          border: `1px solid ${d.hasUnbalance ? COLORS.danger+'66' : COLORS.border}`,
                        }}>
                        <div style={{
                          width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                          background: d.hasUnbalance ? COLORS.danger : 'transparent',
                          border: `1.5px solid ${d.hasUnbalance ? COLORS.danger : COLORS.textMuted}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {d.hasUnbalance && <span style={{ fontSize: 8, color: '#fff', fontWeight: 700 }}>✓</span>}
                        </div>
                        <span style={{ fontSize: 10, color: d.hasUnbalance ? COLORS.danger : COLORS.textMuted }}>
                          アンバランスあり
                        </span>
                      </div>
                      {d.hasUnbalance && (
                        <div style={{ paddingLeft: 8, borderLeft: `2px solid ${COLORS.danger}44` }}>
                          <FieldRow label="不釣合質量 me" value={d.unbalanceMass||0} onChange={v => upd({ unbalanceMass: v })} unit="kg" step="0.0001" />
                          <FieldRow label="偏心量 e" value={d.eccentricity||0} onChange={v => upd({ eccentricity: v })} unit="m" step="0.0001" />
                          <FieldRow label="位相 φ (基準角度から)" value={d.unbalancePhase||0} onChange={v => upd({ unbalancePhase: v })} unit="deg" step="5" />
                          <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2, fontFamily: 'JetBrains Mono' }}>
                            U = {((d.unbalanceMass||0)*(d.eccentricity||0)*1000).toFixed(4)} g·m
                          </div>
                        </div>
                      )}

                      {/* ── RD流体力係数（機能フラグで非表示中） ── */}
                      {SHOW_RD_FORCE_UI && (
                        <>
                        <div
                          onClick={() => upd({ hasRdForce: !d.hasRdForce })}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 7, marginTop: 6,
                            marginBottom: d.hasRdForce ? 6 : 0,
                            padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                            background: d.hasRdForce ? '#00C6FF18' : 'transparent',
                            border: `1px solid ${d.hasRdForce ? COLORS.accent + '66' : COLORS.border}`,
                          }}>
                          <div style={{
                            width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                            background: d.hasRdForce ? COLORS.accent : 'transparent',
                            border: `1.5px solid ${d.hasRdForce ? COLORS.accent : COLORS.textMuted}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {d.hasRdForce && <span style={{ fontSize: 8, color: '#000', fontWeight: 700 }}>✓</span>}
                          </div>
                          <span style={{ fontSize: 10, color: d.hasRdForce ? COLORS.accent : COLORS.textMuted }}>
                            RD流体力係数あり
                          </span>
                        </div>
                        {d.hasRdForce && (
                          <div style={{ paddingLeft: 8, borderLeft: `2px solid ${COLORS.accent}44`, marginBottom: 4 }}>
                            <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginBottom: 4, marginTop: 2 }}>
                              付加剛性 / Cross-coupled Stiffness
                            </div>
                            <FieldRow label="K (対角剛性)" value={d.rd_K||0} onChange={v => upd({ rd_K: v })} unit="N/m" step="10000" />
                            <FieldRow label="k (連成剛性)" value={d.rd_k||0} onChange={v => upd({ rd_k: v })} unit="N/m" step="10000" />
                            <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginBottom: 4, marginTop: 6 }}>
                              付加減衰 / Added Damping
                            </div>
                            <FieldRow label="C (対角減衰)" value={d.rd_C||0} onChange={v => upd({ rd_C: v })} unit="N·s/m" step="10" />
                            <FieldRow label="c (連成減衰)" value={d.rd_c||0} onChange={v => upd({ rd_c: v })} unit="N·s/m" step="10" />
                            <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono', marginBottom: 4, marginTop: 6 }}>
                              付加質量 / Added Mass
                            </div>
                            <FieldRow label="M (対角質量)" value={d.rd_M||0} onChange={v => upd({ rd_M: v })} unit="kg" step="0.1" />
                            <FieldRow label="m (連成質量)" value={d.rd_m||0} onChange={v => upd({ rd_m: v })} unit="kg" step="0.1" />
                            <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 4, fontFamily: 'JetBrains Mono', lineHeight: 1.5 }}>
                              Fn/ε = M(ω/Ω)²−c(ω/Ω)−K &nbsp;|&nbsp; Ft/ε = −m(ω/Ω)²−C(ω/Ω)+k
                            </div>
                          </div>
                        )}

                      {/* ── Thomas/Alford力 (タービンのみ) ── */}
                      {d.type === 'turbine' && (
                        <>
                          <div
                            onClick={() => upd({ hasThomas: !d.hasThomas })}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 7, marginTop: 6,
                              marginBottom: d.hasThomas ? 6 : 0,
                              padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                              background: d.hasThomas ? COLORS.warning + '18' : 'transparent',
                              border: `1px solid ${d.hasThomas ? COLORS.warning + '66' : COLORS.border}`,
                            }}>
                            <div style={{
                              width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                              background: d.hasThomas ? COLORS.warning : 'transparent',
                              border: `1.5px solid ${d.hasThomas ? COLORS.warning : COLORS.textMuted}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {d.hasThomas && <span style={{ fontSize: 8, color: '#000', fontWeight: 700 }}>✓</span>}
                            </div>
                            <span style={{ fontSize: 10, color: d.hasThomas ? COLORS.warning : COLORS.textMuted }}>
                              Thomas/Alford力あり
                            </span>
                          </div>
                          {d.hasThomas && (
                            <div style={{ paddingLeft: 8, borderLeft: `2px solid ${COLORS.warning}44`, marginBottom: 4 }}>
                              <div style={{ fontSize: 10, color: COLORS.warning, fontFamily: 'JetBrains Mono', marginBottom: 4, marginTop: 2 }}>
                                K_xy = β × T / (D × H)
                              </div>
                              <FieldRow label="Thomas係数 β" value={d.thomas_beta||0.5} onChange={v => upd({ thomas_beta: v })} unit="−" step="0.01" />
                              <FieldRow label="軸トルク T" value={d.thomas_torque||0} onChange={v => upd({ thomas_torque: v })} unit="N·m" step="100" />
                              <FieldRow label="タービン径 D" value={d.thomas_diameter||0.1} onChange={v => upd({ thomas_diameter: v })} unit="m" step="0.01" />
                              <FieldRow label="翼高さ H" value={d.thomas_height||0.02} onChange={v => upd({ thomas_height: v })} unit="m" step="0.001" />
                              {(() => {
                                const T = d.thomas_torque || 0;
                                const D = d.thomas_diameter || 0.1;
                                const H = d.thomas_height || 0.02;
                                const beta = d.thomas_beta || 0.5;
                                const Kxy = (D > 0 && H > 0) ? beta * T / (D * H) : 0;
                                return (
                                  <div style={{ fontSize: 9, color: COLORS.warning, marginTop: 4, fontFamily: 'JetBrains Mono' }}>
                                    → K_xy = {Kxy.toExponential(3)} N/m
                                    {Kxy > 0 && <span style={{ color: COLORS.danger, marginLeft: 8 }}>⚠ 不安定化方向</span>}
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </>
                      )}
                        </>
                      )}
                    </>
                  )}
                />
              </Section>

              {/* Bearings */}
              <Section title="ベアリング" accent={COLORS.warning}>
                <AddRemoveList
                  items={bearings}
                  onAdd={() => bearingH.onAdd({ position: 0, kxx: 5e8, kyy: 5e8, kxy: 0, kyx: 0, cxx: 200, cyy: 200 })}
                  onRemove={bearingH.onRemove}
                  onUpdate={bearingH.onUpdate}
                  onDuplicate={bearingH.onDuplicate}
                  renderItem={(b, upd) => (
                    <>
                      <FieldRow label="位置 x" value={b.position} onChange={v => upd({ position: v })} unit="m" step="0.01" />
                      <FieldRow label="Kxx" value={b.kxx} onChange={v => upd({ kxx: v })} unit="N/m" step="100000" />
                      <FieldRow label="Kyy" value={b.kyy} onChange={v => upd({ kyy: v })} unit="N/m" step="100000" />
                      <FieldRow label="Kxy" value={b.kxy} onChange={v => upd({ kxy: v })} unit="N/m" />
                      <FieldRow label="Kyx" value={b.kyx} onChange={v => upd({ kyx: v })} unit="N/m" />
                      <FieldRow label="Cxx" value={b.cxx} onChange={v => upd({ cxx: v })} unit="N·s/m" step="10" />
                      <FieldRow label="Cyy" value={b.cyy} onChange={v => upd({ cyy: v })} unit="N·s/m" step="10" />
                    </>
                  )}
                />
              </Section>
            </>
          )}

          {tab === 'analysis' && (
            <>
              <Section title="回転数範囲">
                <FieldRow label="最小回転数" value={settings.minRpm} onChange={v => setSettings(s => ({ ...s, minRpm: v }))} unit="rpm" step="100" />
                <FieldRow label="最大回転数" value={settings.maxRpm} onChange={v => setSettings(s => ({ ...s, maxRpm: v }))} unit="rpm" step="100" />
              </Section>
              <Section title="解析オプション">
                <FieldRow label="モード数" value={settings.nModes} onChange={v => setSettings(s => ({ ...s, nModes: Math.max(1, Math.round(v)) }))} unit="" min={1} />
              </Section>
              <Section title="レイリー減衰">
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 8 }}>
                  [C] = α[M] + β[K]
                </div>
                <FieldRow label="α (質量比例)" value={settings.alphaRayleigh} onChange={v => setSettings(s => ({ ...s, alphaRayleigh: v }))} unit="" step="0.01" />
                <FieldRow label="β (剛性比例)" value={settings.betaRayleigh} onChange={v => setSettings(s => ({ ...s, betaRayleigh: v }))} unit="" step="0.000001" />
              </Section>
            </>
          )}
        </div>

        {/* Analysis selection + Run button + status */}
        <div style={{ padding: 14, borderTop: `1px solid ${COLORS.border}` }}>
          {/* Checkboxes */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 8, letterSpacing: '0.05em' }}>実行する解析を選択</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {[
                { key: 'eigen',    label: '① 固有値解析',     color: COLORS.accent },
                { key: 'complex',  label: '② 複素固有値',     color: '#A78BFA' },
                { key: 'campbell', label: '　キャンベル線図',  color: COLORS.warning },
                { key: 'freq',     label: '③ 周波数応答',     color: COLORS.danger },
              ].map(({ key, label, color }) => {
                const checked = selectedAnalyses[key];
                // campbell requires complex
                const disabled = key === 'campbell' && !selectedAnalyses.complex;
                return (
                  <div key={key}
                    onClick={() => {
                      if (disabled) return;
                      setSelectedAnalyses(s => {
                        const next = { ...s, [key]: !s[key] };
                        // if complex unchecked, also uncheck campbell
                        if (key === 'complex' && !next.complex) next.campbell = false;
                        return next;
                      });
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px',
                      borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
                      background: checked ? color + '18' : 'transparent',
                      border: `1px solid ${checked ? color + '66' : COLORS.border}`,
                      opacity: disabled ? 0.4 : 1,
                    }}>
                    <div style={{
                      width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                      background: checked ? color : 'transparent',
                      border: `1.5px solid ${checked ? color : COLORS.textMuted}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {checked && <span style={{ fontSize: 9, color: '#000', fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 10, color: checked ? color : COLORS.textMuted, lineHeight: 1.2 }}>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <button onClick={runAnalysis} disabled={running || Object.values(selectedAnalyses).every(v => !v)} style={{
            width: '100%', padding: '10px', fontSize: 13, fontWeight: 600,
            background: running || Object.values(selectedAnalyses).every(v => !v) ? COLORS.surface2 : `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accent2})`,
            color: running || Object.values(selectedAnalyses).every(v => !v) ? COLORS.textMuted : '#000',
            letterSpacing: '0.05em',
          }}>
            {running ? '解析中...' : '▶ 解析実行'}
          </button>

          <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 10, marginBottom: 4, letterSpacing: '0.04em' }}>
            出力結果（計算されたグラフ・数値データ）
          </div>
          <button className="util-btn" onClick={handleExportAllResults} style={{
            width: '100%',
            background: 'transparent', color: COLORS.accent,
            border: `1px solid ${COLORS.accent}77`,
          }}>
            <span className="util-btn-icon">📄</span>解析結果をCSVで保存
          </button>

          {/* Progress bar */}
          {(running || runStatus.progress > 0) && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: runStatus.error ? COLORS.danger : runStatus.progress === 100 ? COLORS.success : COLORS.accent, fontFamily: 'JetBrains Mono' }}>
                  {runStatus.error ? `⚠ ${runStatus.error}` : runStatus.progress === 100 ? `✓ ${runStatus.step}` : `⟳ ${runStatus.step}`}
                </span>
                <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                  {runStatus.progress}%
                </span>
              </div>
              <div style={{ height: 3, background: COLORS.border, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${runStatus.progress}%`,
                  background: runStatus.error ? COLORS.danger : runStatus.progress === 100 ? COLORS.success : COLORS.accent,
                  transition: 'width 0.3s ease',
                }} />
              </div>
              {runStatus.elapsed > 0 && (
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 4, textAlign: 'right', fontFamily: 'JetBrains Mono' }}>
                  {runStatus.elapsed} ms
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── RIGHT PANEL ─── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Analysis tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surface, padding: '0 20px' }}>
          {[
            { key: 'eigen', label: '① 固有値解析' },
            { key: 'complex', label: '② 複素固有値解析' },
            { key: 'campbell', label: 'キャンベル線図' },
            { key: 'freq', label: '③ 周波数応答解析' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setAnalysisTab(key)} style={{
              padding: '11px 18px', fontSize: 12, fontWeight: analysisTab === key ? 600 : 400,
              background: 'transparent', color: analysisTab === key ? COLORS.accent : COLORS.textMuted,
              borderBottom: analysisTab === key ? `2px solid ${COLORS.accent}` : '2px solid transparent',
              marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {!results || (!results.eigenResults && !results.complexResults && !results.freqResponse) ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
              <div style={{ width: 60, height: 60, borderRadius: '50%', border: `2px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 24, color: COLORS.textMuted }}>⚙</span>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: COLORS.textBright, fontSize: 14, marginBottom: 6 }}>解析を実行してください</div>
                <div style={{ color: COLORS.textMuted, fontSize: 12 }}>モデルを設定して「解析実行」ボタンを押してください</div>
              </div>
            </div>
          ) : (
            <>
              {/* Not-yet-run placeholder */}
              {(
                (analysisTab === 'eigen' && !results.eigenResults) ||
                (analysisTab === 'complex' && !results.complexResults) ||
                (analysisTab === 'campbell' && !results.campbellData) ||
                (analysisTab === 'freq' && !Array.isArray(results.freqResponse))
              ) && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12 }}>
                  <div style={{ fontSize: 28, color: COLORS.textMuted }}>—</div>
                  <div style={{ color: COLORS.textMuted, fontSize: 12 }}>この解析はまだ実行されていません</div>
                  <div style={{ color: COLORS.textMuted, fontSize: 11 }}>左パネルのチェックボックスで選択して「解析実行」を押してください</div>
                  {analysisTab === 'freq' && results._diag && (
                    <div style={{ marginTop: 16, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, fontFamily: 'JetBrains Mono', fontSize: 11 }}>
                      <div style={{ color: COLORS.accent, marginBottom: 8, fontWeight: 600 }}>診断情報</div>
                      {Object.entries(results._diag).map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
                          <span style={{ color: COLORS.textMuted, minWidth: 160 }}>{k}</span>
                          <span style={{ color: typeof v === 'boolean' ? (v ? COLORS.success : COLORS.danger) : COLORS.textBright }}>{String(v)}</span>
                        </div>
                      ))}
                      {results._freqError && (
                        <div style={{ marginTop: 8, color: COLORS.danger }}>エラー: {results._freqError}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ① Eigenvalue */}
              {analysisTab === 'eigen' && results.eigenResults && (
                <div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    <StatCard label="モード数" value={results.eigenResults.length} unit="" />
                    <StatCard label="1次固有振動数" value={results.eigenResults[0]?.freq.toFixed(2) || '—'} unit="Hz" />
                    <StatCard label="1次固有振動数" value={results.eigenResults[0] ? (results.eigenResults[0].freq * 60).toFixed(0) : '—'} unit="rpm" />
                    <StatCard label="DOF数" value={results.nDOF} unit="" />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 12 }}>固有振動数一覧</div>
                      <table>
                        <thead><tr><th>モード</th><th>ωₙ [rad/s]</th><th>fₙ [Hz]</th><th>fₙ [rpm]</th></tr></thead>
                        <tbody>
                          {results.eigenResults.map((r, i) => (
                            <tr key={i} style={{ cursor: 'pointer', background: selectedMode === i ? COLORS.surface2 : '' }}
                              onClick={() => setSelectedMode(i)}>
                              <td style={{ color: COLORS.accent }}>Mode {i+1}</td>
                              <td>{r.omega.toFixed(1)}</td>
                              <td style={{ color: COLORS.textBright, fontWeight: 600 }}>{r.freq.toFixed(2)}</td>
                              <td>{(r.freq * 60).toFixed(0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 12 }}>
                        モード形状 — Mode {selectedMode + 1} ({results.eigenResults[selectedMode]?.freq.toFixed(2)} Hz)
                      </div>
                      <ModeShape
                        mode={results.eigenResults[selectedMode]?.mode}
                        nodePositions={results.nodePositions}
                        bearings={bearings}
                        disks={disks}
                        width={460} height={190}
                      />
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 6 }}>モードを選択:</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {results.eigenResults.map((r, i) => (
                            <button key={i} onClick={() => setSelectedMode(i)} style={{
                              padding: '3px 10px', fontSize: 10, fontFamily: 'JetBrains Mono',
                              background: selectedMode === i ? COLORS.accent : COLORS.surface2,
                              color: selectedMode === i ? '#000' : COLORS.textMuted,
                              border: `1px solid ${COLORS.border}`,
                            }}>M{i+1}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 14, border: `1px solid ${COLORS.border}` }}>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                      <span style={{ color: COLORS.accent }}>運動方程式 (固有値解析):</span>&nbsp;
                      (K − ω²M)ϕ = 0 &nbsp;|&nbsp; q = ϕe^(jωt)
                    </div>
                  </div>
                </div>
              )}

              {/* ② Complex eigenvalue */}
              {analysisTab === 'complex' && results.complexResults && (
                <div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    <StatCard label="解析回転数" value={(settings.maxRpm).toFixed(0)} unit="rpm" />
                    <StatCard label="1次固有振動数" value={results.complexResults[0]?.freq.toFixed(2) || '—'} unit="Hz" />
                    <StatCard label="1次減衰比" value={results.complexResults[0]?.zeta.toFixed(4) || '—'} unit="ζ" />
                  </div>

                  <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 12 }}>複素固有値解析結果</div>
                    <table>
                      <thead>
                        <tr>
                          <th>モード</th>
                          <th>f [Hz]</th>
                          <th>σ (減衰率)</th>
                          <th>ζ (減衰比)</th>
                          <th>安定性</th>
                          <th>Whirl方向</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.complexResults.map((r, i) => (
                          <tr key={i}>
                            <td style={{ color: r.isForward ? COLORS.accent : '#A78BFA' }}>Mode {r.undampedModeIdx+1}{r.isForward ? 'F' : 'B'}</td>
                            <td style={{ color: COLORS.textBright, fontWeight: 600 }}>{r.freq.toFixed(2)}</td>
                            <td style={{ fontFamily: 'JetBrains Mono', color: r.sigma < 0 ? COLORS.success : COLORS.danger }}>
                              {r.sigma.toFixed(4)}
                            </td>
                            <td>{r.zeta.toFixed(4)}</td>
                            <td>
                              <span style={{
                                fontSize: 10, padding: '2px 8px', borderRadius: 10,
                                background: r.sigma < 0 ? COLORS.success + '22' : COLORS.danger + '22',
                                color: r.sigma < 0 ? COLORS.success : COLORS.danger,
                              }}>{r.sigma < 0 ? '安定 ✓' : '不安定 !'}</span>
                            </td>
                            <td style={{ color: r.isForward ? COLORS.accent : '#A78BFA' }}>
                              {r.isForward ? 'Forward ↻' : 'Backward ↺'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ── Whirl Orbit ── */}
                  <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 4 }}>
                      ふれまわり軌跡 (Whirl Orbit)
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12 }}>
                      モードを選択してアニメーションを確認できます
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                      {results.complexResults.map((r, i) => (
                        <button key={i} onClick={() => setSelectedMode(i)} style={{
                          padding: '4px 12px', fontSize: 10, fontFamily: 'JetBrains Mono',
                          borderRadius: 6, cursor: 'pointer',
                          background: selectedMode === i ? (r.isForward ? COLORS.accent : '#A78BFA') + '33' : 'transparent',
                          color: selectedMode === i ? (r.isForward ? COLORS.accent : '#A78BFA') : COLORS.textMuted,
                          border: `1px solid ${selectedMode === i ? (r.isForward ? COLORS.accent : '#A78BFA') + '88' : COLORS.border}`,
                        }}>
                          Mode {r.undampedModeIdx+1}{r.isForward ? 'F' : 'B'} · {r.freq.toFixed(1)}Hz · {r.isForward ? '↻Forward' : '↺Backward'}
                        </button>
                      ))}
                    </div>
                    <WhirlOrbitVisualizer
                      complexResults={results.complexResults}
                      selectedMode={selectedMode}
                      nodePositions={results.nodePositions}
                      disks={disks}
                      bearings={bearings}
                      settings={settings}
                    />
                  </div>

                  {/* ── 安定性評価 (C_eff) ── */}
                  {(() => {
                    // C_eff = C_modal * (1 - k_modal / (C_modal * ωn))
                    // C_eff > 0: 安定, C_eff < 0: 不安定 (内海2016セミナー p.60)
                    const hasRdAny = SHOW_RD_FORCE_UI && disks.some(d => d.hasRdForce || d.hasThomas);
                    if (!hasRdAny) return null;
                    return (
                      <div style={{ background: COLORS.surface, borderRadius: 8, padding: 14, border: `1px solid ${COLORS.accent}33`, marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, marginBottom: 10 }}>
                          安定性評価 — 等価減衰係数 C_eff
                        </div>
                        <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginBottom: 10 }}>
                          C_eff = C·(1 − k / (C·ωn)) &nbsp;|&nbsp; C_eff &gt; 0: 安定 &nbsp;C_eff &lt; 0: 不安定
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {results.complexResults.slice(0, 6).map((r, i) => {
                            // モーダル C と k を全ディスクのRD係数から推定
                            // (簡易: 全RD係数の和をモーダル量として使用)
                            const totalC = disks.filter(d => d.hasRdForce).reduce((s, d) => s + (d.rd_C||0), 0);
                            const totalK_cross = disks.filter(d => d.hasRdForce).reduce((s, d) => s + (d.rd_k||0), 0)
                              + disks.filter(d => d.hasThomas && d.type==='turbine').reduce((s, d) => {
                                  const T=d.thomas_torque||0, D=d.thomas_diameter||0.1, H=d.thomas_height||0.02, b=d.thomas_beta||0.5;
                                  return s + ((D>0&&H>0) ? b*T/(D*H) : 0);
                                }, 0);
                            const omegaN = r.omega || (r.freq * 2 * Math.PI);
                            const Ceff = totalC > 0 ? totalC * (1 - totalK_cross / (totalC * omegaN)) : null;
                            const stable = Ceff !== null ? Ceff > 0 : r.sigma < 0;
                            const color = stable ? COLORS.success : COLORS.danger;
                            return (
                              <div key={i} style={{
                                background: color + '11', border: `1px solid ${color}44`,
                                borderRadius: 6, padding: '8px 12px', minWidth: 120,
                              }}>
                                <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 4 }}>Mode {r.undampedModeIdx+1}{r.isForward ? 'F' : 'B'} ({r.freq.toFixed(1)} Hz)</div>
                                {Ceff !== null ? (
                                  <div style={{ fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700, color }}>
                                    {Ceff.toFixed(1)} <span style={{ fontSize: 9, fontWeight: 400 }}>Ns/m</span>
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 10, color: COLORS.textMuted }}>RD係数未設定</div>
                                )}
                                <div style={{ fontSize: 10, color, marginTop: 2 }}>
                                  {stable ? '✓ 安定' : '⚠ 不安定'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 8, fontFamily: 'JetBrains Mono' }}>
                          ※ C_eff は全コンポーネントのRD係数総和から算出 (内海 2016, p.60)
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ background: COLORS.surface, borderRadius: 8, padding: 14, border: `1px solid ${COLORS.border}`, marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                      <span style={{ color: COLORS.accent }}>運動方程式 (複素固有値解析):</span>&nbsp;
                      (λ²M + λ(C+ΩG) + K)ϕ = 0 &nbsp;|&nbsp; λ = σ + jω
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 4 }}>
                      ζ = −σ / √(σ²+ω²) &nbsp;|&nbsp; σ&lt;0: 安定 &nbsp;σ&gt;0: 不安定
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', marginTop: 4 }}>
                      C_eff = C·(1−k/(C·ωn)) &nbsp;|&nbsp; 参考: 内海 (2016) JAXA
                    </div>
                  </div>
                </div>
              )}

              {/* Campbell */}
              {analysisTab === 'campbell' && results.campbellData && (
                <div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <StatCard label="回転数ステップ" value={results.campbellData.length} unit="点" />
                    <StatCard label="最大回転数" value={settings.maxRpm} unit="rpm" />
                    <StatCard label="解析モード数" value={settings.nModes} unit="" />
                    {/* Axis range controls */}
                    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>表示範囲</span>
                      {[
                        { label: 'rpm 下限', key: 'minRpm', unit: 'rpm', step: 100 },
                        { label: 'rpm 上限', key: 'maxRpm', unit: 'rpm', step: 100 },
                        { label: 'Hz 下限',  key: 'minFreq', unit: 'Hz', step: 10 },
                        { label: 'Hz 上限',  key: 'maxFreq', unit: 'Hz', step: 10 },
                      ].map(({ label, key, unit, step }) => (
                        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>{label}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="number" step={step}
                              placeholder="auto"
                              value={campbellView[key] ?? ''}
                              onChange={e => setCampbellView(v => ({ ...v, [key]: e.target.value === '' ? null : parseFloat(e.target.value) }))}
                              style={{ width: 80, textAlign: 'right', fontFamily: 'JetBrains Mono', fontSize: 11 }}
                            />
                            <span style={{ fontSize: 10, color: COLORS.textMuted }}>{unit}</span>
                          </div>
                        </div>
                      ))}
                      <button onClick={() => setCampbellView({ minRpm: null, maxRpm: null, minFreq: null, maxFreq: null })}
                        style={{ fontSize: 10, padding: '4px 10px', background: COLORS.surface2, color: COLORS.textMuted, border: `1px solid ${COLORS.border}` }}>
                        リセット
                      </button>
                    </div>
                  </div>
                  <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 16, display: 'inline-block' }}>
                    <CampbellDiagram
                      campbellData={results.campbellData}
                      maxRpm={settings.maxRpm}
                      minRpmLim={campbellView.minRpm}
                      maxRpmLim={campbellView.maxRpm}
                      minFreqLim={campbellView.minFreq}
                      maxFreqLim={campbellView.maxFreq}
                      width={680} height={340}
                      onCriticalSpeeds={setCriticalSpeeds}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                    {[[COLORS.danger, '1X'], [COLORS.warning, '2X'], ['#A78BFA', '3X']].map(([c, label]) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 20, height: 2, background: c, borderTop: '1px dashed ' + c }} />
                        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>{label} 励振線</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 20, height: 2, background: COLORS.accent }} />
                      <span style={{ fontSize: 11, color: COLORS.textMuted }}>固有振動数曲線</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, background: COLORS.textBright, transform: 'rotate(45deg)' }} />
                      <span style={{ fontSize: 11, color: COLORS.textMuted }}>危険速度（交点）</span>
                    </div>
                  </div>

                  {/* 危険速度（1X/2X/3X 交点）一覧表 */}
                  {criticalSpeeds.length > 0 && (
                    <div style={{ marginTop: 16, background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}` }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textBright, marginBottom: 10 }}>
                        危険速度一覧（1X/2X/3X 励振線との交点）
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'JetBrains Mono' }}>
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', color: COLORS.textMuted, fontWeight: 500 }}>次数</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', color: COLORS.textMuted, fontWeight: 500 }}>モード</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: COLORS.textMuted, fontWeight: 500 }}>回転数 [rpm]</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: COLORS.textMuted, fontWeight: 500 }}>周波数 [Hz]</th>
                          </tr>
                        </thead>
                        <tbody>
                          {criticalSpeeds.map((cs, i) => {
                            const orderColor = cs.order === 1 ? COLORS.danger : cs.order === 2 ? COLORS.warning : '#A78BFA';
                            return (
                              <tr key={i} style={{ borderBottom: `1px solid ${COLORS.border}55` }}>
                                <td style={{ padding: '6px 8px', color: orderColor, fontWeight: 600 }}>{cs.order}X</td>
                                <td style={{ padding: '6px 8px', color: COLORS.text }}>Mode {cs.modeIdx + 1}</td>
                                <td style={{ padding: '6px 8px', color: COLORS.text, textAlign: 'right' }}>{cs.rpm.toFixed(0)}</td>
                                <td style={{ padding: '6px 8px', color: COLORS.text, textAlign: 'right' }}>{cs.freq.toFixed(1)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 9, color: COLORS.textMuted, marginTop: 8 }}>
                        ※ 表示中の軸範囲内に存在する交点のみ表示。データ点間の線形補間による近似値です。
                      </div>
                    </div>
                  )}
                  <div style={{ marginTop: 12, background: COLORS.surface, borderRadius: 8, padding: 14, border: `1px solid ${COLORS.border}` }}>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                      <span style={{ color: COLORS.accent }}>危険速度条件:</span>&nbsp;
                      f_i(Ω) = n·(Ω/60) &nbsp;[Hz] &nbsp;|&nbsp; n = 1, 2, 3, ...
                    </div>
                  </div>
                </div>
              )}

              {/* ③ Frequency response */}
              {analysisTab === 'freq' && Array.isArray(results.freqResponse) && (() => {
                const data = results.freqResponse;
                const amps = data.map(d => d.amplitude).filter(a => isFinite(a));
                const maxAmp = amps.length > 0 ? Math.max(...amps) : 0;
                const critRpm = data.find(d => d.amplitude === maxAmp)?.rpm;
                const freqMaxRpm = results.freqMaxRpm || settings.maxRpm;

                // Vertical lines at each eigenfrequency (Hz → rpm)
                const modeColors = [COLORS.danger, COLORS.warning, '#A78BFA', COLORS.success, '#F472B6'];
                const eigenVLines = (results.eigenResults || []).map((r, i) => ({
                  x: r.freq * 60,  // Hz to rpm
                  color: modeColors[i % modeColors.length],
                  label: `M${i+1} ${r.freq.toFixed(0)}Hz`,
                }));

                return (
                  <div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                      <StatCard label="最大振幅" value={maxAmp.toExponential(3)} unit="mm" accent={COLORS.danger} />
                      <StatCard label="危険速度 (ピーク)" value={critRpm?.toFixed(0) || '—'} unit="rpm" accent={COLORS.danger} />
                      <StatCard label="解析上限" value={Math.round(freqMaxRpm)} unit="rpm" />
                      <StatCard label="アンバランス数" value={disks.filter(d => d.hasUnbalance).length} unit="箇所" />
                    </div>

                    {/* eigen markers legend */}
                    {eigenVLines.length > 0 && (
                      <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: 10, color: COLORS.textMuted }}>固有振動数:</span>
                        {eigenVLines.map((vl, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <div style={{ width: 12, height: 2, borderTop: `2px dashed ${vl.color}` }} />
                            <span style={{ fontSize: 10, color: vl.color, fontFamily: 'JetBrains Mono' }}>{vl.label}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 16 }}>
                      <LineChart
                        data={data}
                        xKey="rpm" yKey="amplitude"
                        title="ボード線図 — 振幅"
                        xLabel="回転数 [rpm]" yLabel="振幅 [mm]"
                        color={COLORS.accent}
                        vLines={eigenVLines}
                        width={680} height={260}
                      />
                    </div>

                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 16 }}>
                      <LineChart
                        data={data}
                        xKey="rpm" yKey="phase"
                        title="位相"
                        xLabel="回転数 [rpm]" yLabel="位相 [deg]"
                        color={COLORS.warning}
                        vLines={eigenVLines}
                        yMin={-180} yMax={180}
                        width={680} height={200}
                      />
                    </div>

                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: 14, border: `1px solid ${COLORS.border}` }}>
                      <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'JetBrains Mono' }}>
                        <span style={{ color: COLORS.accent }}>周波数応答方程式:</span>&nbsp;
                        [−Ω²M + jΩ(C+ΩG) + K]Q = F₀ &nbsp;|&nbsp; F_u = m_e·e·Ω²
                      </div>
                      <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 4, fontFamily: 'JetBrains Mono' }}>
                        解析範囲: {Math.round(settings.minRpm)} – {Math.round(freqMaxRpm)} rpm
                        {results.freqMaxRpm > settings.maxRpm && (
                          <span style={{ color: COLORS.warning, marginLeft: 8 }}>
                            ※ 設定maxRpmより自動拡張（固有振動数 × 1.5）
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>

      {/* 3D モデルビュー（モーダル） */}
      {show3DView && (
        <RotorModel3DViewer
          shaftElems={shaftElems}
          disks={disks}
          bearings={bearings}
          onClose={() => setShow3DView(false)}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, unit, accent }) {
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 16px', minWidth: 130 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono', fontSize: 18, fontWeight: 700, color: accent || COLORS.accent }}>
        {value} <span style={{ fontSize: 11, fontWeight: 400, color: COLORS.textMuted }}>{unit}</span>
      </div>
    </div>
  );
}
