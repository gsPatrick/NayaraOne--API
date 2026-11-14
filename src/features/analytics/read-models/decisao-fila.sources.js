'use strict';

/**
 * M9-D709 (3.1) — leitura do ESTADO de cada fila nas tabelas de origem (somente leitura, sob o RLS da empresa da transação):
 *   FIN_APPROVAL    finance.approval_requests; valor = o do registro aprovado (lançamento, comissão, parcela de comissão ou repasse) quando tem valor;
 *   INV_ADJUSTMENT  inventory.adjustment_proposals; valor = |quantidade| × custo médio do item (sem custo médio, o valor estimado da proposta);
 *   RULE_APPROVAL   core.rule_approval_requests (a regra vem da versão da regra);
 *   NAY_PROPOSAL    ai.ai_recommendations só com `proposed_action` (recomendação informativa não é aprovação); fontes = referências do retrato da proposta.
 * O título é curto e vem de códigos (nunca de texto livre); a data da decisão, quando a fonte não a guarda, é a da última atualização.
 */
const { sequelize } = require('../../../models');
const { queueStatus } = require('./decisao-fila.status');

const TITLE_MAX = 200;
const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const text = (value) => String(value).slice(0, TITLE_MAX);

const FIN_SQL = `
  SELECT a.id, a.status AS raw_status, a.created_at AS requested_at, a.requested_by_user_id AS requested_by, a.updated_at, a.risk_level, a.related_entity_type,
         CASE a.related_entity_type
           WHEN 'FinancialEntry' THEN (SELECT e.amount FROM finance.financial_entries e WHERE e.id = a.related_entity_id AND e.company_id = a.company_id)
           WHEN 'Commission' THEN (SELECT c.total_amount FROM finance.commissions c WHERE c.id = a.related_entity_id AND c.company_id = a.company_id)
           WHEN 'CommissionInstallment' THEN (SELECT i.amount FROM finance.commission_installments i WHERE i.id = a.related_entity_id AND i.company_id = a.company_id)
           WHEN 'OwnerRepass' THEN (SELECT r.net_amount FROM finance.owner_repasses r WHERE r.id = a.related_entity_id AND r.company_id = a.company_id)
           ELSE a.amount -- M4PG: pagamento, caso de estorno e reabertura guardam o valor no próprio pedido
         END AS amount
    FROM finance.approval_requests a WHERE a.company_id = :companyId`;
const INV_SQL = `
  SELECT p.id, p.status AS raw_status, p.created_at AS requested_at, p.proposed_by_user_id AS requested_by, p.decided_at, p.updated_at, p.inventory_item_id AS item_id, p.quantity,
         p.source_location_id AS warehouse_id, p.movement_type,
         round(CASE WHEN i.average_cost IS NOT NULL THEN abs(p.quantity) * i.average_cost ELSE abs(p.estimated_value) END, 2) AS amount
    FROM inventory.adjustment_proposals p LEFT JOIN inventory.inventory_items i ON i.id = p.inventory_item_id AND i.company_id = p.company_id WHERE p.company_id = :companyId`;
const RULE_SQL = `
  SELECT r.id, r.status AS raw_status, r.created_at AS requested_at, r.requested_by_user_id AS requested_by, r.updated_at, v.rule_id
    FROM core.rule_approval_requests r LEFT JOIN core.rule_versions v ON v.id = r.rule_version_id AND v.company_id = r.company_id WHERE r.company_id = :companyId`;
const NAY_SQL = `
  SELECT a.id, a.status AS raw_status, a.created_at AS requested_at, a.created_by AS requested_by, a.decided_at, a.updated_at, a.agent_code, a.recommendation_type, a.ai_run_id AS run_id,
         (jsonb_typeof(a.proposed_action -> 'snapshot' -> 'refs') = 'array' AND jsonb_array_length(a.proposed_action -> 'snapshot' -> 'refs') > 0) AS has_sources
    FROM ai.ai_recommendations a WHERE a.company_id = :companyId AND a.proposed_action IS NOT NULL`;

const SQL = { FIN_APPROVAL: FIN_SQL, INV_ADJUSTMENT: INV_SQL, RULE_APPROVAL: RULE_SQL, NAY_PROPOSAL: NAY_SQL };
const ALIAS = { FIN_APPROVAL: 'a', INV_ADJUSTMENT: 'p', RULE_APPROVAL: 'r', NAY_PROPOSAL: 'a' };

const NONE = { approval_type: null, approval_tier: null, warehouse_id: null, reason_code: null, item_id: null, quantity: null, rule_id: null, agent_code: null, proposal_type: null, run_id: null, has_sources: null };
const FIELDS = {
  FIN_APPROVAL: (r) => ({ title: text(`Aprovação financeira: ${r.related_entity_type}`), approval_type: r.related_entity_type, approval_tier: r.risk_level }),
  INV_ADJUSTMENT: (r) => ({ title: text(`Ajuste de estoque: ${r.movement_type}`), warehouse_id: r.warehouse_id, reason_code: r.movement_type, item_id: r.item_id, quantity: r.quantity }),
  RULE_APPROVAL: (r) => ({ title: 'Publicação de regra', rule_id: r.rule_id }),
  NAY_PROPOSAL: (r) => ({ title: text(`Proposta da NAY: ${r.agent_code || 'agente'}`), agent_code: r.agent_code, proposal_type: r.recommendation_type, run_id: r.run_id, has_sources: Boolean(r.has_sources) }),
};

function toFields(kind, r, now) {
  const status = queueStatus(r.raw_status);
  return {
    ...NONE, ...FIELDS[kind](r), amount: r.amount === null || r.amount === undefined ? null : String(r.amount), requested_at: r.requested_at || null, requested_by: r.requested_by || null,
    status, decided_at: status === 'PENDING' ? null : (r.decided_at || r.updated_at || now || null),
  };
}

/** Campos do read model do item de origem `id`, ou null se a fonte não o tem (apagado). `now` é o instante da data da decisão quando a fonte não a guarda. */
async function loadSource(kind, companyId, id, transaction, now = null) {
  const list = await rows(`${SQL[kind]} AND ${ALIAS[kind]}.id = :id`, { companyId, id }, transaction);
  return list.length ? toFields(kind, list[0], now) : null;
}

const ID_QUERY = {
  FIN_APPROVAL: 'SELECT id FROM finance.approval_requests WHERE company_id = :companyId',
  INV_ADJUSTMENT: 'SELECT id FROM inventory.adjustment_proposals WHERE company_id = :companyId',
  RULE_APPROVAL: 'SELECT id FROM core.rule_approval_requests WHERE company_id = :companyId',
  NAY_PROPOSAL: 'SELECT id FROM ai.ai_recommendations WHERE company_id = :companyId AND proposed_action IS NOT NULL',
};

/** Ids da fonte da empresa (do mais antigo ao mais novo); `pendingOnly` limita aos pendentes (agenda). */
async function listSourceIds(kind, companyId, transaction, { pendingOnly = false, limit = 100000 } = {}) {
  const list = await rows(`${ID_QUERY[kind]}${pendingOnly ? " AND status = 'PENDING'" : ''} ORDER BY created_at, id LIMIT :limit`, { companyId, limit }, transaction);
  return list.map((r) => r.id);
}

module.exports = { loadSource, listSourceIds };
