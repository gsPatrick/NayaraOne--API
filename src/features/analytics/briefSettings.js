'use strict';

/**
 * M9-D693 / M9-D694 — parâmetros do administrador do briefing da NAY Diretoria (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura por `readBriefParams`. Padrões: Maturacao/demandas/parametros.csv.
 *
 *  analytics.brief.hora_diario            "06:30 America/Sao_Paulo": a partir de quando o briefing diário (D-1) é gerado
 *  analytics.brief.reintento_falha_min    minutos até o job tentar de novo um briefing que falhou no período (padrão 60)
 *  analytics.brief.hora_semanal           "segunda 07:00 America/Sao_Paulo": dia e hora do briefing semanal (semana anterior, segunda a domingo)
 *  analytics.brief.max_itens              "diário 7; semanal 12": limite de itens de cada tipo
 *  analytics.brief.papel                  papel cujos painéis o briefing usa como entrada (painel sem papel definido vale para todos)
 *  analytics.brief.dominios               áreas que o papel da diretoria enxerga no briefing ("Financeiro, Comercial, ...")
 *  analytics.brief.variacao_relevante_pct a partir de que variação percentual entre períodos uma métrica entra como exceção ou destaque
 *  analytics.brief.polaridade             "<métrica>=alta|baixa; ...": o que é melhor (usado para separar destaque de exceção)
 *  analytics.brief.fontes_causa           "<métrica>=<dimensão>; ...": registros de causa que a NAY pode citar (por exemplo, motivo de perda)
 *  analytics.brief.palavras_causalidade   palavras que só podem aparecer ao citar um registro de causa
 *  analytics.brief.texto_demais_areas     fechamento quando há exceções no briefing e nada mais fora do esperado
 *  analytics.brief.texto_todas_areas      fechamento quando não há exceção alguma
 */
const AppError = require('../../utils/AppError');
const { domainOfLabel, norm } = require('./briefs/brief.areas');

const KEYS = Object.freeze({
  daily: 'analytics.brief.hora_diario', weekly: 'analytics.brief.hora_semanal', max: 'analytics.brief.max_itens', role: 'analytics.brief.papel',
  domains: 'analytics.brief.dominios', relevant: 'analytics.brief.variacao_relevante_pct', polarity: 'analytics.brief.polaridade',
  causes: 'analytics.brief.fontes_causa', words: 'analytics.brief.palavras_causalidade', closingSome: 'analytics.brief.texto_demais_areas',
  closingAll: 'analytics.brief.texto_todas_areas', retryMinutes: 'analytics.brief.reintento_falha_min',
});
const DEFAULTS = Object.freeze({
  [KEYS.daily]: '06:30 America/Sao_Paulo', [KEYS.weekly]: 'segunda 07:00 America/Sao_Paulo', [KEYS.max]: 'diário 7; semanal 12', [KEYS.role]: 'Diretoria',
  [KEYS.domains]: 'Financeiro, Comercial, Imóveis, Marketing, Atendimento, Locação, Jurídico, Obras, Estoque, Correspondente',
  [KEYS.relevant]: 10,
  [KEYS.polarity]: 'fin.free_cash=alta; crm.conversion_rate=alta; crm.visits=alta; crm.proposals=alta; sup.satisfaction=alta; fin.breathing_need=baixa; fin.anomalies_open=baixa; legal.missing_documents=baixa; obra.delays=baixa; obra.waste=baixa; inv.below_minimum=baixa',
  [KEYS.causes]: 'crm.loss_reasons=motivo',
  [KEYS.words]: 'porque; devido a; causado por; por causa de; em razão de',
  [KEYS.closingSome]: 'Todas as demais áreas dentro do esperado', [KEYS.closingAll]: 'Todas as áreas dentro do esperado',
  [KEYS.retryMinutes]: 60,
});

const WEEKDAYS = Object.freeze({ domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 });
const TZ = 'America/Sao_Paulo';
const TIME = '([01]\\d|2[0-3]):([0-5]\\d)';
const DAILY_RE = new RegExp(`^${TIME}(?:\\s+${TZ})?$`, 'i');
const WEEKLY_RE = new RegExp(`^([a-z]+)(?:-feira)?\\s+${TIME}(?:\\s+${TZ})?$`, 'i');
const MAX_RE = /^di[aá]rio\s+(\d{1,3})\s*;\s*semanal\s+(\d{1,3})$/i;
const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const splitList = (text) => String(text ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);

function parseDaily(text) {
  const m = DAILY_RE.exec(String(text ?? '').trim());
  return m ? { minutes: Number(m[1]) * 60 + Number(m[2]), text: `${m[1]}:${m[2]}` } : null;
}

function parseWeekly(text) {
  const m = WEEKLY_RE.exec(norm(text));
  if (!m || WEEKDAYS[m[1]] === undefined) return null;
  return { weekday: WEEKDAYS[m[1]], minutes: Number(m[2]) * 60 + Number(m[3]), text: `${m[1]} ${m[2]}:${m[3]}` };
}

function parseMax(text) {
  const m = MAX_RE.exec(String(text ?? '').trim());
  const daily = m ? Number(m[1]) : 0;
  const weekly = m ? Number(m[2]) : 0;
  return daily >= 1 && weekly >= 1 ? { DAILY: daily, WEEKLY: weekly } : null;
}

