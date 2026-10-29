'use strict';

const { SOURCE_TYPES, SEVERITIES } = require('./calendar.constants');
const { SOURCE_KINDS } = require('./sources/sources.constants');

/**
 * Parâmetros do calendário (aba Governança em /painel/configuracoes). Padrão = valor inicial do catálogo parametros.csv.
 *  - severidade_por_fonte (P9-EF-004): "FONTE=NIVEL, ..."; fonte fora da lista fica INFO.
 *  - permissao_por_fonte: permissão de módulo exigida para ver cada origem ("FONTE=perm" ou "FONTE=perm1|perm2" = qualquer uma).
 *  - janela_padrao_dias: tamanho da janela de GET /calendar sem from/to.
 *  - tamanho_pagina_padrao: pageSize quando o cliente não informa (máximo 200, do livro).
 *  - duracao_padrao_min (P9-EF-003): duração de item sem fim; lida pelo projetor (M9-D802) e por compromisso sem fim informado.
 */
const SEVERITY_KEY = 'governanca.calendario.severidade_por_fonte';
const PERMISSION_KEY = 'governanca.calendario.permissao_por_fonte';
const WINDOW_DAYS_KEY = 'governanca.calendario.janela_padrao_dias';
const PAGE_SIZE_KEY = 'governanca.calendario.tamanho_pagina_padrao';
const DURATION_KEY = 'governanca.calendario.duracao_padrao_min';
// M9-D803: prazo da garantia da obra entregue (project.warranty_started) e hora da varredura diária das fontes.
const WARRANTY_MONTHS_KEY = 'governanca.calendario.garantia_obra_meses';
const BACKFILL_HOUR_KEY = 'governanca.calendario.varredura_hora';
// M9-D803 (reabertura): permissão extra por tipo de item (`source_kind`) dentro de uma origem; ex.: GUARANTEE mistura fiança (jurídico) e garantia de obra.
const KIND_PERMISSION_KEY = 'governanca.calendario.permissao_por_tipo_origem';

const CALENDAR_SETTING_DEFAULTS = Object.freeze({
  [SEVERITY_KEY]: 'LEGAL_DEADLINE=CRITICAL, FISCAL=CRITICAL, BILLING=WARNING, GUARANTEE=WARNING',
  [PERMISSION_KEY]: 'CRM_TASK=crm:tasks:read, VISIT=crm:visits:read, LEGAL_DEADLINE=legal:read, RENEWAL=procurement:read|legal:read, '
    + 'GUARANTEE=legal:read|construction:read, BILLING=billing:read, CONSTRUCTION=construction:read, MAINTENANCE=construction:read, '
    + 'FISCAL=correspondent:fiscal, COMMITMENT=governance:calendar:read',
  [KIND_PERMISSION_KEY]: 'LEGAL_GUARANTEE=legal:read, WARRANTY_CASE=construction:read, PROJECT_WARRANTY=construction:read',
  [WINDOW_DAYS_KEY]: 30,
  [PAGE_SIZE_KEY]: 50,
  [DURATION_KEY]: 60,
  [WARRANTY_MONTHS_KEY]: 60,
  [BACKFILL_HOUR_KEY]: 6,
});

/** Divide "A=B, C=D" em pares [chave, valor]; ignora vazios e itens sem "=". */
function parsePairs(text) {
  if (typeof text !== 'string') return [];
  return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf('=');
    return at > 0 ? [part.slice(0, at).trim().toUpperCase(), part.slice(at + 1).trim()] : null;
  }).filter(Boolean);
}

/** { FONTE: 'CRITICAL' }; nível ou fonte inválidos são ignorados (a fonte fica INFO). */
function parseSeverityMap(text) {
  const map = {};
  for (const [source, level] of parsePairs(text)) {
    if (SOURCE_TYPES.includes(source) && SEVERITIES.includes(level.toUpperCase())) map[source] = level.toUpperCase();
  }
  return map;
}

/** { FONTE: ['perm1', 'perm2'] }; texto vazio ou sem nenhum par válido volta ao padrão; fonte omitida fica fechada. */
function parsePermissionMap(text) {
  const parse = (value) => {
    const map = {};
    for (const [source, perms] of parsePairs(value)) {
      const list = perms.split('|').map((p) => p.trim()).filter(Boolean);
      if (SOURCE_TYPES.includes(source) && list.length) map[source] = list;
    }
    return map;
  };
  const parsed = parse(text);
  return Object.keys(parsed).length ? parsed : parse(CALENDAR_SETTING_DEFAULTS[PERMISSION_KEY]);
}

/** { TIPO_DO_ITEM: ['perm'] }; só restringe os tipos listados (tipo fora da lista segue a regra da origem); texto vazio volta ao padrão. */
function parseKindPermissionMap(text) {
  const parse = (value) => {
    const map = {};
    for (const [kind, perms] of parsePairs(value)) {
      const list = perms.split('|').map((p) => p.trim()).filter(Boolean);
      if (SOURCE_KINDS.includes(kind) && list.length) map[kind] = list;
    }
    return map;
  };
  const parsed = parse(text);
  return Object.keys(parsed).length ? parsed : parse(CALENDAR_SETTING_DEFAULTS[KIND_PERMISSION_KEY]);
}

/** Validador do dicionário de configurações: recusa texto fora do formato "FONTE=valor". */
function validatePairs(allowedValue, label, allowedKeys = SOURCE_TYPES) {
  return (key, value) => {
    const { govError } = require('../governance.errors');
    const pairs = parsePairs(value);
    const bad = pairs.length === 0 || value.split(',').filter((p) => p.trim()).length !== pairs.length
      || pairs.some(([source, v]) => !allowedKeys.includes(source) || !allowedValue(v));
    if (bad) {
      throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve seguir o formato FONTE=${label}, separado por vírgula, com itens entre: ${allowedKeys.join(', ')}.`, { key, value });
    }
  };
}

const CALENDAR_SETTINGS_SCHEMA = {
  [SEVERITY_KEY]: { type: 'string', validate: validatePairs((v) => SEVERITIES.includes(v.toUpperCase()), 'NIVEL (INFO, WARNING ou CRITICAL)') },
  [PERMISSION_KEY]: { type: 'string', validate: validatePairs((v) => v.split('|').every((p) => /^[a-z][a-z0-9:_-]*$/i.test(p.trim()) && p.trim()), 'permissão (várias com |)') },
  [KIND_PERMISSION_KEY]: { type: 'string', validate: validatePairs((v) => v.split('|').every((p) => /^[a-z][a-z0-9:_-]*$/i.test(p.trim()) && p.trim()), 'permissão (várias com |)', SOURCE_KINDS) },
  [WINDOW_DAYS_KEY]: { type: 'integer', min: 1, max: 366 },
  [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 200 },
  [DURATION_KEY]: { type: 'integer', min: 1, max: 1440 },
  [WARRANTY_MONTHS_KEY]: { type: 'integer', min: 1, max: 600 },
  [BACKFILL_HOUR_KEY]: { type: 'integer', min: 0, max: 23 },
};

module.exports = {
  SEVERITY_KEY, PERMISSION_KEY, WINDOW_DAYS_KEY, PAGE_SIZE_KEY, DURATION_KEY, WARRANTY_MONTHS_KEY, BACKFILL_HOUR_KEY, KIND_PERMISSION_KEY, SOURCE_KINDS,
  CALENDAR_SETTING_DEFAULTS, CALENDAR_SETTINGS_SCHEMA, parsePairs, parseSeverityMap, parsePermissionMap, parseKindPermissionMap,
};
