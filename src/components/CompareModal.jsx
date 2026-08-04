import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { matchMultipleAgainstReference } from "../analysis/macMatching.js";
import { COLORS } from "./charts/chartTheme.js";

// App.jsx側と同じSupabaseクライアント設定を再利用する。
// 【注記】App.jsx側で既に作成済みのsupabaseクライアントをpropsで渡す方式も検討したが、
// 他のコンポーネント(ProjectsModal等)も同様にモジュールトップレベルでcreateClientしている
// 既存パターンに合わせた。createClientは同一設定なら複数回呼んでも実害はない。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// 低MAC値（対応が怪しいモード）の警告しきい値。
// プロトタイプ(mac_matching_prototype_1.jsx)と同じ値を踏襲。
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 複数プロジェクト比較（Proの中身・後半）
 * 保存済みプロジェクト同士の固有振動数比較を、MACによるモード対応づけを使って表示する。
 *
 * 【設計メモ】
 * - MAC計算はここ(クライアント側)でその場で実行する。保存時にMAC計算は行わない
 *   （projects.analysis_resultsにはfreq/modeの軽量データのみが入っている）。
 * - 比較方式は「基準モデル方式」（パターン1）：ユーザーが選んだ1つの基準プロジェクトに対し、
 *   他の全プロジェクトをそれぞれMAC対応づけする。全ペア総当たり(パターン2)は行わない。
 * - キャンベル線図の重ね描きは次段階のタスク（今回は固有振動数比較表のみ）。
 */
export function CompareModal({ projectIds, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]); // [{id, name, modes: [{freq, mode}]}]
  const [referenceId, setReferenceId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('id, name, analysis_results')
        .in('id', projectIds);
      if (cancelled) return;
      if (fetchError) {
        setError('プロジェクトの取得に失敗しました: ' + fetchError.message);
        setLoading(false);
        return;
      }
      const valid = (data || [])
        .filter(p => p.analysis_results?.modes?.length > 0)
        .map(p => ({ id: p.id, name: p.name, modes: p.analysis_results.modes }))
        // 選択順(projectIds)を保つ。Supabaseのin()はDB側の順序を保証しないため。
        .sort((a, b) => projectIds.indexOf(a.id) - projectIds.indexOf(b.id));
      setProjects(valid);
      setReferenceId(valid[0]?.id ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [projectIds]);

  const referenceProject = projects.find(p => p.id === referenceId) || null;
  const targetProjects = projects.filter(p => p.id !== referenceId);

  // 基準モデルの各モードに対し、他の各プロジェクトをMAC対応づけする（基準モデル方式）
  const comparisonResults = useMemo(() => {
    if (!referenceProject || targetProjects.length === 0) return [];
    return matchMultipleAgainstReference(
      referenceProject.modes,
      targetProjects.map(t => ({ projectId: t.id, name: t.name, modes: t.modes })),
      { lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD }
    );
  }, [referenceProject, targetProjects]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#000000CC', zIndex: 2100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 860, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
        background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textBright, fontFamily: 'JetBrains Mono' }}>
            プロジェクト比較（固有振動数）
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: COLORS.textMuted, fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 16, lineHeight: 1.6 }}>
          モードの対応づけには MAC（Modal Assurance Criterion） を使用しています。周波数の順番ではなく、モード形状そのものの類似度で対応づけているため、
          設計変更でモードの出現順序が入れ替わっている場合でも、同じ変形パターン同士を正しく比較できます。
        </div>

        {loading ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '40px 0', textAlign: 'center' }}>読み込み中...</div>
        ) : error ? (
          <div style={{ fontSize: 12, color: COLORS.danger, padding: '40px 0', textAlign: 'center' }}>{error}</div>
        ) : projects.length < 2 ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '40px 0', textAlign: 'center' }}>
            解析結果を持つプロジェクトが2件未満のため比較できません。
          </div>
        ) : (
          <>
            {/* 基準モデル選択 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>基準プロジェクト（他をこのモデルと比較します）</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setReferenceId(p.id)}
                    style={{
                      fontSize: 11, padding: '6px 12px', borderRadius: 6, fontWeight: p.id === referenceId ? 700 : 400,
                      background: p.id === referenceId ? COLORS.accent : COLORS.surface2,
                      color: p.id === referenceId ? '#fff' : COLORS.text,
                      border: `1px solid ${p.id === referenceId ? COLORS.accent : COLORS.border}`,
                      cursor: 'pointer',
                    }}
                  >{p.name}</button>
                ))}
              </div>
            </div>

            {/* 比較表 */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>基準: {referenceProject?.name}</th>
                    {targetProjects.map(t => (
                      <th key={t.id} style={thStyle}>{t.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {referenceProject?.modes.map((refMode, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, fontWeight: 700, color: COLORS.accent, fontFamily: 'JetBrains Mono' }}>
                        Mode {i + 1}　{refMode.freq.toFixed(1)} Hz
                      </td>
                      {targetProjects.map((t, tIdx) => {
                        const match = comparisonResults[tIdx]?.matches[i];
                        if (!match || match.targetIndex === null) {
                          return <td key={t.id} style={{ ...tdStyle, color: COLORS.textMuted }}>対応モードなし</td>;
                        }
                        const deltaHz = match.targetFreq - refMode.freq;
                        const deltaPct = refMode.freq !== 0 ? (deltaHz / refMode.freq) * 100 : 0;
                        return (
                          <td key={t.id} style={{
                            ...tdStyle,
                            background: match.lowConfidence ? COLORS.warning + '14' : 'transparent',
                          }}>
                            <div style={{ fontFamily: 'JetBrains Mono', color: COLORS.textBright }}>
                              Mode {match.targetIndex + 1}　{match.targetFreq.toFixed(1)} Hz
                            </div>
                            <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>
                              Δ{deltaHz >= 0 ? '+' : ''}{deltaHz.toFixed(1)}Hz（{deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%）
                              　MAC {match.macValue.toFixed(2)}
                              {match.lowConfidence && (
                                <span style={{ color: COLORS.warning, fontWeight: 700 }}> ⚠低信頼</span>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 12, lineHeight: 1.6 }}>
              ⚠低信頼＝MAC値が{LOW_CONFIDENCE_THRESHOLD}未満（同じ変形パターンである確度が低い対応づけ）。対応づけ自体は参考として表示していますが、判断は目視でも確認してください。<br />
              各基準モードについて、対象プロジェクト内でMACが最大のモードを自動選択しています（1対1の最適割当ではない簡易版のため、複数の基準モードが同じ対象モードを指す場合があります）。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${COLORS.border}`,
  color: COLORS.textMuted, fontWeight: 600, position: 'sticky', top: 0, background: COLORS.surface,
};
const tdStyle = {
  padding: '8px 10px', borderBottom: `1px solid ${COLORS.border}`, verticalAlign: 'top',
};
