'use strict';

/**
 * M9-D691 (3.3) — parâmetros do administrador para o alert engine (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura por `readAlertParams`.
 *
 *  analytics.alert.cooldown_minutos            "INFO 240; WARNING 120; CRITICAL 60": silêncio depois da resolução; vale só quando a definição não tem cooldown próprio
 *  analytics.alert.avaliacoes_para_resolver    avaliações normais seguidas para resolver (a política da definição prevalece)
 *  analytics.alert.intervalo_avaliacao_min     de quantos em quantos minutos o job reavalia cada empresa
 *  analytics.alert.owner_reserva               papel que recebe o alerta semente quando a métrica não tem owner (e o reserva do owner removido, M9-D692)
 *  analytics.alert.prazo_tarefa_horas          prazo (horas) da tarefa que o alerta CRITICAL com tarefa cria (M9-D692)
 *  analytics.alert.link_painel                 caminho do painel para onde o aviso e a tarefa apontam (M9-D692)
 *  analytics.alerta_semente.<chave>            limiar, severidade e tarefa de cada alerta semente (ver seed.catalog.js)
 */
const AppError = require('../../../utils/AppError');
const { parseSeedText } = require('./seed.parse');
const { SEEDS, settingKey } = require('./seed.catalog');

const KEYS = Object.freeze({
  cooldown: 'analytics.alert.cooldown_minutos',
  toResolve: 'analytics.alert.avaliacoes_para_resolver',
  interval: 'analytics.alert.intervalo_avaliacao_min',
  ownerFallback: 'analytics.alert.owner_reserva',
  taskHours: 'analytics.alert.prazo_tarefa_horas',
  panelLink: 'analytics.alert.link_painel',
});
const SEVERITY_LEVELS = Object.freeze(['INFO', 'WARNING', 'CRITICAL']);
const DEFAULT_COOLDOWNS = Object.freeze({ INFO: 240, WARNING: 120, CRITICAL: 60 });
const DEFAULTS = Object.freeze({
  [KEYS.cooldown]: 'INFO 240; WARNING 120; CRITICAL 60', [KEYS.toResolve]: 2, [KEYS.interval]: 5, [KEYS.ownerFallback]: 'Diretoria', [KEYS.taskHours]: 24, [KEYS.panelLink]: '/painel/centro-de-comando',
  ...Object.fromEntries(SEEDS.map((s) => [settingKey(s), s.default])),
});

/** "INFO 240; WARNING 120; CRITICAL 60" -> { INFO, WARNING, CRITICAL } (o que faltar vale o padrão); null se houver nível ou minuto inválido. */
function parseCooldowns(text) {
  const out = { ...DEFAULT_COOLDOWNS };
  for (const part of String(text ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(INFO|WARNING|CRITICAL)\s+(\d{1,6})$/.exec(part);
    if (!m) return null;
    out[m[1]] = Number.parseInt(m[2], 10);
  }
  return out;
}

const bad = (key, why) => AppError.badRequest(`O valor de "${key}" ${why}`, 'SETTING_INVALID_VALUE', { key });
const validateCooldowns = (key, value) => { if (parseCooldowns(value) === null) throw bad(key, 'deve listar NÍVEL minutos separados por ponto e vírgula, por exemplo: INFO 240; WARNING 120; CRITICAL 60.'); };
const validateSeed = (key, value) => {
  if (!parseSeedText(value)) throw bad(key, 'não segue o formato: <código da métrica> [recorte] <operador> <valor>, <INFO|WARNING|CRITICAL>[ com tarefa] (por exemplo: fin.free_cash < R$ 50.000,00, WARNING).');
};
const validateFreshnessSeed = (key, value) => {
  if (!parseSeedText(value) || parseSeedText(value).kind !== 'FRESHNESS') throw bad(key, 'não segue o formato: métrica CRITICAL em STALE, <INFO|WARNING|CRITICAL>[ com tarefa].');
};

const validatePanelLink = (key, value) => { if (!/^\/[A-Za-z0-9/_-]*$/.test(String(value ?? ''))) throw bad(key, 'deve ser um caminho do painel começando por "/", por exemplo: /painel/centro-de-comando.'); };

const BI_ALERT_SETTINGS_SCHEMA = {
  [KEYS.cooldown]: { type: 'string', validate: validateCooldowns },
  [KEYS.toResolve]: { type: 'integer', min: 1, max: 100 },
  [KEYS.interval]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.ownerFallback]: { type: 'string' },
  [KEYS.taskHours]: { type: 'integer', min: 1, max: 720 },
  [KEYS.panelLink]: { type: 'string', validate: validatePanelLink },
  ...Object.fromEntries(SEEDS.map((s) => [settingKey(s), { type: 'string', validate: s.kind === 'FRESHNESS' ? validateFreshnessSeed : validateSeed }])),
};

const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/** { cooldowns, toResolve, intervalMinutes, ownerFallback, seeds: { chave: spec } } vigentes da empresa; ausente ou inválido cai no padrão. */
async function readAlertParams(scope, transaction) {
  const { listSettingsByPrefix } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const rows = [...await listSettingsByPrefix('analytics.alert.', scope, transaction), ...await listSettingsByPrefix('analytics.alerta_semente.', scope, transaction)];
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const get = (key) => (stored[key] === undefined ? DEFAULTS[key] : stored[key]);
  const owner = String(get(KEYS.ownerFallback) || '').trim();
  return {
    cooldowns: parseCooldowns(get(KEYS.cooldown)) || { ...DEFAULT_COOLDOWNS },
    toResolve: positiveInt(get(KEYS.toResolve), DEFAULTS[KEYS.toResolve]),
    intervalMinutes: positiveInt(get(KEYS.interval), DEFAULTS[KEYS.interval]),
    ownerFallback: owner || DEFAULTS[KEYS.ownerFallback],
    taskHours: positiveInt(get(KEYS.taskHours), DEFAULTS[KEYS.taskHours]),
    panelLink: /^\/[A-Za-z0-9/_-]*$/.test(String(get(KEYS.panelLink) ?? '')) ? get(KEYS.panelLink) : DEFAULTS[KEYS.panelLink],
    seeds: Object.fromEntries(SEEDS.map((s) => [s.key, parseSeedText(get(settingKey(s))) || parseSeedText(s.default)])),
  };
}

module.exports = { KEYS, DEFAULTS, SEVERITY_LEVELS, BI_ALERT_SETTINGS_SCHEMA, parseCooldowns, readAlertParams };
