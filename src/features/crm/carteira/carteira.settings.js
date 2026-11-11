'use strict';

/**
 * Política de equipe da carteira do corretor (livro do Marco 3 §18: "Corretor visualizar carteira alheia — Escopo conforme política
 * de equipe"; CRM-TS-012). O livro não diz o que o corretor de escopo próprio vê dos registros do CRM que NÃO estão ligados a uma
 * oportunidade (mensagem, visita, radar ou ocorrência só com a pessoa): é parâmetro da empresa (DI-M3CB-1), na aba CRM de Configurações.
 *   - CLIENTE_DA_CARTEIRA (padrão): vê o registro sem oportunidade se ele mesmo o criou ou se a pessoa tem oportunidade na carteira dele.
 *   - SOMENTE_PROPRIOS: vê o registro sem oportunidade só se ele mesmo o criou (ou é o autor/o responsável designado).
 * Registro ligado a uma oportunidade segue sempre o responsável da oportunidade (o parâmetro não abre carteira alheia).
 */
const SEM_OPORTUNIDADE_KEY = 'crm.carteira.registro_sem_oportunidade';
const MODES = Object.freeze({ CLIENTE: 'CLIENTE_DA_CARTEIRA', PROPRIOS: 'SOMENTE_PROPRIOS' });

const CARTEIRA_SETTING_DEFAULTS = Object.freeze({ [SEM_OPORTUNIDADE_KEY]: MODES.CLIENTE });

const CARTEIRA_SETTINGS_SCHEMA = Object.freeze({
  [SEM_OPORTUNIDADE_KEY]: { type: 'string', enum: Object.values(MODES) },
});

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../../settings/settings.service').getSetting(...args);

/** Modo vigente da empresa; valor gravado fora do catálogo vale o mais restrito (SOMENTE_PROPRIOS). */
async function readSemOportunidadeMode(tenant, transaction) {
  const value = await getSetting(SEM_OPORTUNIDADE_KEY, tenant, transaction, CARTEIRA_SETTING_DEFAULTS[SEM_OPORTUNIDADE_KEY]);
  return Object.values(MODES).includes(value) ? value : MODES.PROPRIOS;
}

module.exports = { SEM_OPORTUNIDADE_KEY, MODES, CARTEIRA_SETTING_DEFAULTS, CARTEIRA_SETTINGS_SCHEMA, readSemOportunidadeMode };
