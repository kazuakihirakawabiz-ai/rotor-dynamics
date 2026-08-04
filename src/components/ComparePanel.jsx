import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  computeMACMatrix, matchModesByMAC, nearestFreqIndices, extractY, alignSign,
} from "../analysis/macMatching.js";
import { COLORS } from "./charts/chartTheme.js";

// App.jsx側と同じSupabaseクライアント設定を再利用する。
// 【注記】App.jsx側で既に作成済みのsupabaseクライアントをpropsで渡す方式も検討したが、
// 他のコンポーネント(ProjectsModal等)も同様にモジュールトップレベルでcreateClientしている
// 既存パターンに合わせた（旧CompareModal.jsxから踏襲）。createClientは同一設定なら
// 複数回呼んでも実害はない。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// 低MAC値（対応が怪しいモード）の警告しきい値。プロトタイプ・旧CompareModalと同じ値を踏襲。
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 複数プロジェクト比較（Pro限定機能）— 解析タブと同列の「比較」タブの中身。
 *
 * 【旧実装からの変更点】
 * 元々は「☁ クラウドプロジェクト」モーダル内でチェックボックス選択→別ウィンドウの
 * CompareModalが開く、という2段構成だったが、それをやめてこのコンポーネント1つに統合した：
 *   - プロジェクト一覧の取得・選択（旧ProjectsModal内にあった選択UI相当）
 *   - MAC行列・モード形状表示・比較表示ロジック（旧CompareModalの中身。ほぼそのまま）
 * モーダルの外枠（背景オーバーレイ・閉じるボタン）は撤去し、右パネルの通常コンテンツとして描画する。
 *
 * 【設計メモ】
 * - MAC計算はここ(クライアント側)でその場で実行する。保存時にMAC計算は行わない。
 * - 比較方式は「基準モデル方式」：選択したプロジェクトの中から基準を1つ選び、
 *   他のプロジェクトを1つずつタブで切り替えながらMAC対応づけする（全ペア総当たりはしない）。
 * - プロジェクト一覧は選択に使うidだけでなくanalysis_resultsも一括取得するため、
 *   「2つ選んだ後に選択分だけ再取得する」という旧CompareModalの2段階フェッチは不要になった。
 */
