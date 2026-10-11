'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { sequelize, Opportunity, Proposal } = require('../../models');
const { LOST_REASONS } = require('./opportunityOutcomeReason.validator');

/**
 * M3-17 — Indicadores do painel calculados pela MESMA FONTE das listas.
 *
 * REGRA ARQUITETURAL DESTE ARQUIVO (é o requisito, não um detalhe): todos os números abaixo
 * saem de queries agregadas direto em "crm"."opportunities" e "crm"."proposals" — exatamente
 * as mesmas tabelas (e, por consequência, as mesmas policies de RLS e o mesmo filtro de
 * soft-delete) que `listOpportunities`/`listProposals` usam. NÃO existe tabela de
 * cache/snapshot/materialização por trás do painel, justamente para que o painel NUNCA possa
 * divergir da lista que o usuário vê na tela: se o número do card não bater com a lista, é
 * bug de filtro, não defasagem de sincronização.
 *
 * Por rodar dentro da transação de tenant (`req.withTenantTransaction` / SET LOCAL
 * app.company_id), o escopo por empresa é aplicado pelo próprio Postgres via RLS — este
 * service não precisa (e não deve) filtrar company_id na mão.
 *
 * Métricas:
 *  - opportunitiesByStage: contagem por stage (inclusive os terminais).
 *  - conversionRate: CLOSED_WON / total de oportunidades FECHADAS
 *    (CLOSED_WON + CLOSED_LOST + WITHDRAWN). Decisão documentada: o denominador é o total
 *    de oportunidades já DECIDIDAS — oportunidade ainda em aberto não conta nem como ganha
 *    nem como perdida, senão a taxa despencaria só por existir funil cheio.
 *  - topLostReasons: motivos de perda mais comuns, agregados sobre o ENUM do M3-12.
 *  - proposals: contagem por status + valor total das propostas aceitas.
 */

const CLOSED_LIKE_STAGES = ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN'];

function buildOpportunityWhere(filters = {}) {
  const where = {};
  if (filters.ownerUserId) where.ownerUserId = filters.ownerUserId;
  if (filters.personId) where.personId = filters.personId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.createdFrom || filters.createdTo) {
    where.createdAt = {};
    if (filters.createdFrom) where.createdAt[Op.gte] = filters.createdFrom;
    if (filters.createdTo) where.createdAt[Op.lte] = filters.createdTo;
  }
  return where;
}

