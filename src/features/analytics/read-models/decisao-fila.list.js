'use strict';

/**
 * M9-D709 (3.2) — leitura da fila de decisão para o bloco "o que exige decisão" do Centro de Comando (M9-D685): os itens que esperam decisão, do mais
 * antigo ao mais novo, cada um com a idade em horas e a marca "envelhecido" (idade acima de analytics.centro.decisao_atraso_horas), mais o total e o limite
 * de envelhecimento vigente. Exige `analytics:read` e mostra só as filas cujo domínio o usuário pode ler (M9-D700: financeiro, estoque, tecnologia). O BI só lista;
 * a decisão e o link do item ficam nos módulos de origem. Só lê o schema analytics. Nenhum texto livre sai daqui.
 */
const { sequelize } = require('../../../models');
const clock = require('../metrics/clock');
const { assertPermission, has, loadDomainMap, domainPermissionOf, P } = require('../security');
const { KINDS } = require('./decisao-fila.kinds');
const { readAgedHours } = require('./decisaoFilaKpi.settings');

const MODEL = 'rm_decision_queue';
const HOUR_MS = 3600000;
const DOMAIN_OF = Object.freeze({ FIN_APPROVAL: 'FINANCE', INV_ADJUSTMENT: 'INVENTORY', RULE_APPROVAL: 'TECH_AI', NAY_PROPOSAL: 'TECH_AI' });

/** options: { limit (itens devolvidos; sem limite devolve todos), kind (uma fila só), now (instante da leitura; padrão o relógio do BI) }. ctx: { companyId, groupId, permissions }. */
async function listDecisionQueue(ctx, { limit = null, kind = null, now = clock.now() } = {}, transaction) {
  assertPermission(ctx, P.READ);
  const map = await loadDomainMap(ctx, transaction);
  const kinds = Object.keys(KINDS).filter((k) => (kind === null || k === kind) && has(ctx, domainPermissionOf(map, DOMAIN_OF[k])));
  const agedHours = await readAgedHours(ctx, transaction);
  if (!kinds.length) return { items: [], total: 0, agedHours };
  const [rows] = await sequelize.query(
    `SELECT kind, source_type, source_id::text AS source_id, title, amount::text AS amount, requested_at, requested_by::text AS requested_by, owner_role
       FROM analytics.${MODEL} WHERE company_id = :companyId AND status = 'PENDING' AND kind IN (:kinds)
      ORDER BY requested_at NULLS LAST, source_id`,
    { replacements: { companyId: ctx.companyId, kinds }, transaction }
  );
  const items = rows.map((r) => {
    const ageHours = r.requested_at ? Math.max(0, Math.floor((now.getTime() - new Date(r.requested_at).getTime()) / HOUR_MS)) : null;
    return {
      kind: r.kind, sourceType: r.source_type, sourceId: r.source_id, title: r.title, amount: r.amount, requestedAt: r.requested_at ? new Date(r.requested_at).toISOString() : null,
      requestedBy: r.requested_by, ownerRole: r.owner_role, ageHours, aged: ageHours !== null && ageHours > agedHours,
    };
  });
  return { items: Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items, total: items.length, agedHours };
}

module.exports = { listDecisionQueue };