/** "Financeiro, Locação" -> ['FINANCE', 'RENTAL']; rótulo desconhecido invalida o texto (null). */
function parseDomains(text) {
  const out = [];
  for (const label of splitList(text)) {
    const domain = domainOfLabel(label);
    if (!domain) return null;
    out.push(domain);
  }
  return out.length ? [...new Set(out)] : null;
}

function parsePairs(text, valueOk) {
  const out = new Map();
  for (const entry of splitList(text)) {
    const [code, value] = entry.split('=').map((s) => s.trim());
    if (!CODE_RE.test(code || '') || !valueOk(value || '')) return null;
    out.set(code, value);
  }
  return out.size ? out : null;
}

const parsePolarity = (text) => parsePairs(norm(text), (v) => v === 'alta' || v === 'baixa');
const parseCauses = (text) => parsePairs(text, (v) => /^[a-z][a-z0-9_]{0,39}$/.test(v));
const parseWords = (text) => {
  const list = String(text ?? '').split(';').map((s) => norm(s)).filter(Boolean);
  return list.length ? list : null;
};

const bad = (key, why) => AppError.badRequest(`O valor de "${key}" ${why}`, 'SETTING_INVALID_VALUE', { key });
const rule = (parser, why) => (key, value) => { if (parser(value) === null) throw bad(key, why); };

const BRIEF_SETTINGS_SCHEMA = {
  [KEYS.daily]: { type: 'string', validate: rule(parseDaily, 'deve ser a hora no formato HH:MM, por exemplo: 06:30 America/Sao_Paulo.') },
  [KEYS.weekly]: { type: 'string', validate: rule(parseWeekly, 'deve ser o dia da semana e a hora, por exemplo: segunda 07:00 America/Sao_Paulo.') },
  [KEYS.max]: { type: 'string', validate: rule(parseMax, 'deve ser no formato: diário 7; semanal 12 (números de 1 a 999).') },
  [KEYS.role]: { type: 'string' },
  [KEYS.domains]: { type: 'string', validate: rule(parseDomains, 'deve listar áreas conhecidas separadas por vírgula, por exemplo: Financeiro, Comercial, Locação.') },
  [KEYS.relevant]: { type: 'number', min: 0, max: 1000 },
  [KEYS.polarity]: { type: 'string', validate: rule(parsePolarity, 'deve ser no formato: fin.free_cash=alta; fin.breathing_need=baixa.') },
  [KEYS.causes]: { type: 'string', validate: rule(parseCauses, 'deve ser no formato: crm.loss_reasons=motivo (código do indicador = dimensão).') },
  [KEYS.words]: { type: 'string', validate: rule(parseWords, 'deve listar palavras separadas por ponto e vírgula.') },
  [KEYS.closingSome]: { type: 'string' },
  [KEYS.closingAll]: { type: 'string' },
  [KEYS.retryMinutes]: { type: 'integer', min: 1, max: 1440 },
};

const splitWordsText = (text) => String(text).split(';').map((w) => w.trim()).filter(Boolean).join(', ');
const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** Parâmetros vigentes da empresa; valor ausente ou inválido cai no padrão. */
async function readBriefParams(scope, transaction) {
  const { listSettingsByPrefix } = require('../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const stored = Object.fromEntries((await listSettingsByPrefix('analytics.brief.', scope, transaction)).map((r) => [r.key, r.value]));
  const pick = (key, parse) => {
    const own = present(stored[key]) ? parse(stored[key]) : null;
    return own !== null && own !== undefined ? own : parse(DEFAULTS[key]);
  };
  const relevant = Number(stored[KEYS.relevant]);
  const retry = Number(stored[KEYS.retryMinutes]);
  return {
    daily: pick(KEYS.daily, parseDaily), weekly: pick(KEYS.weekly, parseWeekly), maxItems: pick(KEYS.max, parseMax),
    role: present(stored[KEYS.role]) ? String(stored[KEYS.role]).trim() : DEFAULTS[KEYS.role], domains: pick(KEYS.domains, parseDomains),
    relevantPct: Number.isFinite(relevant) && relevant >= 0 ? relevant : DEFAULTS[KEYS.relevant], polarity: pick(KEYS.polarity, parsePolarity),
    causeSources: pick(KEYS.causes, parseCauses), causalWords: pick(KEYS.words, parseWords),
    causalWordsText: splitWordsText(present(stored[KEYS.words]) && parseWords(stored[KEYS.words]) ? stored[KEYS.words] : DEFAULTS[KEYS.words]),
    closingSome: present(stored[KEYS.closingSome]) ? String(stored[KEYS.closingSome]).trim() : DEFAULTS[KEYS.closingSome],
    closingAll: present(stored[KEYS.closingAll]) ? String(stored[KEYS.closingAll]).trim() : DEFAULTS[KEYS.closingAll],
    retryFailedMinutes: Number.isInteger(retry) && retry >= 1 && retry <= 1440 ? retry : DEFAULTS[KEYS.retryMinutes],
  };
}

module.exports = { KEYS, DEFAULTS, BRIEF_SETTINGS_SCHEMA, readBriefParams, parseDaily, parseWeekly, parseMax, parseDomains, parsePolarity, parseCauses, parseWords };
