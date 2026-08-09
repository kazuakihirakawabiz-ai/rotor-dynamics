// ═══════════════════════════════════════════════════════════════
// プラン・トライアル判定ロジック（共通）
//
// 経緯（product-memo 1-19・1-20参照）：
// 以前は `profile?.plan === 'paid1' || profile?.plan === 'paid2'` という判定が
// App.jsx・ComparePanel.jsx・CampbellComparePanel.jsx・FreqResponseComparePanel.jsx・
// ProjectsModal（App.jsx内）に、それぞれ独立してコピーされる形で実装されていた。
// Proトライアル機能の追加にあたり、この判定を1箇所に集約しないと「一部の画面だけ
// トライアル中でもロックされたまま」という不整合が起きることが実機確認で判明したため、
// このファイルに切り出した。
//
// 今後プラン判定の条件を変える場合は、このファイルだけを直せば全画面に反映される。
// ═══════════════════════════════════════════════════════════════

// Proプラン（契約）またはトライアル中かどうかを判定する共通関数。
// plan列は契約プランの真実（Stripe webhookのみが更新）、トライアル状態は
// 別カラム（trial_active等）で管理する、という方針（1-19）に基づく。
export function isProOrTrial(profile) {
  if (!profile) return false;
  return profile.plan === 'paid1' || profile.plan === 'paid2' || profile.trial_active === true;
}

// トライアル開始からの経過日数が trial_duration_days を超えていたら失効させる。
// 「遅延評価」方式（バッチ処理は使わず、profile取得のたびにその場でチェックする）。
export function isTrialExpired(profile) {
  if (!profile || !profile.trial_active || !profile.trial_started_at) return false;
  const startedAt = new Date(profile.trial_started_at).getTime();
  const durationMs = (profile.trial_duration_days || 30) * 24 * 60 * 60 * 1000;
  return Date.now() >= startedAt + durationMs;
}
