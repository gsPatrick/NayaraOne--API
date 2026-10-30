'use strict';

/** Padrões do armazenamento (os mesmos de `integration.storage.*` em Maturacao/demandas/parametros.csv); quem lê a configuração da empresa está em integrations/storage/storage.params.js. */
module.exports = Object.freeze({ maxTtlSeconds: 900, maxObjectBytes: 26214400 });
