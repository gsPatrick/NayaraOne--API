'use strict';

/**
 * M9-D687 (3.1) — catálogo dos 12 painéis do livro (§5 Painéis principais) mais o Centro de Comando. Códigos fixos; o seed
 * (migration 9687) publica cada um como definição GLOBAL (visível a todas as empresas), com a faixa de qualidade como PRIMEIRO
 * bloco. O conteúdo de cada painel (widgets de métrica) chega pela demanda indicada em `contentDemand`, publicando uma nova
 * versão. `p95TargetMs` é a meta de tempo do painel (M9-D698 3.5, gravada em dashboard_definitions.p95_target_ms pela migration 9741). `requiredPermission` segue o padrão de `analytics.abac.mapa_dominio_permissao` (permissão de leitura do módulo de origem).
 */
const QUALITY_BANNER = Object.freeze({ widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados' });
const ALERTS = Object.freeze({ widgetType: 'LIST_ALERTS', title: 'Alertas do painel' });
const BRIEF = Object.freeze({ widgetType: 'BRIEF', title: 'Briefing executivo' });

const DASHBOARD_CATALOG = Object.freeze([
  { code: 'health', p95TargetMs: 2500, name: 'Saúde Geral', domain: 'GENERAL', requiredPermission: 'analytics:read', contentDemand: 'M9-D686' },
  { code: 'finance', p95TargetMs: 1500, name: 'Financeiro', domain: 'FINANCE', requiredPermission: 'finance:read', contentDemand: 'M9-D626' },
  { code: 'crm', p95TargetMs: 1500, name: 'Vendas/CRM', domain: 'CRM', requiredPermission: 'crm:opportunities:read', contentDemand: 'M9-D634' },
  { code: 'rental', p95TargetMs: 1500, name: 'Locação', domain: 'RENTAL', requiredPermission: 'legal:read', contentDemand: 'M9-D643' },
  { code: 'correspondent', p95TargetMs: 1800, name: 'Correspondente', domain: 'CORRESPONDENT', requiredPermission: 'correspondent:read', contentDemand: 'M9-D662' },
  { code: 'construction', p95TargetMs: 1800, name: 'Obras', domain: 'CONSTRUCTION', requiredPermission: 'construction:read', contentDemand: 'M9-D654' },
  { code: 'inventory', p95TargetMs: 1800, name: 'Estoque/Patrimônio', domain: 'INVENTORY', requiredPermission: 'inventory:read', contentDemand: 'M9-D654' },
  { code: 'postwork', p95TargetMs: 1800, name: 'Pós-obra', domain: 'CONSTRUCTION', requiredPermission: 'construction:read', contentDemand: 'M9-D654' },
  { code: 'legal', p95TargetMs: 1800, name: 'Jurídico', domain: 'LEGAL', requiredPermission: 'legal:read', contentDemand: 'M9-D662' },
  { code: 'marketing', p95TargetMs: 1500, name: 'Marketing', domain: 'MARKETING', requiredPermission: 'marketing:attribution:read', contentDemand: 'M9-D673' },
  { code: 'support', p95TargetMs: 1500, name: 'Atendimento/Satisfação', domain: 'SUPPORT', requiredPermission: 'crm:feedback:read', contentDemand: 'M9-D673' },
  { code: 'tech', p95TargetMs: 1400, name: 'Segurança/Integrações/IA', domain: 'TECH_AI', requiredPermission: 'analytics:read:tech', contentDemand: 'M9-D682' },
  { code: 'command_center', p95TargetMs: 2500, name: 'Centro de Comando', domain: 'GENERAL', requiredPermission: 'analytics:read', contentDemand: 'M9-D685', home: true },
].map((p) => Object.freeze({ ...p, widgets: Object.freeze(p.home ? [QUALITY_BANNER, BRIEF, ALERTS] : [QUALITY_BANNER, ALERTS]) })));

const DASHBOARD_CODES = Object.freeze(DASHBOARD_CATALOG.map((p) => p.code));
// Meta provisória que o seed da migration 9687 gravou em todos os painéis; as metas do livro (p95TargetMs) entram pela migration 9741.
const SEED_P95_MS = 3000;

module.exports = { DASHBOARD_CATALOG, DASHBOARD_CODES, SEED_P95_MS };
