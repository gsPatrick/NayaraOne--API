'use strict';

/**
 * Repetir o agendamento de campanha SCHEDULED devolve 200 (idempotência da M9-D412): vale quando a chamada não traz nenhum dado
 * novo ou traz exatamente o que já está gravado. Qualquer diferença é edição de campanha agendada: 409 MKT_CAMPAIGN_NOT_EDITABLE.
 */
const norm = (v) => (v === undefined || v === null || v === '' ? null : v);
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
};

function carriesNoData(input) {
  return input.audiences === null && input.steps === null && Object.values(input.fields).every((v) => v === undefined);
}

/** `dates` = { startsAt, endsAt } já convertidos (Date) quando informados. */
function matchesStored(row, input, audiences, steps, dates) {
  const f = input.fields;
  const same = (given, stored) => given === undefined || norm(given) === norm(stored);
  if (!same(f.code, row.code) || !same(f.name, row.name) || !same(f.objective, row.objective) || !same(f.objectiveMetric, row.objective_metric)) return false;
  if (!same(f.budgetJustification, row.budget_justification) || !same(f.ownerUserId, row.owner_user_id)) return false;
  if (f.targetValue !== undefined && Number(f.targetValue) !== Number(row.target_value)) return false;
  if (f.budgetAmount !== undefined && Number(f.budgetAmount) !== Number(row.budget_amount)) return false;
  if (f.channels !== undefined && stable([...f.channels].sort()) !== stable([...(row.channels || [])].sort())) return false;
  if (dates.startsAt && dates.startsAt.getTime() !== new Date(row.starts_at).getTime()) return false;
  if (dates.endsAt && dates.endsAt.getTime() !== new Date(row.ends_at).getTime()) return false;
  if (input.audiences !== null) {
    const given = input.audiences.map((a) => stable({ kind: a.kind, purpose: a.purpose, filter: a.filter }));
    const stored = audiences.map((a) => stable({ kind: a.kind, purpose: a.purpose, filter: a.filter_json }));
    if (given.length !== stored.length || given.some((g, i) => g !== stored[i])) return false;
  }
  if (input.steps !== null) {
    const given = input.steps.map((s) => stable({ c: s.channel, t: s.templateId, i: s.contentItemId, o: s.offsetMinutes }));
    const stored = steps.map((s) => stable({ c: s.channel, t: s.template_id, i: s.content_item_id, o: s.offset_minutes }));
    if (given.length !== stored.length || given.some((g, i) => g !== stored[i])) return false;
  }
  return true;
}

module.exports = { carriesNoData, matchesStored };
