// Per-finding consensus from the append-only triage log.
// Rules:
//  - latest opinion per reviewer wins (re-vote)
//  - all latest verdicts agree on TP → 'tp'
//  - all latest verdicts agree on FP → 'fp'
//  - mixed → 'split' (drawer shows everyone's reasoning)
//  - no opinions → 'pending'

export function consensusFor(opinions = []) {
  if (!opinions.length) return { status: 'pending', reviewers: [], opinions: [] };

  const latestByUser = new Map();
  for (const o of opinions) {
    const user = o.reviewer || 'unknown';
    const prev = latestByUser.get(user);
    if (!prev || String(o.ts) > String(prev.ts)) latestByUser.set(user, o);
  }
  const latest = [...latestByUser.values()];
  const verdicts = new Set(latest.map(o => o.verdict));
  let status = 'split';
  if (verdicts.size === 1) status = [...verdicts][0]; // 'tp' or 'fp'
  return { status, reviewers: latest.map(o => o.reviewer), opinions: latest, allOpinions: opinions };
}
