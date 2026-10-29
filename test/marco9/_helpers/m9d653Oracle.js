'use strict';

// Recálculo INDEPENDENTE dos KPIs da M9-D653: lê só as linhas-fonte do Estoque por consulta direta e faz a conta à parte, sem read model, fórmula nem registry.
const one = async (env, sql, replacements) => (await env.admin.query(sql, { replacements }))[0][0];

async function stock(env, t) {
  const items = "i.company_id = :c AND i.deleted_at IS NULL AND i.status = 'ACTIVE' AND i.item_type = 'CONSUMABLE'";
  const value = await one(env, `SELECT ROUND(COALESCE(SUM(b.quantity_on_hand * COALESCE(i.average_cost, 0)), 0), 2)::text AS v FROM inventory.stock_balances b JOIN inventory.inventory_items i ON i.id = b.inventory_item_id WHERE b.company_id = :c AND ${items}`, { c: t.companyId });
  const counts = await one(env, `WITH x AS (SELECT i.minimum_quantity AS m, COALESCE((SELECT SUM(b.quantity_on_hand) FROM inventory.stock_balances b WHERE b.inventory_item_id = i.id), 0) AS q, i.average_cost AS cost FROM inventory.inventory_items i WHERE ${items})
    SELECT count(*) FILTER (WHERE m IS NOT NULL AND q < m)::int AS below, count(*) FILTER (WHERE m IS NOT NULL AND m > 0 AND q <= 0)::int AS ruptures, count(*) FILTER (WHERE m IS NULL)::int AS "noMin", count(*) FILTER (WHERE q > 0 AND cost IS NULL)::int AS "noCost" FROM x`, { c: t.companyId });
  return { value: value.v, ...counts };
}

async function losses(env, t, asOf, days = 30) {
  const r = await one(env, `WITH d AS (SELECT COALESCE(mv.total_cost, lc.estimated_cost) AS v FROM inventory.loss_cases lc LEFT JOIN inventory.inventory_movements mv ON mv.id = lc.resulting_movement_id
      WHERE lc.company_id = :c AND lc.status = 'APPROVED' AND (lc.decided_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN CAST(:d AS date) - (:days - 1) AND CAST(:d AS date))
    SELECT COALESCE(SUM(v), 0)::text AS total, count(*)::int AS n, count(*) FILTER (WHERE v IS NULL)::int AS "noValue", (SELECT count(*)::int FROM inventory.loss_cases WHERE company_id = :c AND status = 'OPEN') AS open FROM d`, { c: t.companyId, d: asOf, days });
  return { total: r.total, n: r.n, noValue: r.noValue, open: r.open };
}

async function tools(env, t, asOf) {
  return one(env, `SELECT (count(*) FILTER (WHERE due_at < CAST(:d AS date)))::int AS overdue, count(*)::int AS open, (count(*) FILTER (WHERE due_at IS NULL))::int AS "noDue",
    (SELECT count(DISTINCT asset_id)::int FROM inventory.maintenance_orders WHERE company_id = :c AND status = 'OPEN') AS maintenance FROM inventory.tool_loans WHERE company_id = :c AND status IN ('OPEN', 'OVERDUE')`, { c: t.companyId, d: asOf });
}

module.exports = { stock, losses, tools };