async function getCrmDashboard(filters = {}, transaction) {
  const where = buildOpportunityWhere(filters);

  const byStageRows = await Opportunity.findAll({
    attributes: ['stage', [fn('COUNT', col('id')), 'total']],
    where,
    group: ['stage'],
    raw: true,
    transaction,
  });

  const opportunitiesByStage = {};
  let totalOpportunities = 0;
  for (const row of byStageRows) {
    const total = Number(row.total);
    opportunitiesByStage[row.stage] = total;
    totalOpportunities += total;
  }

  const won = opportunitiesByStage.CLOSED_WON || 0;
  const lost = opportunitiesByStage.CLOSED_LOST || 0;
  const withdrawn = opportunitiesByStage.WITHDRAWN || 0;
  const totalClosed = won + lost + withdrawn;
  const openOpportunities = totalOpportunities - totalClosed;

  const lostReasonRows = await Opportunity.findAll({
    attributes: ['lostReason', [fn('COUNT', col('id')), 'total']],
    where: { ...where, stage: 'CLOSED_LOST', lostReason: { [Op.ne]: null } },
    group: ['lost_reason'],
    order: [[literal('COUNT(id)'), 'DESC']],
    raw: true,
    transaction,
  });

  const topLostReasons = lostReasonRows.map((row) => ({
    reason: row.lostReason,
    total: Number(row.total),
    // Motivos gravados antes do enum do M3-12 (texto livre legado) aparecem com
    // `inEnum: false` — o painel pode destacá-los como "a classificar" em vez de fingir que
    // são uma categoria válida.
    inEnum: LOST_REASONS.includes(String(row.lostReason || '').toUpperCase()),
  }));

  // Propostas: mesma tabela que GET /crm/proposals lista.
  const proposalWhere = {};
  if (filters.opportunityId) proposalWhere.opportunityId = filters.opportunityId;
  const proposalRows = await Proposal.findAll({
    attributes: ['status', [fn('COUNT', col('id')), 'total'], [fn('COALESCE', fn('SUM', col('value')), 0), 'totalValue']],
    where: proposalWhere,
    group: ['status'],
    raw: true,
    transaction,
  });

  const proposalsByStatus = {};
  let totalProposals = 0;
  let acceptedProposalsValue = 0;
  for (const row of proposalRows) {
    const total = Number(row.total);
    proposalsByStatus[row.status] = total;
    totalProposals += total;
    if (row.status === 'ACCEPTED') acceptedProposalsValue = Number(row.totalValue);
  }

  // Caderno (seção 11, "Próxima ação e SLA"): "Gerente visualiza oportunidades sem atividade e
  // tempo parado por estágio." Faltava no painel — só havia contagem por stage, sem visão de
  // estagnação. "Sem atividade" = aberta e nextActionDueAt já vencido (mesmo critério já usado
  // por crmTaskOverdueJob.js). Limitado a 50 para o card não virar uma segunda listagem.
  const staleWhere = {
    ...where,
    stage: { [Op.notIn]: CLOSED_LIKE_STAGES },
    nextActionDueAt: { [Op.lt]: new Date() },
  };
  const staleCount = await Opportunity.count({ where: staleWhere, transaction });
  const staleOpportunities = await Opportunity.findAll({
    where: staleWhere,
    attributes: ['id', 'stage', 'ownerUserId', 'nextAction', 'nextActionDueAt'],
    order: [['next_action_due_at', 'ASC']],
    limit: 50,
    raw: true,
    transaction,
  });

  // "Tempo parado por estágio": para cada oportunidade ABERTA, o instante em que ela entrou no
  // stage ATUAL é o `occurred_at` do seu evento crm.opportunity.stage_changed mais recente (todo
  // stage, inclusive o inicial na criação, publica esse evento — ver opportunityEvents.service.js)
  // — não existe coluna dedicada tipo "stage_entered_at" na tabela. Quando por algum motivo não
  // há evento (dado legado pré-outbox), cai para created_at da própria oportunidade.
  const timeInStageRows = await sequelize.query(
    `
    SELECT
      o.stage AS stage,
      AVG(EXTRACT(EPOCH FROM (now() - COALESCE(last_evt.occurred_at, o.created_at))) / 86400.0) AS avg_days_in_stage,
      COUNT(*) AS total
    FROM crm.opportunities o
    LEFT JOIN LATERAL (
      SELECT occurred_at
      FROM integration.outbox_events e
      WHERE e.aggregate_id = o.id AND e.event_type = 'crm.opportunity.stage_changed'
      ORDER BY occurred_at DESC
      LIMIT 1
    ) last_evt ON true
    WHERE o.deleted_at IS NULL AND o.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN')
      ${filters.ownerUserId ? 'AND o.owner_user_id = :ownerUserId' : ''}
      ${filters.personId ? 'AND o.person_id = :personId' : ''}
      ${filters.propertyId ? 'AND o.property_id = :propertyId' : ''}
    GROUP BY o.stage
    `,
    {
      replacements: {
        ownerUserId: filters.ownerUserId,
        personId: filters.personId,
        propertyId: filters.propertyId,
      },
      type: sequelize.QueryTypes.SELECT,
      transaction,
    }
  );

  const avgTimeInStageByStageDays = {};
  for (const row of timeInStageRows) {
    avgTimeInStageByStageDays[row.stage] = {
      avgDays: Number(Number(row.avg_days_in_stage).toFixed(2)),
      total: Number(row.total),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    opportunities: {
      total: totalOpportunities,
      open: openOpportunities,
      byStage: opportunitiesByStage,
      closed: { won, lost, withdrawn, total: totalClosed },
    },
    // Arredondado em 4 casas para não propagar ruído de ponto flutuante nas telas.
    conversionRate: totalClosed === 0 ? null : Number((won / totalClosed).toFixed(4)),
    topLostReasons,
    proposals: {
      total: totalProposals,
      byStatus: proposalsByStatus,
      acceptedValue: acceptedProposalsValue,
    },
    // Caderno (seção 11): visão de estagnação para o gerente.
    staleOpportunities: {
      count: staleCount,
      items: staleOpportunities,
    },
    avgTimeInStageByStageDays,
  };
}

module.exports = { getCrmDashboard, CLOSED_LIKE_STAGES };
