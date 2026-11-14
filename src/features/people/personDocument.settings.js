'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros do cadastro por documento (CAD-05, livro §5; DI-M3PE-6). O livro fixa a ordem (upload -> antivírus -> hash -> classificação ->
 * OCR/IA -> dados sugeridos), a origem e a confiança de cada dado, a validação dos campos críticos e a pendência do ilegível. O que ele não
 * fixa é parâmetro da empresa, com o padrão = comportamento anterior do código (Maturacao/demandas/parametros.csv):
 * - `people.documentos.confianca_minima` (0,7): abaixo dela a leitura abre pendência de revisão;
 * - `people.documentos.campos_criticos`: por tipo, os campos que a leitura precisa trazer (`TIPO=campo+campo; ...`);
 * - `people.documentos.classificacao`: por tipo, as expressões que identificam o documento (`TIPO=expressão|expressão; ...`);
 * - `people.documentos.motores_laboratorio` (desligado): permite os motores de laboratório (antivírus que só reconhece o arquivo de teste
 *   EICAR e leitura simulada) fora do ambiente de teste. Desligado, sem antivírus real o envio é recusado e sem leitura real o documento
 *   fica com pendência, nunca com dado simulado.
 */
const KEYS = Object.freeze({
  CONFIDENCE: 'people.documentos.confianca_minima',
  CRITICAL: 'people.documentos.campos_criticos',
  CLASSIFICATION: 'people.documentos.classificacao',
  LAB: 'people.documentos.motores_laboratorio',
});
const CRITICAL_FIELD_NAMES = Object.freeze(['name', 'taxId', 'income', 'accountNumber', 'issuedAt', 'expiresAt']);
const DEFAULT_CRITICAL =
  'RG=name; CIN=name; CNH=name+issuedAt+expiresAt; IR=name+taxId+income; HOLERITE=name+income; BANK_STATEMENT=name+accountNumber; ' +
  'CPF=name+taxId; RG_CPF=name+taxId; CNPJ=taxId';
// Ordem importa no empate (o primeiro listado vence): CIN antes de RG, porque "carteira de identidade nacional" contém "carteira de identidade".
const DEFAULT_CLASSIFICATION =
  'CIN=carteira de identidade nacional; RG=registro geral|carteira de identidade|secretaria de seguranca publica; ' +
  'CNH=carteira nacional de habilitacao|permissao para dirigir; CPF=comprovante de inscricao no cpf|cadastro de pessoas fisicas; ' +
  'CNPJ=cadastro nacional da pessoa juridica|comprovante de inscricao e de situacao cadastral; ' +
  'IR=declaracao de ajuste anual|imposto sobre a renda da pessoa fisica; HOLERITE=holerite|contracheque|demonstrativo de pagamento|recibo de pagamento de salario; ' +
  'BANK_STATEMENT=extrato de conta|extrato bancario|saldo anterior';
const DEFAULTS = Object.freeze({ [KEYS.CONFIDENCE]: 0.7, [KEYS.CRITICAL]: DEFAULT_CRITICAL, [KEYS.CLASSIFICATION]: DEFAULT_CLASSIFICATION, [KEYS.LAB]: false });
const TYPE = /^[A-Z][A-Z0-9_]{0,39}$/;

const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** `TIPO=a+b; TIPO2=c` -> { TIPO: [a, b], TIPO2: [c] }. `sep` separa os itens de cada tipo; `check(item)` devolve o erro do item ou null. */
function parseMap(text, key, sep, check) {
  const invalid = (motivo) => AppError.badRequest(`O valor de "${key}" é inválido: ${motivo}`, 'SETTING_INVALID_VALUE', { key });
  const out = {};
  for (const part of String(text || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 1) throw invalid(`"${part}" deve ser TIPO=valores.`);
    const type = part.slice(0, eq).trim().toUpperCase();
    if (!TYPE.test(type)) throw invalid(`o tipo "${type}" deve ter só letras maiúsculas, números e _.`);
    if (out[type]) throw invalid(`o tipo ${type} aparece mais de uma vez.`);
    const items = part.slice(eq + 1).split(sep).map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw invalid(`o tipo ${type} está sem valores.`);
    for (const item of items) { const erro = check(item); if (erro) throw invalid(`${type}: ${erro}`); }
    out[type] = items;
  }
  if (!Object.keys(out).length) throw invalid('informe pelo menos um tipo.');
  return out;
}

const parseCritical = (text, key = KEYS.CRITICAL) => parseMap(text, key, '+', (f) => (CRITICAL_FIELD_NAMES.includes(f) ? null : `campo "${f}" desconhecido (use ${CRITICAL_FIELD_NAMES.join(', ')}).`));
const parseClassification = (text, key = KEYS.CLASSIFICATION) => {
  const map = parseMap(text, key, '|', (w) => (fold(w).length >= 3 && w.length <= 120 ? null : `a expressão "${w}" deve ter de 3 a 120 caracteres.`));
  return Object.fromEntries(Object.entries(map).map(([type, words]) => [type, words.map(fold)]));
};

const PEOPLE_DOCUMENT_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.CONFIDENCE]: { type: 'number', min: 0, max: 1 },
  [KEYS.CRITICAL]: { type: 'string', validate: (key, value) => { parseCritical(value, key); } },
  [KEYS.CLASSIFICATION]: { type: 'string', validate: (key, value) => { parseClassification(value, key); } },
  [KEYS.LAB]: { type: 'boolean' },
});

/** Parâmetros vigentes da empresa; valor gravado que não serve mais cai no padrão (a escrita já valida). */
async function readDocumentParams(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const read = (key) => getSetting(key, tenant, transaction, DEFAULTS[key]);
  const safe = (fn, value, fallback) => { try { return fn(value); } catch (err) { return fn(fallback); } };
  const confidence = await read(KEYS.CONFIDENCE);
  const lab = await read(KEYS.LAB);
  return {
    confiancaMinima: typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : DEFAULTS[KEYS.CONFIDENCE],
    camposCriticos: safe(parseCritical, await read(KEYS.CRITICAL), DEFAULT_CRITICAL),
    classificacao: safe(parseClassification, await read(KEYS.CLASSIFICATION), DEFAULT_CLASSIFICATION),
    motoresLaboratorio: lab === true,
  };
}

/** Parâmetros padrão (sem empresa): para quem só precisa da lista de campos críticos fora de uma requisição. */
const defaultDocumentParams = () => ({
  confiancaMinima: DEFAULTS[KEYS.CONFIDENCE], camposCriticos: parseCritical(DEFAULT_CRITICAL), classificacao: parseClassification(DEFAULT_CLASSIFICATION), motoresLaboratorio: false,
});

module.exports = { KEYS, DEFAULTS, CRITICAL_FIELD_NAMES, PEOPLE_DOCUMENT_SETTINGS_SCHEMA, parseCritical, parseClassification, readDocumentParams, defaultDocumentParams, fold };
