'use strict';

/**
 * Parâmetros do registro de flags e configurações (M9-D870; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.flags.risco_padrao: risco de uma chave nova quando quem cria não informa (MEDIUM).
 *  - governanca.flags.risco_config_absorvida: risco das configurações da empresa absorvidas pelo registro (LOW).
 *  - governanca.flags.risco_interruptores_degradacao: risco dos cinco interruptores de degradação por custo (MEDIUM).
 *  - governanca.flags.valor_max_caracteres: tamanho máximo do valor de texto ou JSON de uma chave (2000).
 *  - governanca.flags.expiracao_hora e governanca.flags.expiracao_minuto: horário (Brasília) do job de expiração das flags temporárias (M9-D871; 06:30, o do livro).
 *  - governanca.flags.expiracao_lembrete_diario: enquanto a flag temporária vencida continuar no registro, o responsável é avisado todo dia (ligado).
 *  - governanca.flags.kill_teste_dias: periodicidade do teste do kill switch crítico, em dias (M9-D872; 30). Passada a periodicidade sem PASS, o responsável é alertado.
 *  - governanca.flags.kill_teste_hora e governanca.flags.kill_teste_minuto: horário (Brasília) do job que testa os kill switches e reexecuta o teste dos UNVERIFIED (05:00, o da demanda).
 *  - governanca.flags.kill_teste_tolerancia_min: minutos que um teste pode ficar em andamento antes de a execução seguinte considerá-lo interrompido e restaurar o switch (10).
 */
const F = 'governanca.flags.';
const KEYS = Object.freeze({
  defaultRisk: `${F}risco_padrao`, absorbedRisk: `${F}risco_config_absorvida`, switchRisk: `${F}risco_interruptores_degradacao`, valueMax: `${F}valor_max_caracteres`,
  expiryHour: `${F}expiracao_hora`, expiryMinute: `${F}expiracao_minuto`, expiryReminder: `${F}expiracao_lembrete_diario`,
  killDays: `${F}kill_teste_dias`, killHour: `${F}kill_teste_hora`, killMinute: `${F}kill_teste_minuto`, killToleranceMin: `${F}kill_teste_tolerancia_min`,
});
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const FLAGS_SETTING_DEFAULTS = Object.freeze({
  [KEYS.defaultRisk]: 'MEDIUM', [KEYS.absorbedRisk]: 'LOW', [KEYS.switchRisk]: 'MEDIUM', [KEYS.valueMax]: 2000,
  [KEYS.expiryHour]: 6, [KEYS.expiryMinute]: 30, [KEYS.expiryReminder]: true,
  [KEYS.killDays]: 30, [KEYS.killHour]: 5, [KEYS.killMinute]: 0, [KEYS.killToleranceMin]: 10,
});

const FLAGS_SETTINGS_SCHEMA = {
  [KEYS.defaultRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.absorbedRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.switchRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.valueMax]: { type: 'integer', min: 100, max: 100000 },
  [KEYS.expiryHour]: { type: 'integer', min: 0, max: 23 },
  [KEYS.expiryMinute]: { type: 'integer', min: 0, max: 59 },
  [KEYS.expiryReminder]: { type: 'boolean' },
  [KEYS.killDays]: { type: 'integer', min: 1, max: 365 },
  [KEYS.killHour]: { type: 'integer', min: 0, max: 23 },
  [KEYS.killMinute]: { type: 'integer', min: 0, max: 59 },
  [KEYS.killToleranceMin]: { type: 'integer', min: 1, max: 1440 },
};

module.exports = { KEYS, RISK_LEVELS, FLAGS_SETTING_DEFAULTS, FLAGS_SETTINGS_SCHEMA };
