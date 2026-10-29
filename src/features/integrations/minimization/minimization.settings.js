'use strict';

/**
 * Parâmetros da minimização (M9-D219): `integration.minimizacao.max_classificacao.<família>` — a classificação máxima que a
 * família aceita no payload. O padrão e o teto são os do livro (purposeLimits.BOOK_CEILING); o valor da empresa só vale se
 * for MAIS RESTRITIVO (o servidor aplica o menor dos dois). Dicionário fail-closed em SETTINGS_SCHEMA.
 */
const { DOMAINS } = require('../providers/catalog.domains');
const { INTEGRATION_SCALE } = require('./classification');

const MAX_KEY_PREFIX = 'integration.minimizacao.max_classificacao.';
const maxKey = (domain) => `${MAX_KEY_PREFIX}${String(domain).toLowerCase()}`;

const MINIMIZATION_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(
  DOMAINS.map((domain) => [maxKey(domain), { type: 'string', enum: [...INTEGRATION_SCALE] }])
));

module.exports = { MINIMIZATION_SETTINGS_SCHEMA, maxKey, MAX_KEY_PREFIX };
