'use strict';

/**
 * Parâmetros da API externa (M9-D844; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.api.cliente.token_validade_s: validade do access_token de cliente em segundos (padrão 900, o do livro; 60 a 3600).
 *  - governanca.api.cliente.segredo_custo: custo do bcrypt do segredo, aplicado às credenciais criadas depois da mudança (padrão 10; 4 a 14).
 *  - governanca.api.externo.lead_prazo_horas: prazo, em horas, da primeira ação comercial de um lead recebido por `POST /api-external/leads` (padrão 24; 1 a 720).
 */
const TOKEN_TTL_KEY = 'governanca.api.cliente.token_validade_s';
const SECRET_COST_KEY = 'governanca.api.cliente.segredo_custo';
const LEAD_DEADLINE_KEY = 'governanca.api.externo.lead_prazo_horas';

const CLIENTS_SETTING_DEFAULTS = Object.freeze({
  [TOKEN_TTL_KEY]: 900,
  [SECRET_COST_KEY]: 10,
  [LEAD_DEADLINE_KEY]: 24,
});

const CLIENTS_SETTINGS_SCHEMA = {
  [TOKEN_TTL_KEY]: { type: 'integer', min: 60, max: 3600 },
  [SECRET_COST_KEY]: { type: 'integer', min: 4, max: 14 },
  [LEAD_DEADLINE_KEY]: { type: 'integer', min: 1, max: 720 },
};

module.exports = { TOKEN_TTL_KEY, SECRET_COST_KEY, LEAD_DEADLINE_KEY, CLIENTS_SETTING_DEFAULTS, CLIENTS_SETTINGS_SCHEMA };
