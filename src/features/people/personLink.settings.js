'use strict';

/**
 * Parâmetros do vínculo de pessoa entre empresas do grupo (DI-M9I-5). Padrões em Maturacao/demandas/parametros.csv.
 * O que protege contra enumeração de CPF/CNPJ fica fixo no banco (prova do nome, permissão people:link); estes dois números só
 * limitam quantas tentativas que NÃO conferem (e CPF/CNPJ recusados por já existir no grupo) cada usuário faz por janela.
 */
const PEOPLE_LINK_SETTINGS_SCHEMA = Object.freeze({
  'people.vinculo.tentativas_max': { type: 'integer', min: 1, max: 1000 },
  'people.vinculo.janela_minutos': { type: 'integer', min: 1, max: 1440 },
});

const PADROES = Object.freeze({ tentativasMax: 10, janelaMinutos: 60 });

async function readPersonLinkParams(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const [max, janela] = await Promise.all([
    getSetting('people.vinculo.tentativas_max', tenant, transaction, PADROES.tentativasMax),
    getSetting('people.vinculo.janela_minutos', tenant, transaction, PADROES.janelaMinutos),
  ]);
  return {
    tentativasMax: Number.isInteger(max) && max >= 1 ? max : PADROES.tentativasMax,
    janelaMinutos: Number.isInteger(janela) && janela >= 1 ? janela : PADROES.janelaMinutos,
  };
}

module.exports = { PEOPLE_LINK_SETTINGS_SCHEMA, PADROES, readPersonLinkParams };
