'use strict';

/** Catálogos fechados da campanha (iguais aos CHECKs de marketing.campaigns, campaign_audiences e campaign_steps; migrations 750 e 754). */
const CAMPAIGN_MANAGE_PERMISSION = 'marketing:campaign:manage';
const STATUSES = Object.freeze(['DRAFT', 'SCHEDULED', 'RUNNING', 'ENDED']);
/** Métricas-alvo e o tipo de evento de atribuição que cada uma conta (REVIEWS e AWARENESS deixaram de ser métrica: M9-D400). */
const EVENT_BY_METRIC = Object.freeze({ LEADS: 'LEAD_CREATED', VISITS: 'VISIT', PROPOSALS: 'PROPOSAL', SALES: 'SALE' });
const METRICS = Object.freeze(Object.keys(EVENT_BY_METRIC));
const AUDIENCE_KINDS = Object.freeze(['SEGMENT', 'PERSON_LIST', 'RADAR_MATCH']);
const CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL']);
const STEP_STATUSES = Object.freeze(['PLANNED', 'SCHEDULED', 'SENT', 'SKIPPED', 'CANCELLED']);
/** Conteúdo cujo status permite entrar em um step (a aprovação em si é conferida pelo approved_hash). */
const STEP_CONTENT_STATUSES = Object.freeze(['APPROVED', 'SCHEDULED', 'PUBLISHED']);

/** Itens de MKT-009 exigidos para agendar, com o rótulo mostrado na mensagem 422. */
const ITEM_LABELS = Object.freeze({
  objectiveMetric: 'métrica do objetivo',
  targetValue: 'meta maior que zero',
  budgetAmount: 'orçamento',
  budgetJustification: 'justificativa do orçamento zerado',
  audiences: 'público (ao menos uma audiência)',
  steps: 'etapas (ao menos um step)',
  startsAt: 'início no futuro',
  endsAt: 'fim depois do início',
  ownerUserId: 'responsável',
});

module.exports = {
  CAMPAIGN_MANAGE_PERMISSION, STATUSES, EVENT_BY_METRIC, METRICS, AUDIENCE_KINDS, CHANNELS, STEP_STATUSES, STEP_CONTENT_STATUSES, ITEM_LABELS,
};
