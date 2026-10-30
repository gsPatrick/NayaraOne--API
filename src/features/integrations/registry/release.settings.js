'use strict';

const AppError = require('../../../utils/AppError');
const { CODE_RE } = require('./registry.constants');
const { DRILL_SCENARIOS } = require('./release.constants');

/**
 * Parâmetros do portão de liberação para produção (M9-D256): dicionário fail-closed de SETTINGS_SCHEMA; a leitura com os padrões está em release.params.js.
 *  - exigir rotação programada do segredo (livro 3.1 item 6);
 *  - cenários do ensaio de falha exigidos (livro 3.1 item 3: derrubar, 429, 401, timeout e recuperação);
 *  - fornecedores sem conta externa (fluxo manual), que não têm segredo, webhook nem saída de rede para provar.
 */
const lista = (validaItem, mensagem) => ({
  type: 'string',
  validate: (key, value) => {
    const itens = typeof value === 'string' ? value.split(',').map((x) => x.trim()) : [];
    if (typeof value !== 'string' || !itens.length || itens.length > 20 || !itens.every(validaItem)) throw AppError.badRequest(`O valor de "${key}" ${mensagem}`, 'SETTING_INVALID_VALUE', { key, value });
  },
});

const RELEASE_SETTINGS_SCHEMA = Object.freeze({
  'integration.release.require_rotation_schedule': { type: 'boolean' },
  'integration.release.drill_scenarios': lista((x) => DRILL_SCENARIOS.includes(x), `deve ser uma lista, separada por vírgula, de: ${DRILL_SCENARIOS.join(', ')}.`),
  'integration.release.no_external_account_providers': lista((x) => CODE_RE.test(x), 'deve ser uma lista de códigos de fornecedor separados por vírgula.'),
});

module.exports = { RELEASE_SETTINGS_SCHEMA };
