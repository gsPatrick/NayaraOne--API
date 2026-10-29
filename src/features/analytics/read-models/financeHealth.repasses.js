'use strict';

/**
 * M9-D623 (3.3) — detalhe dos repasses ao proprietário do read model financeiro. Repasse pendente = gerado e ainda não pago (status PENDING ou
 * APPROVED), o mesmo critério de `pending_owner_repasses`. Guarda o total, a contagem, as somas por proprietário e por imóvel (ids técnicos) e, por
 * data de criação em São Paulo, a quantidade, a soma e a idade em dias corridos e em dias úteis (o helper de dias úteis do projeto, M9-D606): com
 * isso a fórmula aplica os parâmetros do administrador (dias de alerta, faixas de atraso) sem voltar ao OLTP. Dinheiro de terceiros: não reduz o
 * caixa livre, aparece só neste KPI.
 */
const { sequelize } = require('../../../models');
const { businessDaysBetween, calendarDaysBetween } = require('../metrics/period.calendar');

const SP = "AT TIME ZONE 'America/Sao_Paulo'";
const PENDING = "company_id = :companyId AND status IN ('PENDING', 'APPROVED')";
const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const asMap = (list, key) => Object.fromEntries(list.map((r) => [r[key], r.total]));

async function readOwnerRepasseDetail(companyId, asOf, transaction) {
  const r = { companyId };
  const [total] = await rows(`SELECT COALESCE(SUM(net_amount), 0)::text AS total, count(*)::int AS n FROM finance.owner_repasses WHERE ${PENDING}`, r, transaction);
  const byOwner = await rows(`SELECT owner_person_id::text AS k, SUM(net_amount)::text AS total FROM finance.owner_repasses WHERE ${PENDING} GROUP BY 1 ORDER BY 1`, r, transaction);
  const byProperty = await rows(`SELECT property_id::text AS k, SUM(net_amount)::text AS total FROM finance.owner_repasses WHERE ${PENDING} GROUP BY 1 ORDER BY 1`, r, transaction);
  const byDay = await rows(
    `SELECT (created_at ${SP})::date::text AS day, count(*)::int AS n, SUM(net_amount)::text AS total FROM finance.owner_repasses WHERE ${PENDING} GROUP BY 1 ORDER BY 1`, r, transaction);
  return {
    total: total.total, count: total.n, byOwner: asMap(byOwner, 'k'), byProperty: asMap(byProperty, 'k'),
    byAge: byDay.map((d) => ({ date: d.day, count: d.n, amount: d.total, calendarDays: Math.max(0, calendarDaysBetween(d.day, asOf)), businessDays: Math.max(0, businessDaysBetween(d.day, asOf)) })),
  };
}

module.exports = { readOwnerRepasseDetail };
