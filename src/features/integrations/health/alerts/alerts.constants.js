'use strict';

/**
 * Os seis alertas operacionais das integrações (M9-D224 3.3). O livro lista quatro (indisponibilidade, aumento de erro, credencial
 * expirando e sync parado); AUTH_FAILURE decorre de INT-006 (credencial recusada vira incidente) e QUOTA_LOW de INT-008 (cota monitorada).
 */
const ALERT_TYPES = Object.freeze(['PROVIDER_DOWN', 'ERROR_RATE_UP', 'AUTH_FAILURE', 'SECRET_EXPIRING', 'SYNC_STALLED', 'QUOTA_LOW']);
const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Nome do alerta para o texto da notificação (português). */
const ALERT_LABELS = Object.freeze({
  PROVIDER_DOWN: 'Fornecedor fora do ar',
  ERROR_RATE_UP: 'Aumento de erros do fornecedor',
  AUTH_FAILURE: 'Credencial do fornecedor recusada',
  SECRET_EXPIRING: 'Credencial do fornecedor perto de vencer',
  SYNC_STALLED: 'Sincronização parada',
  QUOTA_LOW: 'Cota do fornecedor baixa',
});

/** Quando a condição some: resolvida (avisa a recuperação), substituída por marco mais urgente ou connection que saiu de cena (sem aviso). */
const RESOLUTIONS = Object.freeze({ CLEARED: 'CONDITION_CLEARED', SUPERSEDED: 'SUPERSEDED', CONNECTION_CHANGED: 'CONNECTION_CHANGED' });

/** Estados da connection que ainda são avaliados (uma connection pausada ou desativada não é para estar funcionando). */
const EVALUATED_STATUSES = Object.freeze(['ACTIVE', 'AUTH_FAILED']);

module.exports = { ALERT_TYPES, SEVERITIES, ALERT_LABELS, RESOLUTIONS, EVALUATED_STATUSES };
