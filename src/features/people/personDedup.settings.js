'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros da deduplicação de Pessoas (M3-03 / CAD-04 / CRMX-010, DI-M3PE-3 e DI-M3PE-4). O livro (§4) fixa os três níveis e o que cada
 * um faz; o que ele não diz vira parâmetro, com padrão em Maturacao/demandas/parametros.csv:
 * - `people.deduplicacao.ddi_padrao` (55): DDI dado ao telefone digitado sem código do país, na comparação do match médio;
 * - `people.deduplicacao.motivo_minimo` (10): tamanho mínimo do motivo para criar mesmo com o match médio (exceção auditada);
 * - `people.deduplicacao.contato_no_grupo` (ligado): o match médio também procura o telefone/e-mail nas outras empresas do grupo
 *   (Guia §3, deduplicação por groupId). A resposta diz só "existe no grupo", sem id nem nome, e conta como tentativa do limite do vínculo.
 */
const DDI_KEY = 'people.deduplicacao.ddi_padrao';
const REASON_MIN_KEY = 'people.deduplicacao.motivo_minimo';
const GROUP_CONTACT_KEY = 'people.deduplicacao.contato_no_grupo';
const DEFAULTS = Object.freeze({ [DDI_KEY]: '55', [REASON_MIN_KEY]: 10, [GROUP_CONTACT_KEY]: true });

const PEOPLE_DEDUP_SETTINGS_SCHEMA = Object.freeze({
  [DDI_KEY]: {
    type: 'string',
    validate: (key, value) => {
      if (!/^\d{1,3}$/.test(String(value).trim())) {
        throw AppError.badRequest(`O valor de "${key}" deve ter de 1 a 3 dígitos (ex.: 55).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  [REASON_MIN_KEY]: { type: 'integer', min: 5, max: 500 },
  [GROUP_CONTACT_KEY]: { type: 'boolean' },
});

async function readDedupParams(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const read = (key) => getSetting(key, tenant, transaction, DEFAULTS[key]);
  const ddi = String(await read(DDI_KEY)).trim();
  const reasonMin = await read(REASON_MIN_KEY);
  const groupContact = await read(GROUP_CONTACT_KEY);
  return {
    ddi: /^\d{1,3}$/.test(ddi) ? ddi : DEFAULTS[DDI_KEY],
    motivoMinimo: Number.isInteger(reasonMin) && reasonMin >= 5 ? reasonMin : DEFAULTS[REASON_MIN_KEY],
    contatoNoGrupo: typeof groupContact === 'boolean' ? groupContact : DEFAULTS[GROUP_CONTACT_KEY],
  };
}

module.exports = { DDI_KEY, REASON_MIN_KEY, GROUP_CONTACT_KEY, DEFAULTS, PEOPLE_DEDUP_SETTINGS_SCHEMA, readDedupParams };
