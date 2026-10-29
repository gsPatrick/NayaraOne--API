'use strict';

// Recálculo INDEPENDENTE dos KPIs da M9-D652: lê só as linhas-fonte (movimentos, casos, ações, não conformidades e contratos) por consulta direta e faz a
// conta à parte, sem passar por read model, fórmula ou registry. É o "teste de reprodução" da demanda.
const money = require('../../../src/features/analytics/metrics/formulas/money');

const one = async (env, sql, replacements) => (await env.admin.query(sql, { replacements }))[0][0];

async function waste(env, t) {
  const r = await one(env, `SELECT COALESCE(SUM(total_cost) FILTER (WHERE movement_type = 'LOSS'), 0)::text AS waste, COALESCE(SUM(total_cost) FILTER (WHERE movement_type = 'OUT'), 0)::text AS cons,
    ROUND(COALESCE(SUM(total_cost) FILTER (WHERE movement_type = 'LOSS'), 0) * 100 / NULLIF(SUM(total_cost) FILTER (WHERE movement_type = 'OUT'), 0), 2)::text AS pct,
    count(*) FILTER (WHERE movement_type = 'LOSS' AND total_cost IS NULL)::int AS "withoutCost" FROM inventory.inventory_movements WHERE company_id = :c AND project_id IS NOT NULL`, { c: t.companyId });
  return { waste: money.money(r.waste), consumption: money.money(r.cons), pct: r.pct, withoutCost: r.withoutCost };
}

async function postwork(env, t) {
  const cost = (status) => one(env, `SELECT (COALESCE((SELECT SUM(COALESCE(labor_cost, 0) + COALESCE(material_cost, 0)) FROM construction.maintenance_cases c WHERE c.company_id = :c AND c.deleted_at IS NULL AND c.project_id IS NOT NULL AND ${status}), 0)
      + COALESCE((SELECT SUM(a.cost) FROM construction.warranty_actions a JOIN construction.maintenance_cases c ON c.id = a.warranty_case_id WHERE a.company_id = :c AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.project_id IS NOT NULL AND ${status}), 0))::text AS total`, { c: t.companyId });
  const realized = (await cost("c.status = 'CLOSED'")).total;
  const planned = (await cost("c.status <> 'CLOSED'")).total;
  const revenue = (await one(env, `SELECT COALESCE(SUM(total_value), 0)::text AS total FROM legal.contracts WHERE company_id = :c AND status IN ('SIGNED', 'ACTIVE', 'SUSPENDED', 'CLOSED')
    AND construction_project_id IN (SELECT project_id FROM construction.maintenance_cases WHERE company_id = :c AND deleted_at IS NULL AND project_id IS NOT NULL)`, { c: t.companyId })).total;
  const pct = money.percent(realized, revenue).value;
  return { realized: money.money(realized), planned: money.money(planned), revenue: money.money(revenue), pct };
}

/** Ocorrências (não conformidades e casos) da empresa nos últimos `days` dias até `asOf`, no calendário de São Paulo, agrupadas por causa, equipe e material. */
async function recurrence(env, t, asOf, { days = 180, min = 2, top = 10 } = {}) {
  const NI = 'NAO_INFORMADA';
  const [ncs] = await env.admin.query(`SELECT id::text, project_id::text AS p, COALESCE(NULLIF(upper(trim(cause_code)), ''), '${NI}') AS cause, COALESCE(NULLIF(trim(team_label), ''), '${NI}') AS team,
      (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day FROM construction.nonconformities WHERE company_id = :c AND deleted_at IS NULL`, { replacements: { c: t.companyId } });
  const [cases] = await env.admin.query(`SELECT id::text, project_id::text AS p, COALESCE(NULLIF(upper(trim(root_cause_code)), ''), '${NI}') AS cause, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
      COALESCE(labor_cost, 0) + COALESCE(material_cost, 0) AS own FROM construction.maintenance_cases WHERE company_id = :c AND deleted_at IS NULL AND project_id IS NOT NULL`, { replacements: { c: t.companyId } });
  const [acts] = await env.admin.query('SELECT warranty_case_id::text AS cid, NULLIF(trim(assigned_team), \'\') AS team, NULLIF(trim(material_used), \'\') AS material, COALESCE(cost, 0) AS cost FROM construction.warranty_actions WHERE company_id = :c AND deleted_at IS NULL', { replacements: { c: t.companyId } });
  const occ = [
    ...ncs.map((n) => ({ id: n.id, p: n.p, day: n.day, cause: n.cause, teams: [n.team], materials: [NI], cost: '0' })),
    ...cases.map((k) => {
      const mine = acts.filter((a) => a.cid === k.id);
      const list = (f) => [...new Set(mine.map((a) => a[f]).filter(Boolean))].sort();
      return { id: k.id, p: k.p, day: k.day, cause: k.cause, teams: list('team').length ? list('team') : [NI], materials: list('material').length ? list('material') : [NI], cost: money.toString(money.add(k.own, money.sum(mine.map((a) => a.cost)))) };
    }),
  ].filter((o) => { const age = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${o.day}T00:00:00Z`)) / 86400000; return age >= 0 && age <= days; });
  const groups = new Map();
  const unclassified = { causa: 0, equipe: 0, material: 0 };
  for (const o of occ) {
    for (const [kind, values] of [['causa', [o.cause]], ['equipe', o.teams], ['material', o.materials]]) {
      const real = values.filter((v) => v !== NI);
      if (!real.length) { unclassified[kind] += 1; continue; }
      for (const v of real) {
        const g = groups.get(`${kind}:${v}`) || { key: `${kind}:${v}`, ids: new Set(), projects: new Set(), cost: '0' };
        g.ids.add(o.id); g.projects.add(o.p); g.cost = money.toString(money.add(g.cost, o.cost));
        groups.set(g.key, g);
      }
    }
  }
  const recurrent = [...groups.values()].filter((g) => g.ids.size >= min).sort((a, b) => b.ids.size - a.ids.size || money.cmp(b.cost, a.cost) || (a.key < b.key ? -1 : 1));
  return { count: recurrent.length, occurrences: occ.length, unclassified, ranking: recurrent.slice(0, top).map((g) => ({ key: g.key, n: g.ids.size, projects: g.projects.size, cost: money.money(g.cost) })) };
}

module.exports = { waste, postwork, recurrence };
