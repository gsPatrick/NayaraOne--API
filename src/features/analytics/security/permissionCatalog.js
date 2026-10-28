'use strict';

/**
 * M9-D700 (3.1) — catálogo das 12 permissões do BI. Fonte única: a migration de seed (9700), o guarda de permissão e as rotas
 * leem esta lista. A permissão de DETALHE por domínio não está aqui: é a do módulo de origem (mapa em
 * `analytics.abac.mapa_dominio_permissao`, ver abac.js).
 */
const ANALYTICS_PERMISSIONS = Object.freeze([
  ['analytics:read', 'Ver painéis e métricas do BI dos domínios permitidos ao usuário.', 'LOW'],
  ['analytics:read:group', 'Ver o consolidado do grupo no BI.', 'MEDIUM'],
  ['analytics:read:tech', 'Ver os indicadores técnicos globais (integrações, filas, IA).', 'MEDIUM'],
  ['analytics:drilldown', 'Abrir o detalhe de um indicador do BI.', 'MEDIUM'],
  ['analytics:export', 'Exportar dados do BI.', 'HIGH'],
  ['analytics:alert:manage', 'Definir alertas do BI.', 'MEDIUM'],
  ['analytics:alert:ack', 'Reconhecer alertas do BI.', 'LOW'],
  ['analytics:manage', 'Publicar métricas e painéis do BI.', 'HIGH'],
  ['analytics:rebuild', 'Reconstruir read models do BI.', 'HIGH'],
  ['analytics:brief:read', 'Ler os briefings executivos da NAY.', 'MEDIUM'],
  ['analytics:audit:read', 'Consultar o log de acesso do BI.', 'HIGH'],
  ['analytics:accept', 'Dar o aceite do responsável na reconciliação de indicadores.', 'HIGH'],
].map((row) => Object.freeze(row)));

const ANALYTICS_PERMISSION_CODES = Object.freeze(ANALYTICS_PERMISSIONS.map(([code]) => code));

const P = Object.freeze({
  READ: 'analytics:read',
  READ_GROUP: 'analytics:read:group',
  READ_TECH: 'analytics:read:tech',
  DRILLDOWN: 'analytics:drilldown',
  EXPORT: 'analytics:export',
  ALERT_MANAGE: 'analytics:alert:manage',
  ALERT_ACK: 'analytics:alert:ack',
  MANAGE: 'analytics:manage',
  REBUILD: 'analytics:rebuild',
  BRIEF_READ: 'analytics:brief:read',
  AUDIT_READ: 'analytics:audit:read',
  ACCEPT: 'analytics:accept',
});

module.exports = { ANALYTICS_PERMISSIONS, ANALYTICS_PERMISSION_CODES, P };
