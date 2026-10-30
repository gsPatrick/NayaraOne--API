'use strict';

const { mktError } = require('../../../marketing.errors');

/**
 * M9-D429 regra 5 — parâmetros do preview sem dado sensível. Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread de PREVIEW_SETTINGS_SCHEMA) + getSetting. Padrões de Maturacao/demandas/parametros.csv (MKT-P052, P063, P064).
 *  - max_chars: tamanho do preview do WhatsApp (a parte do texto que aparece na notificação do celular); e-mail usa assunto e pré-cabeçalho inteiros.
 *  - termos_sensiveis: os dicionários dos quatro padrões por frase, `grupo: termo, termo; grupo: ...` (divida, saldo, restricao, saude). Termo com mais
 *    de 3 letras vale como começo de palavra (vencid -> vencida); com até 3 letras, só como palavra inteira (cid não casa cidade).
 *  - padrao_contrato: expressão regular do número de contrato do módulo Contratos (PREFIXO-ANO-SEQUÊNCIA, ex.: LOC-2026-0001; prefixos LOC, ADM,
 *    VEN, SRV e OBR de contracts.service.js).
 *  - texto_seguro: a frase que substitui a mensagem sensível (o livro: "Você tem uma atualização. Acesse o portal.").
 *  - url_descadastro: endereço do descadastro do e-mail de marketing; `{token}` é trocado pelo token assinado do destinatário ("nenhuma" = sem endereço).
 */
const MAX_CHARS_KEY = 'marketing.preview.max_chars';
const TERMS_KEY = 'marketing.preview.termos_sensiveis';
const CONTRACT_KEY = 'marketing.preview.padrao_contrato';
const SAFE_TEXT_KEY = 'marketing.preview.texto_seguro';
const UNSUBSCRIBE_KEY = 'marketing.email.url_descadastro';
const NONE = 'nenhuma';

const TERM_GROUPS = Object.freeze(['divida', 'saldo', 'restricao', 'saude']);
const DEFAULT_TERMS = 'divida: parcela, dívida, débito, atraso, vencid, multa, cobrança; saldo: saldo, extrato, limite; '
  + 'restricao: restrição, negativad, SPC, Serasa, protesto, score; saude: doença, laudo, CID, diagnóstico, tratamento, deficiência';

const PREVIEW_SETTING_DEFAULTS = Object.freeze({
  [MAX_CHARS_KEY]: 60,
  [TERMS_KEY]: DEFAULT_TERMS,
  [CONTRACT_KEY]: '\\b(?:loc|adm|ven|srv|obr)-\\d{4}-\\d{4,}\\b',
  [SAFE_TEXT_KEY]: 'Você tem uma atualização. Acesse o portal.',
  [UNSUBSCRIBE_KEY]: NONE,
});

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../../../../settings/settings.service').getSetting(...args);
const invalid = (key, esperado) => mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado });

/** "divida: parcela, multa; saldo: saldo" -> { divida: ['parcela','multa'], saldo: ['saldo'] } (minúsculas); grupo desconhecido é ignorado. */
function parseTerms(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const [name, list] = part.split(':');
    const key = (name || '').trim().toLowerCase();
    if (!TERM_GROUPS.includes(key) || list === undefined) continue;
    out[key] = [...new Set(list.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  }
  return out;
}

function validateTerms(key, value) {
  const parsed = parseTerms(value);
  const missing = TERM_GROUPS.filter((g) => !parsed[g] || parsed[g].length === 0);
  if (missing.length > 0) throw invalid(key, `os quatro grupos com ao menos um termo cada (${TERM_GROUPS.join(', ')}), no formato "grupo: termo, termo; grupo: termo"`);
}

function validateRegex(key, value) {
  const text = String(value);
  try {
    const rx = new RegExp(text, 'gi');
    if (text.length > 200 || rx.test('')) throw new Error('inválida');
  } catch { throw invalid(key, 'expressão regular válida de até 200 caracteres que não case texto vazio'); }
}

function validateUnsubscribe(key, value) {
  const text = String(value).trim();
  if (text === NONE) return;
  let url = null;
  try { url = new URL(text.replace('{token}', 'x')); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || !text.includes('{token}')) throw invalid(key, `endereço https que contenha {token} (ex.: https://site.com.br/descadastro?t={token}) ou "${NONE}"`);
}

const PREVIEW_SETTINGS_SCHEMA = {
  [MAX_CHARS_KEY]: { type: 'integer', min: 1, max: 500 },
  [TERMS_KEY]: { type: 'string', validate: validateTerms },
  [CONTRACT_KEY]: { type: 'string', validate: validateRegex },
  [SAFE_TEXT_KEY]: { type: 'string', validate: (key, value) => { if (String(value).trim().length < 10 || String(value).length > 160) throw invalid(key, 'frase de 10 a 160 caracteres'); } },
  [UNSUBSCRIBE_KEY]: { type: 'string', validate: validateUnsubscribe },
};

const DEFAULT_PARSED = parseTerms(DEFAULT_TERMS);

/** { maxChars, terms, contractPattern, safeText, unsubscribeUrl } da empresa, saneados (valor estranho volta ao padrão do livro). */
async function readPreviewConfig(tenant, transaction) {
  const [maxChars, terms, contract, safeText, unsubscribe] = await Promise.all([
    getSetting(MAX_CHARS_KEY, tenant, transaction, PREVIEW_SETTING_DEFAULTS[MAX_CHARS_KEY]),
    getSetting(TERMS_KEY, tenant, transaction, PREVIEW_SETTING_DEFAULTS[TERMS_KEY]),
    getSetting(CONTRACT_KEY, tenant, transaction, PREVIEW_SETTING_DEFAULTS[CONTRACT_KEY]),
    getSetting(SAFE_TEXT_KEY, tenant, transaction, PREVIEW_SETTING_DEFAULTS[SAFE_TEXT_KEY]),
    getSetting(UNSUBSCRIBE_KEY, tenant, transaction, PREVIEW_SETTING_DEFAULTS[UNSUBSCRIBE_KEY]),
  ]);
  const parsed = parseTerms(terms);
  const termsOk = TERM_GROUPS.every((g) => parsed[g] && parsed[g].length > 0);
  let pattern = String(contract);
  try { new RegExp(pattern, 'gi'); } catch { pattern = PREVIEW_SETTING_DEFAULTS[CONTRACT_KEY]; }
  const link = String(unsubscribe).trim();
  return {
    maxChars: Number.isInteger(Number(maxChars)) && Number(maxChars) >= 1 ? Number(maxChars) : PREVIEW_SETTING_DEFAULTS[MAX_CHARS_KEY],
    terms: termsOk ? parsed : DEFAULT_PARSED,
    contractPattern: pattern,
    safeText: String(safeText).trim() || PREVIEW_SETTING_DEFAULTS[SAFE_TEXT_KEY],
    unsubscribeUrl: link === NONE || !link ? null : link,
  };
}

module.exports = {
  MAX_CHARS_KEY, TERMS_KEY, CONTRACT_KEY, SAFE_TEXT_KEY, UNSUBSCRIBE_KEY, TERM_GROUPS, PREVIEW_SETTING_DEFAULTS, PREVIEW_SETTINGS_SCHEMA, parseTerms, readPreviewConfig,
};
