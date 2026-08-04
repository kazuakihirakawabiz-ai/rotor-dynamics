// ─────────────────────────────────────────────
// ① 固有値解析 (Undamped Eigenvalue Analysis)
// 減衰・ジャイロ効果なしの実固有値・実モード形状を求める。
// ここで得た結果(undampedModes)は②複素固有値解析・③キャンベル線図でも再利用される。
// ─────────────────────────────────────────────
import { luFactor, luSolveFactored } from './femCore.js';

// Rayleigh quotient ω² = ϕᵀKϕ / ϕᵀMϕ
export function rayleighQuotient(K, M, phi) {
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
export function mNormalize(M, phi) {
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
export function mOrthogonalize(M, phi, basis) {
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
export function solveEigenvalue(M, K, nModes) {
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
