'use strict';

const { DEFAULT_RESTRICTED, DEFAULT_HIGH } = require('./classification.settings');

/**
 * Regras da classificação inicial automática (M9-D910 §3.2.2), puras. O nome da coluna é dividido em palavras por `_` e a regra casa PALAVRA INTEIRA: `rg` casa
 * `rg_number` e não casa `merge_flag`, `target` nem `org`. RESTRICTED: cpf, cnpj, rg, passport, bank, account, pix, password, secret, token, mfa (e `tax_id`, o
 * CPF/CNPJ do cadastro, DI-D910-2); HIGH: email, phone, birth, address, salary, income e `name` de pessoa; valores financeiros e dados contratuais são HIGH; descrição
 * pública e preço anunciado de imóvel são LOW; o resto é MEDIUM. As listas de palavras vêm dos parâmetros (padrão = as do livro).
 */
const wordsOf = (column) => String(column).toLowerCase().split('_').filter(Boolean);
const csv = (text) => text.split(',').map((word) => word.trim());
const FINANCIAL_WORDS = ['amount', 'value', 'total', 'balance', 'price', 'cost', 'fee', 'rent', 'discount', 'paid', 'interest', 'fine', 'commission', 'tax', 'installment', 'cents'];
const PUBLIC_PROPERTY_WORDS = ['description', 'title', 'asking', 'price', 'bedrooms', 'suites', 'bathrooms', 'parking', 'area', 'rooms'];
const PERSON_TABLE = /person|people|user|contact|customer|supplier|party|owner|holder|employee|worker|lead|client|broker/;
const PERSON_QUALIFIERS = ['legal', 'preferred', 'full', 'first', 'last', 'mother', 'father', 'social', 'holder', 'contact', 'customer'];

const has = (words, list) => list.some((word) => words.includes(word));
const hasPair = (words, a, b) => words.some((word, index) => word === a && words[index + 1] === b);

/** O `name` é de pessoa quando a tabela é de pessoa/contato/usuário ou a coluna traz um qualificador de pessoa (legal_name, mother_name...). */
function isPersonName(words, schema, table) {
  return words.includes('name') && (schema === 'people' || PERSON_TABLE.test(table) || has(words, PERSON_QUALIFIERS));
}

/** { classification, reason } da coluna; `lists` troca as palavras (parâmetros). */
function classify(schema, table, column, lists = {}) {
  const restricted = lists.restricted || csv(DEFAULT_RESTRICTED);
  const high = lists.high || csv(DEFAULT_HIGH);
  const words = wordsOf(column);
  if (has(words, restricted) || hasPair(words, 'tax', 'id')) return { classification: 'RESTRICTED', reason: 'palavra restrita no nome' };
  if (has(words, high.filter((word) => word !== 'name')) || (high.includes('name') && isPersonName(words, schema, table))) return { classification: 'HIGH', reason: 'dado pessoal no nome' };
  if (schema === 'real_estate' && has(words, PUBLIC_PROPERTY_WORDS)) return { classification: 'LOW', reason: 'descrição ou preço anunciado de imóvel' };
  if (schema === 'legal' || (schema === 'finance' && has(words, FINANCIAL_WORDS)) || (schema === 'correspondent' && has(words, FINANCIAL_WORDS))) return { classification: 'HIGH', reason: 'valor financeiro ou dado contratual' };
  return { classification: 'MEDIUM', reason: 'demais' };
}

const PURPOSE_BY_SCHEMA = Object.freeze({ finance: 'COBRANCA', legal: 'CONTRATO', correspondent: 'CONTRATO', crm: 'ATENDIMENTO', people: 'ATENDIMENTO', marketing: 'MARKETING', audit: 'SEGURANCA', governance: 'SEGURANCA', integration: 'SEGURANCA', core: 'SEGURANCA', analytics: 'ANALISE', ai: 'ANALISE' });
const DOMAIN_BY_SCHEMA = Object.freeze({ people: 'PESSOAS', real_estate: 'IMOVEIS', procurement: 'FORNECEDORES', crm: 'CRM', marketing: 'CRM', finance: 'FINANCEIRO', legal: 'CONTRATOS', construction: 'OBRAS', inventory: 'ESTOQUE', correspondent: 'CORRESPONDENTE' });
const FISCAL_TABLE = /fiscal|tax_|invoice|nfse|dimob/;

const purposeOf = (schema, table) => (FISCAL_TABLE.test(table) ? 'OBRIGACAO_LEGAL' : PURPOSE_BY_SCHEMA[schema] || 'OPERACAO_INTERNA');
const ownerDomainOf = (schema, table) => (FISCAL_TABLE.test(table) ? 'FISCAL' : DOMAIN_BY_SCHEMA[schema] || 'TECNOLOGIA');

/** Máscara e padrão: senha, segredo, token, MFA e chave Pix saem inteiros (FULL); CPF, CNPJ, RG, passaporte, banco e conta mostram o final (PARTIAL); o resto de HIGH é PARTIAL. */
function maskingOf(column, classification) {
  const words = wordsOf(column);
  if (has(words, ['password', 'secret', 'token', 'mfa', 'pix'])) return { masking: 'FULL', maskPattern: null };
  if (words.includes('cpf') || hasPair(words, 'tax', 'id')) return { masking: 'PARTIAL', maskPattern: '***.***.***-NN' };
  if (words.includes('cnpj')) return { masking: 'PARTIAL', maskPattern: '**.***.***/****-NN' };
  if (has(words, ['rg', 'passport', 'bank', 'account'])) return { masking: 'PARTIAL', maskPattern: '****NNNN' };
  if (classification === 'RESTRICTED') return { masking: 'FULL', maskPattern: null };
  if (classification === 'HIGH') return { masking: 'PARTIAL', maskPattern: words.includes('email') ? 'a***@dominio' : 'X***' };
  return { masking: 'NONE', maskPattern: null };
}

function exportabilityOf(schema, classification) {
  if (classification === 'RESTRICTED') return 'FORBIDDEN';
  if (classification === 'HIGH') return ['finance', 'legal', 'correspondent'].includes(schema) ? 'WITH_APPROVAL' : 'ALLOWED_MASKED';
  return 'ALLOWED';
}

const aiAllowedOf = (classification) => classification === 'LOW' || classification === 'MEDIUM';

/** Todos os atributos iniciais da coluna (menos a política de retenção, que depende da empresa). */
function attributesOf(schema, table, column, lists) {
  const { classification } = classify(schema, table, column, lists);
  return { classification, purpose: purposeOf(schema, table), ...maskingOf(column, classification), exportability: exportabilityOf(schema, classification), aiAllowed: aiAllowedOf(classification), ownerDomain: ownerDomainOf(schema, table) };
}

module.exports = { classify, attributesOf, wordsOf, purposeOf, ownerDomainOf, maskingOf, exportabilityOf };
