'use strict';

const AppError = require('../../../utils/AppError');
const { mktForbidden } = require('../marketing.errors');

/**
 * M9-D403 — Parâmetros dos campos publicáveis (Marketing). Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread de PUBLIC_FIELDS_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction, padrão).
 * Padrão = valor inicial de Maturacao/demandas/parametros.csv (MKT-P025 e MKT-P065).
 *
 * allowlist: único lugar que classifica um campo como publicável (MKT-002). Só entram nomes do catálogo de campos que as visões
 * públicas sabem produzir (PUBLIC_FIELD_CATALOG); um nome fora do catálogo é recusado (400). Incluir campo exige a permissão
 * marketing:template:manage (403 MKT_FORBIDDEN); remover é sempre permitido. A auditoria antes/depois é a do upsertSetting.
 */
const PUBLIC_FIELDS_ALLOWLIST_KEY = 'marketing.public_fields.allowlist';
const PUBLIC_FIELDS_FEATURES_KEY = 'marketing.public_fields.features_permitidas';
const TEMPLATE_MANAGE_PERMISSION = 'marketing:template:manage';

/** Catálogo = lista do livro (M9-D403 §3) + enderecoPublico (derivado da política de endereço) + os campos da obra + os textos do conteúdo (DI-410). */
const PUBLIC_FIELD_CATALOG = Object.freeze([
  'publicId', 'tipo', 'finalidade', 'bairro', 'cidade', 'uf', 'quartos', 'suites', 'banheiros', 'vagas', 'areaUtilM2',
  'areaTotalM2', 'precoVenda', 'precoLocacao', 'precoAnterior', 'condominio', 'iptu', 'features', 'fotosAutorizadas',
  'logradouro', 'numeroEndereco', 'publicadoEm', 'enderecoPublico', 'nomeEmpreendimento', 'etapaPublica',
  // Campos de texto do próprio conteúdo gerado (nunca vêm das visões públicas); passam pela varredura de dados pessoais.
  'titulo', 'texto', 'legenda', 'descricao', 'assunto', 'corpo',
]);

const FEATURE_CATALOG = Object.freeze([
  'piscina', 'churrasqueira', 'varanda', 'elevador', 'academia', 'playground', 'salão de festas', 'portaria 24h',
  'ar-condicionado', 'mobiliado', 'aceita pets', 'vaga coberta',
]);

const PUBLIC_FIELDS_DEFAULTS = Object.freeze({
  [PUBLIC_FIELDS_ALLOWLIST_KEY]: PUBLIC_FIELD_CATALOG.join(', '),
  [PUBLIC_FIELDS_FEATURES_KEY]: FEATURE_CATALOG.join(', '),
});

/** "a, b ,,c" -> ['a','b','c'] (sem vazios nem repetidos, ordem preservada). */
function parseList(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function makeListValidator(catalog, label) {
  return (key, value) => {
    const unknown = parseList(value).filter((item) => !catalog.includes(item));
    if (unknown.length > 0) {
      throw AppError.badRequest(
        `O valor de "${key}" tem ${label} desconhecido(s): ${unknown.join(', ')}.`,
        'SETTING_INVALID_VALUE',
        { key, unknown }
      );
    }
    if (parseList(value).length === 0) {
      throw AppError.badRequest(`O valor de "${key}" deve ter ao menos um item.`, 'SETTING_INVALID_VALUE', { key });
    }
  };
}

const PUBLIC_FIELDS_SETTINGS_SCHEMA = {
  [PUBLIC_FIELDS_ALLOWLIST_KEY]: { type: 'string', validate: makeListValidator(PUBLIC_FIELD_CATALOG, 'campo(s)') },
  [PUBLIC_FIELDS_FEATURES_KEY]: { type: 'string', validate: makeListValidator(FEATURE_CATALOG, 'característica(s)') },
};

function isPublicFieldsKey(key) {
  return key === PUBLIC_FIELDS_ALLOWLIST_KEY || key === PUBLIC_FIELDS_FEATURES_KEY;
}

/**
 * Regra de alteração (M9-D403 §3): incluir item na lista exige marketing:template:manage; só remover é sempre permitido.
 * `current` é o valor vigente (o da empresa ou o padrão). Devolve os itens incluídos.
 */
function assertPublicFieldsChangeAllowed({ key, value, current, permissions }) {
  const before = new Set(parseList(current));
  const added = parseList(value).filter((item) => !before.has(item));
  if (added.length > 0 && !(permissions || []).includes(TEMPLATE_MANAGE_PERMISSION)) {
    throw mktForbidden({ required: TEMPLATE_MANAGE_PERMISSION, key, added });
  }
  return added;
}

/** Middleware do PUT /settings/:key: só age nas duas chaves desta demanda; lê o valor vigente na transação da empresa. */
async function requireTemplateManageToAddPublicFields(req, res, next) {
  try {
    if (!isPublicFieldsKey(req.params.key)) return next();
    const { getSetting } = require('../../../features/settings/settings.service');
    const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
    const current = await req.withTenantTransaction((t) =>
      getSetting(req.params.key, tenant, t, PUBLIC_FIELDS_DEFAULTS[req.params.key])
    );
    assertPublicFieldsChangeAllowed({ key: req.params.key, value: req.body && req.body.value, current, permissions: req.auth.permissions });
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Lê a configuração vigente da empresa (allowlist e características permitidas), com o padrão do catálogo. */
async function readPublicFieldsConfig(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const allow = await getSetting(PUBLIC_FIELDS_ALLOWLIST_KEY, tenant, transaction, PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_ALLOWLIST_KEY]);
  const features = await getSetting(PUBLIC_FIELDS_FEATURES_KEY, tenant, transaction, PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_FEATURES_KEY]);
  const allowlist = parseList(allow);
  const featuresPermitidas = parseList(features);
  return {
    allowlist: allowlist.length ? allowlist : parseList(PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_ALLOWLIST_KEY]),
    featuresPermitidas: featuresPermitidas.length ? featuresPermitidas : parseList(PUBLIC_FIELDS_DEFAULTS[PUBLIC_FIELDS_FEATURES_KEY]),
  };
}

module.exports = {
  PUBLIC_FIELDS_ALLOWLIST_KEY,
  PUBLIC_FIELDS_FEATURES_KEY,
  TEMPLATE_MANAGE_PERMISSION,
  PUBLIC_FIELD_CATALOG,
  FEATURE_CATALOG,
  PUBLIC_FIELDS_DEFAULTS,
  PUBLIC_FIELDS_SETTINGS_SCHEMA,
  parseList,
  isPublicFieldsKey,
  assertPublicFieldsChangeAllowed,
  requireTemplateManageToAddPublicFields,
  readPublicFieldsConfig,
};
