'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { sequelize, Opportunity, Proposal } = require('../../models');
const { readOutcomeReasonCatalog } = require('./crm.params');
const { TERMINAL_STAGES } = require('./opportunityStages');

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
 *  - conversionRate: WON / total de oportunidades FECHADAS (WON + LOST; a desistência é LOST
 *    com motivo de desistência, livro §10). Decisão documentada: o denominador é o total
 *    de oportunidades já DECIDIDAS — oportunidade ainda em aberto não conta nem como ganha
 *    nem como perdida, senão a taxa despencaria só por existir funil cheio.
 *  - topLostReasons: motivos de perda mais comuns, agregados sobre o ENUM do M3-12.
 *  - proposals: contagem por status + valor total das propostas aceitas.
 *
 * Escopo de carteira (M3-17 + livro §18 "Corretor visualizar carteira alheia"): o painel recebe o MESMO `ownerScope` que a
 * listagem de oportunidades usa (opportunityScope.guard.js). Com escopo OWN, todo número sai só das oportunidades do próprio
 * corretor (o filtro `ownerUserId` da consulta não amplia o escopo) e as propostas contadas são as das oportunidades dele.
 */

const CLOSED_LIKE_STAGES = TERMINAL_STAGES;

function effectiveOwner(filters = {}) {
  if (filters.ownerScope && filters.ownerScope.mode === 'OWN') return filters.ownerScope.userId;
  return filters.ownerUserId || null;
}

function buildOpportunityWhere(filters = {}) {
  const where = {};
  const owner = effectiveOwner(filters);
  if (owner) where.ownerUserId = owner;
  if (filters.personId) where.personId = filters.personId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.createdFrom || filters.createdTo) {
    where.created_at = {};
    if (filters.createdFrom) where.created_at[Op.gte] = filters.createdFrom;
    if (filters.createdTo) where.created_at[Op.lte] = filters.createdTo;
  }
  return where;
}

async function getCrmDashboard(filters = {}, transaction, tenant = null) {
  const where = buildOpportunityWhere(filters);
  const owner = effectiveOwner(filters);

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

  const won = opportunitiesByStage.WON || 0;
  const lost = opportunitiesByStage.LOST || 0;
  // Desistência = perdida com motivo da categoria desistência (withdrawn_reason preenchido); já está dentro de `lost`.
  const withdrawn = await Opportunity.count({ where: { ...where, stage: 'LOST', withdrawnReason: { [Op.ne]: null } }, transaction });
  const totalClosed = won + lost;
  const openOpportunities = totalOpportunities - totalClosed;

  const lostReasonRows = await Opportunity.findAll({
    attributes: ['lostReason', [fn('COUNT', col('id')), 'total']],
    where: { ...where, stage: 'LOST', lostReason: { [Op.ne]: null } },
    group: ['lost_reason'],
    order: [[literal('COUNT(id)'), 'DESC']],
    raw: true,
    transaction,
  });

  const catalog = await readOutcomeReasonCatalog(tenant, transaction);
  const knownLostCodes = [...catalog.lost, ...catalog.withdrawal].map((r) => r.code);
  const topLostReasons = lostReasonRows.map((row) => ({
    reason: row.lostReason,
    total: Number(row.total),
    // Motivos gravados antes do enum do M3-12 (texto livre legado) aparecem com
    // `inEnum: false` — o painel pode destacá-los como "a classificar" em vez de fingir que
    // são uma categoria válida.
    inEnum: knownLostCodes.includes(String(row.lostReason || '').toUpperCase()),
  }));

  // Propostas: mesma tabela que GET /crm/proposals lista.
  const proposalWhere = {};
  if (filters.opportunityId) proposalWhere.opportunityId = filters.opportunityId;
  if (owner) {
    proposalWhere.opportunityId = {
      [Op.in]: literal(`(SELECT id FROM crm.opportunities WHERE owner_user_id = ${sequelize.escape(owner)} AND deleted_at IS NULL)`),
      ...(filters.opportunityId ? { [Op.eq]: filters.opportunityId } : {}),
    };
  }
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
    WHERE o.deleted_at IS NULL AND o.stage NOT IN (:closedStages)
      ${owner ? 'AND o.owner_user_id = :ownerUserId' : ''}
      ${filters.personId ? 'AND o.person_id = :personId' : ''}
      ${filters.propertyId ? 'AND o.property_id = :propertyId' : ''}
    GROUP BY o.stage
    `,
    {
      replacements: {
        ownerUserId: owner,
        closedStages: CLOSED_LIKE_STAGES,
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
