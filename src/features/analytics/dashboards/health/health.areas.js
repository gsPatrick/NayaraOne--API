'use strict';

/**
 * M9-D686 (3.2) — as áreas da Saúde Geral e os 3 KPIs principais de cada uma (padrão do parâmetro `analytics.saude.kpis_por_area`). Dado puro: a área diz quais
 * domínios de indicador (permissão do mapa da M9-D700) e qual painel de origem ela abre. O livro nomeia o painel sem dizer as áreas nem os KPIs; as oito do livro
 * (Financeiro, Comercial, Locação, Obras, Jurídico, Marketing, Atendimento, Tecnologia) mais o Correspondente, que tem painel e semáforo próprios (PD-143).
 */
const AREAS = Object.freeze([
  { key: 'FINANCE', label: 'Financeiro', domains: ['FINANCE'], href: '/painel/analytics/financeiro', kpis: ['fin.free_cash', 'fin.breathing_need', 'fin.overdue_receivables'] },
  { key: 'COMMERCIAL', label: 'Comercial', domains: ['CRM', 'PROPERTIES'], href: '/painel/analytics/crm', kpis: ['crm.opportunities_by_stage', 'crm.portfolio_without_next_action', 'crm.proposals'] },
  { key: 'RENTAL', label: 'Locação', domains: ['RENTAL'], href: '/painel/analytics/locacao', kpis: ['rent.vacancy', 'rent.delinquency', 'rent.guarantees_expiring'] },
  { key: 'CONSTRUCTION', label: 'Obras', domains: ['CONSTRUCTION'], href: '/painel/analytics/obras', kpis: ['obra.progress_vs_schedule', 'obra.projected_margin', 'obra.delays'] },
  { key: 'LEGAL', label: 'Jurídico', domains: ['LEGAL'], href: '/painel/analytics/juridico', kpis: ['legal.deadlines', 'legal.cases_by_risk', 'legal.missing_documents'] },
  { key: 'MARKETING', label: 'Marketing', domains: ['MARKETING'], href: '/painel/analytics/marketing', kpis: ['mkt.deliverability', 'mkt.opt_out', 'mkt.campaigns'] },
  { key: 'SUPPORT', label: 'Atendimento', domains: ['SUPPORT'], href: '/painel/analytics/atendimento', kpis: ['sup.sla_resolution', 'sup.satisfaction', 'sup.complaints_by_reason'] },
  { key: 'TECH', label: 'Tecnologia', domains: ['TECH_AI'], href: '/painel/analytics/tecnologia', kpis: ['tec.availability', 'tec.integration_errors', 'tec.queues_dlq'] },
  { key: 'CORRESPONDENT', label: 'Correspondente', domains: ['CORRESPONDENT'], href: '/painel/analytics/correspondente', kpis: ['cor.approval_rate_by_provider', 'cor.cases_by_stage', 'cor.commission'] },
]);

const AREA_KEYS = Object.freeze(AREAS.map((a) => a.key));
const areaOf = (key) => AREAS.find((a) => a.key === key) || null;

/** "FINANCE: a, b, c; LEGAL: d, e" -> [{ key, kpis: [códigos] }] na ordem do texto; null se o texto não for válido (área desconhecida ou repetida, lista vazia, mais de 6 KPIs). */
function parseAreaKpis(text, knownDomainOf) {
  const sections = String(text === undefined || text === null ? '' : text).split(';').map((s) => s.trim()).filter(Boolean);
  if (!sections.length) return null;
  const out = [];
  for (const section of sections) {
    const m = /^([A-Z_]+)\s*:\s*(.+)$/.exec(section);
    const area = m && areaOf(m[1]);
    if (!area || out.some((a) => a.key === area.key)) return null;
    const kpis = m[2].split(',').map((c) => c.trim());
    if (!kpis.length || kpis.length > 6 || kpis.some((c, i) => !/^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/.test(c) || kpis.indexOf(c) !== i)) return null;
    if (knownDomainOf && kpis.some((c) => !area.domains.includes(knownDomainOf(c)))) return null; // o KPI precisa ser da própria área (domínio da tabela de criticidade)
    out.push({ key: area.key, kpis });
  }
  return out;
}

const DEFAULT_AREA_KPIS = AREAS.map((a) => `${a.key}: ${a.kpis.join(', ')}`).join('; ');

module.exports = { AREAS, AREA_KEYS, areaOf, parseAreaKpis, DEFAULT_AREA_KPIS };
