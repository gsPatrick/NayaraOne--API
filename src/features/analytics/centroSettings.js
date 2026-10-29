'use strict';

/**
 * M9-D685 — parâmetros do administrador do Centro de Comando (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.centro.max_itens_por_bloco          quantos itens cada um dos 6 blocos mostra (os demais ficam atrás de "Ver todos"); padrão 5
 *   analytics.centro.relevancia_pct               variação mínima (em %) de um KPI crítico contra a janela anterior para entrar em "o que aconteceu"; padrão 10
 *   analytics.centro.margem_minima_pct            obra com margem projetada abaixo disto entra em "onde há risco"; padrão 10
 *   analytics.centro.dinheiro_parado_componentes  fórmula do dinheiro parado e do perdido: "PARADO: <códigos somados por +>; PERDIDO: <códigos somados por +>"
 *   analytics.centro.papeis_diretoria             papéis cujo alerta reconhecido e ainda sem resolução "exige decisão" da diretoria (separados por vírgula)
 * `analytics.centro.opp_parada_dias` (dias da oportunidade parada, M9-D616) e `analytics.centro.janela_horas` (janela do bloco 1, M9-D710) têm dono em outras demandas e são lidos aqui pelas leituras delas. Arquivo sem
 * dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const KEYS = Object.freeze({
  maxItems: 'analytics.centro.max_itens_por_bloco',
  relevancePct: 'analytics.centro.relevancia_pct',
  minMarginPct: 'analytics.centro.margem_minima_pct',
  moneyComponents: 'analytics.centro.dinheiro_parado_componentes',
  directorRoles: 'analytics.centro.papeis_diretoria',
});

const DEFAULT_COMPONENTS = 'PARADO: fin.overdue_receivables + obra.measurements pendentes + cor.commission confirmada a receber + fin.owner_repasses_pending vencidos (à parte); PERDIDO: inv.losses + obra.waste + obra.postwork_cost';

const CENTRO_DEFAULTS = Object.freeze({
  [KEYS.maxItems]: 5,
  [KEYS.relevancePct]: 10,
  [KEYS.minMarginPct]: 10,
  [KEYS.moneyComponents]: DEFAULT_COMPONENTS,
  [KEYS.directorRoles]: 'Diretoria',
});

/** Componentes que a fórmula conhece: grupo, dimensão lida (nula = o valor do indicador) e rótulo. `apart` = dinheiro de terceiros: nunca entra na soma (BI-005). */
const COMPONENTS = Object.freeze({
  'fin.overdue_receivables': { group: 'PARADO', dimension: null, label: 'Recebíveis vencidos' },
  'obra.measurements': { group: 'PARADO', dimension: 'pendente_brl', label: 'Medições pendentes de aprovação' },
  'cor.commission': { group: 'PARADO', dimension: 'a_receber_brl', label: 'Comissão confirmada ainda não recebida' },
  'fin.owner_repasses_pending': { group: 'PARADO', dimension: 'vencidos_alerta_brl', label: 'Repasses a proprietários vencidos (dinheiro de terceiros)', apart: true },
  'inv.losses': { group: 'PERDIDO', dimension: null, label: 'Perdas de estoque' },
  'obra.waste': { group: 'PERDIDO', dimension: null, label: 'Desperdício em obras' },
  'obra.postwork_cost': { group: 'PERDIDO', dimension: null, label: 'Custo de pós-obra' },
});

/** Texto da fórmula -> [{ code, group, apart }] na ordem do texto; null se houver código desconhecido, no grupo errado, repetido ou sem nenhum PARADO ou PERDIDO. */
function parseComponents(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  const sections = raw.split(';').map((s) => s.trim()).filter(Boolean);
  if (sections.length !== 2) return null;
  const out = [];
  for (const section of sections) {
    const m = /^(PARADO|PERDIDO)\s*:\s*(.+)$/i.exec(section);
    if (!m) return null;
    const group = m[1].toUpperCase();
    for (const part of m[2].split('+')) {
      const code = (/[a-z]+\.[a-z0-9_]+/.exec(part) || [])[0];
      const known = code && COMPONENTS[code];
      if (!known || known.group !== group || out.some((c) => c.code === code)) return null;
      out.push({ code, group, apart: known.apart === true || /[àa]\s+parte/i.test(part) });
    }
  }
  const groups = new Set(out.map((c) => c.group));
  return groups.has('PARADO') && groups.has('PERDIDO') ? out : null;
}

function validateComponents(key, value) {
  if (parseComponents(value) === null) {
    const AppError = require('../../utils/AppError');
    throw AppError.badRequest(
      `O valor de "${key}" deve ter o formato "PARADO: código + código; PERDIDO: código + código", com os códigos ${Object.keys(COMPONENTS).join(', ')} nos grupos certos.`,
      'SETTING_INVALID_VALUE', { key, value }
    );
  }
}

const CENTRO_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.maxItems]: { type: 'integer', min: 1, max: 50 },
  [KEYS.relevancePct]: { type: 'integer', min: 0, max: 1000 },
  [KEYS.minMarginPct]: { type: 'integer', min: -100, max: 100 },
  [KEYS.moneyComponents]: { type: 'string', validate: validateComponents },
  [KEYS.directorRoles]: { type: 'string' },
});

const intOr = (value, key, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : CENTRO_DEFAULTS[key];
};

/** { maxItems, relevancePct, minMarginPct, components, directorRoles, stalledDays, windowHours } vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readCentroParams(scope, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const { readComercialParams } = require('./read-models/comercial.settings');
  const { readWindowHours } = require('./read-models/commandEvents.settings');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, CENTRO_DEFAULTS[key]);
  const [maxItems, relevance, margin, components, roles, comercial, windowHours] = await Promise.all([
    get(KEYS.maxItems), get(KEYS.relevancePct), get(KEYS.minMarginPct), get(KEYS.moneyComponents), get(KEYS.directorRoles), readComercialParams(scope, transaction),
    readWindowHours(scope, transaction),
  ]);
  const rolesText = typeof roles === 'string' && roles.trim() ? roles : CENTRO_DEFAULTS[KEYS.directorRoles];
  return {
    maxItems: intOr(maxItems, KEYS.maxItems, 1, 50),
    relevancePct: intOr(relevance, KEYS.relevancePct, 0, 1000),
    minMarginPct: intOr(margin, KEYS.minMarginPct, -100, 100),
    components: parseComponents(components) || parseComponents(DEFAULT_COMPONENTS),
    directorRoles: rolesText.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean),
    stalledDays: comercial.stalledDays,
    windowHours,
  };
}

module.exports = { KEYS, CENTRO_DEFAULTS, CENTRO_SETTINGS_SCHEMA, COMPONENTS, parseComponents, readCentroParams };
