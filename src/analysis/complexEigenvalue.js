// ─────────────────────────────────────────────
// ② 複素固有値解析 (Complex Eigenvalue Analysis)
// ①固有値解析(undampedModes)を再利用し、各モードにジャイロ効果による
// Forward/Backward分裂と減衰(σ, ζ)を第一次摂動で付与する。
// この結果(complexResults)は③キャンベル線図でも回転数ごとに繰り返し呼ばれる。
// ─────────────────────────────────────────────
import { solveEigenvalue } from './eigenvalue.js';

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
export function solveComplexEigenvalue(M, K, C, G, Omega, nModes, undampedModes) {
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
