// ─────────────────────────────────────────────
// 初期値データ (Default Values)
// リファクタリング前は App.jsx 内にベタ書きされていた定数群。
// materials / shaftElems / disks / bearings / settings の初期状態として
// App.jsx の useState(...) から参照される。
// ─────────────────────────────────────────────

// ── 材料マスタ ──
// シャフト要素は個別にヤング率・密度を持たず、ここで定義した材料をmaterialIdで参照する。
// （ロケットエンジン用ターボポンプでは使用材料の種類が限られるため、要素ごとに毎回入力するのは非効率という判断）
export const DEFAULT_MATERIALS = [
  { id: 1, name: 'インコネル718',        code: 'Inconel 718 (UNS N07718)', youngMod: 200, density: 8190 },
  { id: 2, name: 'SUS630 (17-4PH)',      code: 'SUS630 / 17-4PH',          youngMod: 196, density: 7780 },
  { id: 3, name: 'チタン合金 Ti-6Al-4V', code: 'Ti-6Al-4V',                youngMod: 114, density: 4430 },
];

export const DEFAULT_SHAFT = [
  { id: 1, length: 0.10, outerDiam: 0.04, innerDiam: 0.00, materialId: 1 }, // Inducer → Bearing A
  { id: 2, length: 0.12, outerDiam: 0.05, innerDiam: 0.01, materialId: 1 }, // Bearing A → Impeller
  { id: 3, length: 0.14, outerDiam: 0.05, innerDiam: 0.01, materialId: 1 }, // Impeller → Balance Disk
  { id: 4, length: 0.14, outerDiam: 0.05, innerDiam: 0.01, materialId: 1 }, // Balance Disk → Bearing B
  { id: 5, length: 0.10, outerDiam: 0.04, innerDiam: 0.00, materialId: 1 }, // Bearing B → Turbine (overhung)
];

// RD係数デフォルト値の参考（内海2016セミナー資料より）
// Closed impeller: K≈-2.6, k≈1.1, C≈3.1, c≈8.7, M≈6.7, m≈-0.6 (無次元→実寸変換要)
// 各コンポーネントのrd_*** フィールドは FEM マトリクスに直接加算される実寸値 [SI単位]
export const DEFAULT_DISKS = [
  { id: 1, name: 'インデューサ',  color: '#22C55E', position: 0.00, count: 1,
    mass: 1.2, polarInertia: 0.0030, diametralInertia: 0.0018,
    hasUnbalance: true,  unbalanceMass: 5e-4, eccentricity: 5e-4, unbalancePhase: 0,
    // RD流体力係数 (Rotordynamic Force Coefficients)
    hasRdForce: false,
    rd_K: -2e5, rd_k: 5e4, rd_C: 200, rd_c: 500, rd_M: 0, rd_m: 0,
    // Thomas/Alford力
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.1, thomas_height: 0.02,
  },
  { id: 2, name: 'インペラ',      color: '#A78BFA', position: 0.22, count: 1,
    mass: 5.5, polarInertia: 0.0180, diametralInertia: 0.0100,
    hasUnbalance: true,  unbalanceMass: 1e-3, eccentricity: 1e-3, unbalancePhase: 0,
    hasRdForce: false,
    rd_K: -3e5, rd_k: 1e5, rd_C: 300, rd_c: 800, rd_M: 0, rd_m: 0,
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.15, thomas_height: 0.03,
  },
  { id: 3, name: 'バランスディスク', color: '#B8860B', position: 0.36, count: 1,
    mass: 1.8, polarInertia: 0.0055, diametralInertia: 0.0030,
    hasUnbalance: false, unbalanceMass: 1e-4, eccentricity: 5e-4, unbalancePhase: 0,
    hasRdForce: false,
    rd_K: -1e5, rd_k: 2e4, rd_C: 100, rd_c: 200, rd_M: 0, rd_m: 0,
    hasThomas: false, thomas_beta: 0.5, thomas_torque: 0, thomas_diameter: 0.1, thomas_height: 0.02,
  },
  { id: 4, name: 'タービン',      color: '#C0392B', position: 0.60, count: 1,
    mass: 4.0, polarInertia: 0.0140, diametralInertia: 0.0080,
    hasUnbalance: true,  unbalanceMass: 8e-4, eccentricity: 8e-4, unbalancePhase: 180,
    hasRdForce: false,
    rd_K: -1e5, rd_k: 3e4, rd_C: 150, rd_c: 400, rd_M: 0, rd_m: 0,
    // Thomas/Alford力: K_xy = β × T / (D × L), タービン軸動力から自動計算
    hasThomas: false, thomas_beta: 0.56, thomas_torque: 5000, thomas_diameter: 0.12, thomas_height: 0.025,
  },
];

export const DEFAULT_BEARINGS = [
  { id: 1, name: '軸受A（ポンプ側）', position: 0.10, kxx: 8e8, kyy: 8e8, kxy: 0, kyx: 0, cxx: 500, cyy: 500 }, // Bearing A (ball, pump side)
  { id: 2, name: '軸受B（タービン側）', position: 0.50, kxx: 5e8, kyy: 5e8, kxy: 0, kyx: 0, cxx: 300, cyy: 300 }, // Bearing B (roller, turbine side)
];

export const DEFAULT_SETTINGS = { nModes: 5, minRpm: 0, maxRpm: 30000, alphaRayleigh: 0, betaRayleigh: 0 };
