'use strict';

/**
 * Parâmetros da aplicação do registro de classificação em execução (M9-D915; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dlp.mascara.texto_total: o texto da máscara total (FULL), "••••••" no livro.
 *  - governanca.ia.agentes_claro: lista FECHADA de códigos de agente que podem receber em claro campo LOW ou MEDIUM com ai_allowed (padrão NENHUM: ninguém).
 *  - governanca.dlp.view.tabelas: tabela(s) do registro de cada tipo de recurso das rotas com política de VIEW, "tipo: schema.tabela, schema.tabela; outro.tipo: ...".
 *    A tela e a API mascaram os campos HIGH e RESTRICTED dessas tabelas conforme o registro (M9-D915 §3.2), além dos listados em `governanca.dlp.view.campos`.
 */
const MASK_TEXT_KEY = 'governanca.dlp.mascara.texto_total';
const AGENTS_CLEAR_KEY = 'governanca.ia.agentes_claro';
const VIEW_TABLES_KEY = 'governanca.dlp.view.tabelas';

/** O parâmetro de texto não aceita valor vazio: NENHUM é a lista vazia (padrão do livro, ninguém recebe em claro). */
const NONE_AGENTS = 'NENHUM';

const FIELD_ACCESS_SETTING_DEFAULTS = Object.freeze({
  [MASK_TEXT_KEY]: '••••••',
  [AGENTS_CLEAR_KEY]: NONE_AGENTS,
  [VIEW_TABLES_KEY]: [
    'people.person: people.persons',
    'properties.property: real_estate.properties',
    'procurement.supplier: people.persons',
    'legal.contract: legal.contracts',
    'finance.bank_account: finance.bank_accounts',
    'files.file: people.files',
  ].join('; '),
});

const AGENT_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const TABLE_REF = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const TYPE_NAME = /^[a-z][a-z0-9_.-]{0,79}$/;

/** "NAY_COBRANCA, nay_x" -> ['NAY_COBRANCA','NAY_X']; item fora do formato é ignorado; vazio é a lista vazia (ninguém recebe em claro). */
const parseAgents = (text) => [...new Set(String(typeof text === 'string' ? text : '').split(',').map((v) => v.trim().toUpperCase())
.filter((v) => AGENT_CODE.test(v) && v !== NONE_AGENTS))];

/** "tipo: a.b, c.d; tipo2: e.f" -> { tipo: ['a.b','c.d'] }; null se algum item estiver fora do formato. */
function parseTables(text) {
  const out = {};
  for (const block of String(typeof text === 'string' ? text : '').split(';').map((b) => b.trim()).filter(Boolean)) {
    const at = block.indexOf(':');
    if (at < 1) return null;
    const type = block.slice(0, at).trim();
    const tables = block.slice(at + 1).split(',').map((t) => t.trim()).filter(Boolean);
    if (!TYPE_NAME.test(type) || !tables.length || tables.some((t) => !TABLE_REF.test(t))) return null;
    out[type] = tables;
  }
  return out;
}

function invalid(key, value, what) {
  const { govError } = require('../governance.errors');
  throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" ${what}`, { key, value });
}

const FIELD_ACCESS_SETTINGS_SCHEMA = {
  [MASK_TEXT_KEY]: { type: 'string', validate: (key, value) => { if (!String(value).trim() || String(value).length > 40) invalid(key, value, 'deve ter de 1 a 40 caracteres.'); } },
  [AGENTS_CLEAR_KEY]: {
    type: 'string',
    validate: (key, value) => {
      const items = String(value).split(',').map((v) => v.trim()).filter(Boolean);
      if (items.some((v) => !AGENT_CODE.test(v.toUpperCase()))) invalid(key, value, 'deve listar códigos de agente (letras, números e _) separados por vírgula.');
    },
  },
  [VIEW_TABLES_KEY]: { type: 'string', validate: (key, value) => { if (!parseTables(value)) invalid(key, value, 'deve seguir o formato "tipo: schema.tabela, schema.tabela; outro.tipo: schema.tabela".'); } },
};

const maskTextOf = (value) => (typeof value === 'string' && value.trim() && value.length <= 40 ? value : FIELD_ACCESS_SETTING_DEFAULTS[MASK_TEXT_KEY]);
const tablesOf = (value) => parseTables(value) || parseTables(FIELD_ACCESS_SETTING_DEFAULTS[VIEW_TABLES_KEY]);

module.exports = { MASK_TEXT_KEY, AGENTS_CLEAR_KEY, VIEW_TABLES_KEY, FIELD_ACCESS_SETTING_DEFAULTS, FIELD_ACCESS_SETTINGS_SCHEMA, parseAgents, parseTables, maskTextOf, tablesOf };