export function ComparePanel({ session, profile, onUpgradeClick }) {
  const isPaid = profile?.plan === 'paid1' || profile?.plan === 'paid2';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]); // 全プロジェクト一覧（analysis_results含む）
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [referenceId, setReferenceId] = useState(null);
  const [targetId, setTargetId] = useState(null); // タブで選ばれている比較対象1件

  useEffect(() => {
    if (!session || !isPaid) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('id, name, updated_at, analysis_results')
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (fetchError) {
        setError('プロジェクトの取得に失敗しました: ' + fetchError.message);
        setLoading(false);
        return;
      }
      setProjects(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session, isPaid]);

  // 選択中(かつ解析結果あり)のプロジェクトのみ、選択した順で並べる
  const selectedProjects = useMemo(() => {
    const order = [...selectedIds];
    return projects
      .filter(p => selectedIds.has(p.id) && p.analysis_results?.modes?.length > 0)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [projects, selectedIds]);

  const referenceProject = selectedProjects.find(p => p.id === referenceId) || null;
  const otherProjects = selectedProjects.filter(p => p.id !== referenceProject?.id);
  const targetProject = otherProjects.find(p => p.id === targetId) || otherProjects[0] || null;

  // 選択セットが変わったら、基準プロジェクトIDが選択の中に無ければ補正する
  useEffect(() => {
    if (selectedProjects.length === 0) { setReferenceId(null); return; }
    if (!selectedProjects.some(p => p.id === referenceId)) {
      setReferenceId(selectedProjects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjects]);

  // 基準モデルを切り替えたら、比較対象タブが基準と重複しないように補正する
  useEffect(() => {
    if (!referenceProject) return;
    if (!otherProjects.some(p => p.id === targetId)) {
      setTargetId(otherProjects[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceId, selectedProjects]);

  // 一覧取得結果は analysis_results.modes の形なので、比較ロジックが期待する
  // { id, name, modes, nodePositions, bearingPos, diskPos } の平坦な形に正規化する。
  // 以降このrefN/tgtNだけを単一のデータソースとして使う（二重定義によるバグの種を避ける）。
  const normalize = (p) => p && {
    id: p.id, name: p.name,
    modes: p.analysis_results?.modes || [],
    nodePositions: p.analysis_results?.nodePositions || [],
    bearingPos: p.analysis_results?.bearingPos || [],
    diskPos: p.analysis_results?.diskPos || [],
  };
  const refN = normalize(referenceProject) || { name: '', modes: [], nodePositions: [], bearingPos: [], diskPos: [] };
  const tgtN = normalize(targetProject) || { name: '', modes: [], nodePositions: [], bearingPos: [], diskPos: [] };
  const modesA = refN.modes;
  const modesB = tgtN.modes;
  const nodePositions = refN.nodePositions;

  const macMatrix = useMemo(() => computeMACMatrix(modesA, modesB), [modesA, modesB]);
  const matches = useMemo(
    () => matchModesByMAC(modesA, modesB, { lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD }),
    [modesA, modesB]
  );
  const nearestFreqIdx = useMemo(() => nearestFreqIndices(modesA, modesB), [modesA, modesB]);

  // ─── 未ログイン／Free：アップグレード誘導（ProjectsModalの同種の分岐と揃えたトーン） ───
  if (!session) {
    return (
      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, padding: '40px 0', textAlign: 'center' }}>
        複数プロジェクト比較を使うには、まずログインしてください。
      </div>
    );
  }
  if (!isPaid) {
    return (
      <div style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.7, marginBottom: 14 }}>
          複数プロジェクト比較はProプランの機能です。保存済みのプロジェクト同士で固有振動数・モード形状を比較できます。
        </div>
        <button onClick={onUpgradeClick} style={{
          padding: '10px 20px', fontSize: 13, fontWeight: 600,
          background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
        }}>
          Proにアップグレード
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 16px', lineHeight: 1.6 }}>
        MACはモード<b>形状</b>ベクトル同士の類似度（0〜1）を示す指標で、周波数の値は一切使っていません。
        周波数だけを見た「最近傍」の予想と、形状で見たMACの対応づけが食い違うことがあります（設計変更でモードの出現順序が入れ替わっている場合など）。
      </div>

      {/* プロジェクト選択 */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 8 }}>
          比較したいプロジェクトを2つ以上選択してください（{selectedProjects.length}件選択中・解析結果があるものだけ選択できます）
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>読み込み中...</div>
        ) : error ? (
          <div style={{ fontSize: 12, color: COLORS.danger, padding: '20px 0' }}>{error}</div>
        ) : projects.length === 0 ? (
          <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>
            まだ保存されたプロジェクトはありません。左パネルの「☁ クラウドプロジェクト」からモデルを保存してください。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 8 }}>
            {projects.map(p => {
              const hasResults = p.analysis_results?.modes?.length > 0;
              const checked = selectedIds.has(p.id);
              return (
                <label key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  background: COLORS.surface2, borderRadius: 6,
                  border: `1px solid ${checked ? COLORS.accent : 'transparent'}`,
                  cursor: hasResults ? 'pointer' : 'not-allowed', opacity: hasResults ? 1 : 0.55,
                }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!hasResults}
                    title={hasResults ? '比較対象として選択' : '解析結果が無いため比較できません（このプロジェクトを解析後、上書き保存してください）'}
                    onChange={() => {
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        return next;
                      });
                    }}
                    style={{ flexShrink: 0, cursor: hasResults ? 'pointer' : 'not-allowed' }}
                  />
                  <span style={{ fontSize: 12, color: COLORS.textBright, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {p.name}
                  </span>
                  <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', flexShrink: 0 }}>
                    {new Date(p.updated_at).toLocaleDateString('ja-JP')}
                  </span>
                  {hasResults ? (
                    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: COLORS.success + '22', color: COLORS.success, fontFamily: 'JetBrains Mono', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      解析済 {p.analysis_results.modes.length}modes
                    </span>
                  ) : (
                    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: COLORS.border, color: COLORS.textMuted, fontFamily: 'JetBrains Mono', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      未解析
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {selectedProjects.length < 2 ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
          上の一覧から、解析結果を持つプロジェクトを2つ以上選択してください。
        </div>
      ) : !targetProject ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0' }}>比較対象プロジェクトがありません。</div>
      ) : (
        <>
          {/* 基準・比較対象の選択（選択済みプロジェクトの中から） */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>基準プロジェクト</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedProjects.map(p => (
                  <button key={p.id} onClick={() => setReferenceId(p.id)} style={tabStyle(p.id === referenceId, COLORS.accent)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>比較対象プロジェクト</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {otherProjects.map(p => (
                  <button key={p.id} onClick={() => setTargetId(p.id)} style={tabStyle(p.id === targetId, COLORS.danger)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* モード一覧（左：基準／右：比較対象） */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.accent, marginBottom: 10 }}>{refN.name}</div>
              <ModeList modes={refN.modes} color={COLORS.accent} nodePositions={refN.nodePositions} bearingPos={refN.bearingPos} diskPos={refN.diskPos} />
            </div>
            <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.danger, marginBottom: 10 }}>{tgtN.name}</div>
              <ModeList modes={tgtN.modes} color={COLORS.danger} nodePositions={tgtN.nodePositions} bearingPos={tgtN.bearingPos} diskPos={tgtN.diskPos} />
            </div>
          </div>

          {/* MAC行列 */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>MAC 行列</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 10 }}>
              縦：{refN.name}のモード　横：{tgtN.name}のモード。太枠＝各行で最もMACが高い（＝最も形状が近い）セル
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(${modesB.length}, 1fr)`, gap: 6, alignItems: 'center' }}>
              <div />
              {modesB.map((mb, j) => (
                <div key={j} style={{ textAlign: 'center', fontSize: 10, color: COLORS.danger, fontFamily: 'JetBrains Mono' }}>
                  B{j + 1}<br />{mb.freq.toFixed(0)}Hz
                </div>
              ))}
              {modesA.map((ma, i) => (
                <FragmentRow key={i} i={i} ma={ma} row={macMatrix[i]} bestIdx={matches[i]?.targetIndex} />
              ))}
            </div>
          </div>

          {/* 「同じ順番」vs「MAC」比較 */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              「同じ順番」比較 vs 「MAC」比較
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 14, lineHeight: 1.6 }}>
              基準の各モードについて、MACで判定した「本当の対応」を大きく表示し、その下に「同じ順番と仮定した場合」「周波数が一番近いものを選んだ場合」を参考として添えています。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {modesA.map((ma, i) => {
                const naiveB = modesB[i];
                const match = matches[i];
                const freqB = nearestFreqIdx[i] >= 0 ? modesB[nearestFreqIdx[i]] : null;
                const macVal = match?.macValue ?? 0;
                const bestIdx = match?.targetIndex;
                const freqVsMacDisagree = nearestFreqIdx[i] !== bestIdx;
                const orderVsMacDisagree = i !== bestIdx;
                const lowConfidence = macVal < LOW_CONFIDENCE_THRESHOLD;
                const flagged = freqVsMacDisagree || orderVsMacDisagree;
                return (
                  <div key={i} style={{
                    border: `1px solid ${flagged ? COLORS.danger + '66' : COLORS.border}`,
                    background: flagged ? COLORS.danger + '0A' : COLORS.surface2,
                    borderRadius: 6, padding: '10px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700, color: COLORS.accent }}>
                        A{i + 1}（{ma.freq.toFixed(0)}Hz）
                      </span>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>→ MACによる本当の対応：</span>
                      {bestIdx != null && modesB[bestIdx] ? (
                        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 14, fontWeight: 700, color: COLORS.textBright }}>
                          B{bestIdx + 1}（{modesB[bestIdx].freq.toFixed(0)}Hz）
                        </span>
                      ) : <span style={{ fontSize: 12, color: COLORS.textMuted }}>対応なし</span>}
                      <span style={{
                        fontSize: 11, fontFamily: 'JetBrains Mono', padding: '1px 6px', borderRadius: 4,
                        background: lowConfidence ? COLORS.warning + '22' : COLORS.success + '22',
                        color: lowConfidence ? COLORS.warning : COLORS.success,
                      }}>
                        MAC {macVal.toFixed(2)}{lowConfidence ? '（低信頼）' : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 11, color: COLORS.textMuted, flexWrap: 'wrap' }}>
                      <span>
                        同じ順番の予想：B{i + 1}（{naiveB ? naiveB.freq.toFixed(0) : '—'}Hz）
                        {orderVsMacDisagree
                          ? <span style={{ color: COLORS.danger, fontWeight: 700 }}> ✗ 不一致</span>
                          : <span style={{ color: COLORS.success }}> ✓ 一致</span>}
                      </span>
                      {freqB && (
                        <span>
                          周波数最近傍の予想：B{nearestFreqIdx[i] + 1}（{freqB.freq.toFixed(0)}Hz, MAC {macMatrix[i][nearestFreqIdx[i]].toFixed(2)}）
                          {freqVsMacDisagree
                            ? <span style={{ color: COLORS.danger, fontWeight: 700 }}> ✗ 不一致</span>
                            : <span style={{ color: COLORS.success }}> ✓ 一致</span>}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 12, lineHeight: 1.6 }}>
              「周波数最近傍」は比較のためだけに別途計算したもので、MACの判定には一切使っていません。✗が付いている場合は、
              「同じ順番」または「周波数が近い」という直感的な予想が、形状で見ると誤りだったことを意味します。<br />
              ※各基準モードについてMAC最大値を単純に採用する簡易版です。複数の基準モードが同じ対象モードを指す場合（veering現象）もあり、
              1対1の最適割当（ハンガリアン法など）は今後の検討課題です。
            </div>
          </div>

          {/* 形状を実際に重ねて確認 */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textBright, marginBottom: 4 }}>
              形状を実際に重ねて確認
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
              各基準モードについて、重ねて比べたい比較対象のモードをボタンで選べます（デフォルトはMACが最も高いものを自動選択）。
              「推奨」＝MAC最良、「周波数近」＝周波数だけで見ると一番近いもの。カーブが実線とぴったり重なっていれば同じ変形パターン、
              大きくズレていれば別の変形パターンです。⌂＝軸受位置、●＝ディスク位置。
            </div>
            {modesA.map((ma, i) => (
              <ShapeCompareRow
                key={`${referenceId}-${targetId}-${i}`}
                i={i} ma={ma} modesB={modesB}
                nodePositions={nodePositions}
                bearingPos={refN.bearingPos}
                diskPos={refN.diskPos}
                recommendedIdx={matches[i]?.targetIndex ?? 0}
                nearestFreqIdxForRow={nearestFreqIdx[i]}
                macRow={macMatrix[i] || []}
                isLast={i === modesA.length - 1}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function tabStyle(active, color) {
  return {
    fontSize: 11, padding: '6px 12px', borderRadius: 6, fontWeight: active ? 700 : 400,
    background: active ? color : COLORS.surface2,
    color: active ? '#fff' : COLORS.text,
    border: `1px solid ${active ? color : COLORS.border}`,
    cursor: 'pointer',
  };
}

// モード形状をシャフトに沿ったSVG曲線として描画する。
// 複数の曲線を重ねて描けるので、「同じ形か・違う形か」を目で確認できる。
function ModeShapeSvg({ nodePositions, curves, width = 260, height = 90, bearingPos = [], diskPos = [] }) {
  if (!nodePositions || nodePositions.length === 0) return null;
  const totalLen = nodePositions[nodePositions.length - 1] || 1;
  const padX = 12, padY = 14;
  const px = x => padX + (x / totalLen) * (width - padX * 2);
  const maxAbs = Math.max(...curves.flatMap(c => c.y.map(Math.abs)), 1e-9);
  const py = v => height / 2 - (v / maxAbs) * (height / 2 - padY);
  return (
    <svg width={width} height={height} style={{ display: 'block', background: COLORS.surface, borderRadius: 4 }}>
      <line x1={padX} y1={height / 2} x2={width - padX} y2={height / 2} stroke={COLORS.border} strokeWidth={1} />
      {bearingPos.map((x, i) => (
        <rect key={`b${i}`} x={px(x) - 3} y={height / 2 - 3} width={6} height={6} fill={COLORS.warning} />
      ))}
      {diskPos.map((x, i) => (
        <circle key={`d${i}`} cx={px(x)} cy={height / 2} r={4} fill={COLORS.purple} opacity={0.5} />
      ))}
      {curves.map((c, ci) => (
        <polyline
          key={ci}
          points={nodePositions.map((x, i) => `${px(x)},${py(c.y[i] ?? 0)}`).join(' ')}
          fill="none" stroke={c.color} strokeWidth={2.2}
          strokeDasharray={c.dash || 'none'}
        />
      ))}
    </svg>
  );
}

function MacCell({ v }) {
  const alpha = Math.round(v * 220).toString(16).padStart(2, '0');
  const isHigh = v >= 0.7;
  return (
    <div style={{
      background: COLORS.accent + alpha, borderRadius: 4, padding: '8px 4px',
      textAlign: 'center', fontFamily: 'JetBrains Mono', fontSize: 12,
      fontWeight: isHigh ? 700 : 400, color: v > 0.45 ? '#fff' : COLORS.text,
      border: isHigh ? `2px solid ${COLORS.textBright}` : '2px solid transparent',
    }}>
      {v.toFixed(2)}
    </div>
  );
}

function FragmentRow({ i, ma, row, bestIdx }) {
  return (
    <>
      <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: 'JetBrains Mono' }}>
        A{i + 1}<br />{ma.freq.toFixed(0)}Hz
      </div>
      {(row || []).map((v, j) => (
        <div key={j} style={j === bestIdx ? { outline: `2px solid ${COLORS.textBright}`, borderRadius: 4 } : undefined}>
          <MacCell v={v} />
        </div>
      ))}
    </>
  );
}

function ShapeCompareRow({ i, ma, modesB, nodePositions, bearingPos, diskPos, recommendedIdx, nearestFreqIdxForRow, macRow, isLast }) {
  const [selected, setSelected] = useState(recommendedIdx);
  // ユーザーが同じ行で明示的に別のBモードを選び直すまでは、常に最新の推奨（MAC最良）を表示する
  const [userPicked, setUserPicked] = useState(false);
  useEffect(() => { setSelected(recommendedIdx); setUserPicked(false); }, [recommendedIdx]);
  const effectiveSelected = userPicked ? Math.min(selected, modesB.length - 1) : recommendedIdx;

  const yA = extractY(ma.mode);
  const selB = modesB[effectiveSelected];
  const ySel = selB ? alignSign(yA, extractY(selB.mode)) : [];

  return (
    <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: isLast ? 'none' : `1px solid ${COLORS.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 12, fontWeight: 700, color: COLORS.accent }}>
          A{i + 1}（{ma.freq.toFixed(0)}Hz）
        </span>
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>と比べる：</span>
        {modesB.map((mb, j) => {
          const isSel = j === effectiveSelected;
          const isRec = j === recommendedIdx;
          const isFreqNearest = j === nearestFreqIdxForRow;
          return (
            <button
              key={j}
              onClick={() => { setSelected(j); setUserPicked(true); }}
              style={{
                padding: '3px 8px', fontSize: 10, fontFamily: 'JetBrains Mono', borderRadius: 5,
                background: isSel ? COLORS.accent + '22' : 'transparent',
                color: isSel ? COLORS.accent : COLORS.textMuted,
                border: `1px solid ${isSel ? COLORS.accent + '88' : COLORS.border}`,
                display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, cursor: 'pointer',
              }}>
              <span>B{j + 1} {mb.freq.toFixed(0)}Hz</span>
              {(isRec || isFreqNearest) && (
                <span style={{ fontSize: 8, color: isRec ? COLORS.success : COLORS.warning }}>
                  {isRec ? '推奨' : ''}{isRec && isFreqNearest ? '・' : ''}{isFreqNearest ? '周波数近' : ''}
                </span>
              )}
            </button>
          );
        })}
        {userPicked && (
          <button
            onClick={() => setUserPicked(false)}
            style={{ padding: '3px 8px', fontSize: 10, color: COLORS.textMuted, background: 'transparent', border: `1px dashed ${COLORS.border}`, borderRadius: 5, cursor: 'pointer' }}>
            推奨に戻す
          </button>
        )}
        <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: COLORS.textMuted, marginLeft: 'auto' }}>
          MAC = <b style={{ color: COLORS.textBright }}>{(macRow[effectiveSelected] ?? 0).toFixed(2)}</b>
        </span>
      </div>
      <ModeShapeSvg
        nodePositions={nodePositions}
        curves={[{ y: yA, color: COLORS.accent }, { y: ySel, color: COLORS.danger, dash: '5,4' }]}
        bearingPos={bearingPos} diskPos={diskPos}
        width={300} height={76}
      />
    </div>
  );
}

function ModeList({ modes, color, nodePositions, bearingPos, diskPos }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {modes.map((m, i) => (
        <div key={i} style={{ background: COLORS.surface, borderRadius: 4, padding: '6px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'JetBrains Mono', fontSize: 12, marginBottom: 4 }}>
            <span style={{ color }}>Mode {i + 1}</span>
            <span style={{ color: COLORS.textBright, fontWeight: 700 }}>{m.freq.toFixed(1)} Hz</span>
          </div>
          <ModeShapeSvg
            nodePositions={nodePositions}
            curves={[{ y: extractY(m.mode), color }]}
            bearingPos={bearingPos} diskPos={diskPos}
            width={220} height={64}
          />
        </div>
      ))}
    </div>
  );
}
