// ─────────────────────────────────────────────
// ④ 周波数応答解析 (Frequency Response Analysis, Modal Superposition Method)
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
// ─────────────────────────────────────────────
import { matAdd, matScale } from './femCore.js';

export function solveFrequencyResponse(M, Ktotal, Ctotal, G, Kb, Cb, unbalances, omegaRange, nodePositions, modes) {
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

    // 全節点のy方向DOFについて、振幅[m]・位相[deg]を保持しておく。
    // 「どの点を見るか」は表示側（UI）で選べるようにするため、ここでは特定の点に絞らない。
    const nNodes = nodePositions.length;
    const nodeAmp = new Array(nNodes);
    const nodePhase = new Array(nNodes);
    for (let node = 0; node < nNodes; node++) {
      const dof = node * 4;
      const re = Qre[dof], im = Qim[dof];
      nodeAmp[node] = Math.sqrt(re * re + im * im) * 1000; // m → mm
      nodePhase[node] = Math.atan2(im, re) * 180 / Math.PI;
    }

    return {
      omega: Omega,
      freq: Omega / (2 * Math.PI),
      rpm: Omega * 60 / (2 * Math.PI),
      nodeAmp,
      nodePhase,
    };
  });
}
