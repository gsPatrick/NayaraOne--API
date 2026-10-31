'use strict';

/**
 * M9-D900 (LEVE-D) — trava de gravação do parâmetro `migracao.legado.codigo_empresa`: o código da empresa no sistema antigo não pode repetir o de outra empresa do mesmo grupo
 * (409 GOV_MIG_LEGACY_CODE_DUPLICATE), senão uma empresa leria as linhas da outra. Fica aqui (e não na migração) porque o serviço de parâmetros não importa a migração; a regra está
 * em src/features/migration-v2/ingest/connectors/company.code.js e a carga confere de novo na leitura. Carregada pelo settings.service: vale para qualquer caminho que grave a chave.
 */
const { registerSettingGuard } = require('./settingGuards');

registerSettingGuard('migracao.legado.codigo_empresa', async (value, tenant, _actorUserId, transaction) => {
  await require('../migration-v2/ingest/connectors/company.code').assertCodeAvailable(tenant, value, transaction);
});
