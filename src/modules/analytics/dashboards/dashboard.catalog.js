'use strict';

/**
 * M9-D687 (3.1) — catálogo dos 12 painéis do livro (§5 Painéis principais) mais o Centro de Comando. Códigos fixos; o seed
 * (migration 9687) publica cada um como definição GLOBAL (visível a todas as empresas), com a faixa de qualidade como PRIMEIRO
 * bloco. O conteúdo de cada painel (widgets de métrica) chega pela demanda indicada em `contentDemand`, publicando uma nova
 * versão. `requiredPermission` segue o padrão de `analytics.abac.mapa_dominio_permissao` (permissão de leitura do módulo de origem).
 */
const { SECURITY_SETTING_DEFAULTS, KEYS } = require('../security/security.settings');

const QUALITY_BANNER = Object.freeze({ widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados' });
const ALERTS = Object.freeze({ widgetType: 'LIST_ALERTS', title: 'Alertas do painel' });
const BRIEF = Object.freeze({ widgetType: 'BRIEF', title: 'Briefing executivo' });

const DASHBOARD_CATALOG = Object.freeze([
  { code: 'health', name: 'Saúde Geral', domain: 'GENERAL', requiredPermission: 'analytics:read', contentDemand: 'M9-D686' },
  { code: 'finance', name: 'Financeiro', domain: 'FINANCE', requiredPermission: 'finance:read', contentDemand: 'M9-D626' },
  { code: 'crm', name: 'Vendas/CRM', domain: 'CRM', requiredPermission: 'crm:opportunities:read', contentDemand: 'M9-D634' },
  { code: 'rental', name: 'Locação', domain: 'RENTAL', requiredPermission: 'legal:read', contentDemand: 'M9-D643' },
  { code: 'correspondent', name: 'Correspondente', domain: 'CORRESPONDENT', requiredPermission: 'correspondent:read', contentDemand: 'M9-D662' },
  { code: 'construction', name: 'Obras', domain: 'CONSTRUCTION', requiredPermission: 'construction:read', contentDemand: 'M9-D654' },
  { code: 'inventory', name: 'Estoque/Patrimônio', domain: 'INVENTORY', requiredPermission: 'inventory:read', contentDemand: 'M9-D654' },
  { code: 'postwork', name: 'Pós-obra', domain: 'CONSTRUCTION', requiredPermission: 'construction:read', contentDemand: 'M9-D654' },
  { code: 'legal', name: 'Jurídico', domain: 'LEGAL', requiredPermission: 'legal:read', contentDemand: 'M9-D662' },
  { code: 'marketing', name: 'Marketing', domain: 'MARKETING', requiredPermission: 'crm:opportunities:read', contentDemand: 'M9-D673' },
  { code: 'support', name: 'Atendimento/Satisfação', domain: 'SUPPORT', requiredPermission: 'crm:opportunities:read', contentDemand: 'M9-D673' },
  { code: 'tech', name: 'Segurança/Integrações/IA', domain: 'TECH_AI', requiredPermission: 'analytics:read:tech', contentDemand: 'M9-D682' },
  { code: 'command_center', name: 'Centro de Comando', domain: 'GENERAL', requiredPermission: 'analytics:read', contentDemand: 'M9-D685', home: true },
].map((p) => Object.freeze({ ...p, widgets: Object.freeze(p.home ? [QUALITY_BANNER, BRIEF, ALERTS] : [QUALITY_BANNER, ALERTS]) })));

const DASHBOARD_CODES = Object.freeze(DASHBOARD_CATALOG.map((p) => p.code));
const SEED_P95_MS = SECURITY_SETTING_DEFAULTS[KEYS.P95_DEFAULT_MS];

module.exports = { DASHBOARD_CATALOG, DASHBOARD_CODES, SEED_P95_MS };
