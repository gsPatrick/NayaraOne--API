'use strict';

const { getSetting } = require('../../settings/settings.service');
const { readRetentionPayload } = require('../../integrations/retention');
const { KEYS, RETENTION_SETTING_DEFAULTS } = require('./retention.settings');
const { REVIEW_DEFAULT, LEGAL_BASES } = require('./retention.constants');

/**
 * Políticas semeadas de cada empresa (M9-D911 §3.2). Prazos: os parâmetros governanca.retencao.prazo_meses.* (padrão do livro/regra legal usual). Disposição: o livro só
 * a fixa para leads (ANONYMIZE), logs (DELETE) e auditoria de segurança (ARCHIVE); onde não diz, a disposição é REVIEW (decisão humana, nunca descarte sozinho).
 * REVIEW_DEFAULT (0 meses, REVIEW) é a política de tudo o que nenhuma outra cobre. INTEGRACAO é o calendário das tabelas de integração (prazos próprios das M9-D203, D205 e D207).
 */
const read = (tenant, tx, key) => getSetting(key, tenant, tx, RETENTION_SETTING_DEFAULTS[key]);

/** Meses (arredondados para cima, mínimo 1) do maior prazo de integração: só informativo, quem manda são os parâmetros integration.*. */
async function integrationMonths(tenant, tx) {
  const payload = await readRetentionPayload(tenant, tx);
  const days = Math.max(1, ...Object.values(payload).map(Number));
  return Math.max(1, Math.ceil(days / 30));
}

async function seedPolicies(tenant, tx) {
  const basis = (code, referenceText) => ({ code, text: LEGAL_BASES[code], referenceText });
  const hold = ['LEGAL_HOLD'];
  return [
    { code: 'FISCAL', name: 'Documentos fiscais e contábeis', retentionMonths: await read(tenant, tx, KEYS.PRAZO_FISCAL), trigger: 'FISCAL_PERIOD_END', disposition: 'REVIEW', exceptions: [...hold, 'OPEN_OBLIGATION', 'ONGOING_LITIGATION', 'TAX_AUDIT'], dataTypes: ['FISCAL_OBLIGATIONS', 'TAX_DOCUMENTS'], ownerDomain: 'FISCAL', legalBasis: basis('LGPD_ART7_II_OBRIGACAO_LEGAL', 'CTN, art. 173 e 174: prazo decadencial e prescricional tributário de 5 anos.') },
    { code: 'CONTRATOS', name: 'Contratos e anexos', retentionMonths: await read(tenant, tx, KEYS.PRAZO_CONTRATOS), trigger: 'CONTRACT_END', disposition: 'REVIEW', exceptions: [...hold, 'ONGOING_LITIGATION', 'OPEN_OBLIGATION'], dataTypes: ['CONTRACTS'], ownerDomain: 'CONTRATOS', legalBasis: basis('LGPD_ART7_V_CONTRATO', 'Código Civil, art. 205: prescrição geral de 10 anos.') },
    { code: 'JURIDICO', name: 'Processos jurídicos', retentionMonths: await read(tenant, tx, KEYS.PRAZO_JURIDICO), trigger: 'CASE_CLOSED', disposition: 'REVIEW', exceptions: [...hold, 'ONGOING_LITIGATION'], dataTypes: ['LEGAL_CASES'], ownerDomain: 'CONTRATOS', legalBasis: basis('LGPD_ART7_VI_EXERCICIO_DIREITOS', 'Código Civil, art. 205: prescrição geral de 10 anos, contada do encerramento do processo.') },
    { code: 'LEADS', name: 'Leads sem contrato', retentionMonths: await read(tenant, tx, KEYS.PRAZO_LEADS), trigger: 'LEAD_LAST_CONTACT', disposition: 'ANONYMIZE', exceptions: [...hold, 'OPEN_OBLIGATION', 'CUSTOMER_OBJECTION'], dataTypes: ['LEADS'], ownerDomain: 'CRM', legalBasis: basis('LGPD_ART7_IX_LEGITIMO_INTERESSE', 'LGPD, art. 15 e 16: término do tratamento; sem contrato nem contato recente o dado pessoal é anonimizado.') },
    { code: 'LOGS_TECNICOS', name: 'Logs técnicos', retentionMonths: await read(tenant, tx, KEYS.PRAZO_LOGS), trigger: 'TRANSACTION_DATE', disposition: 'DELETE', exceptions: hold, dataTypes: ['ACCESS_SIGNALS'], ownerDomain: 'TECNOLOGIA', legalBasis: basis('LGPD_ART7_IX_LEGITIMO_INTERESSE', 'Marco Civil da Internet, art. 15: no mínimo 6 meses de registros de acesso; o prazo maior é política interna de segurança.') },
    { code: 'AUDITORIA_SEGURANCA', name: 'Auditoria de segurança', retentionMonths: await read(tenant, tx, KEYS.PRAZO_AUDITORIA), trigger: 'TRANSACTION_DATE', disposition: 'ARCHIVE', exceptions: hold, dataTypes: ['AUDIT_LOG'], ownerDomain: 'TECNOLOGIA', legalBasis: basis('LGPD_ART7_IX_LEGITIMO_INTERESSE', 'LGPD, art. 6º, X e art. 37: responsabilização e registro das operações de tratamento.') },
    { code: 'INTEGRACAO', name: 'Dados técnicos de integração', retentionMonths: await integrationMonths(tenant, tx), trigger: 'TRANSACTION_DATE', disposition: 'DELETE', exceptions: hold, dataTypes: ['INTEGRACAO'], ownerDomain: 'TECNOLOGIA', autoApply: (await read(tenant, tx, KEYS.INTEGRACAO_AUTOMATICA)) !== false, legalBasis: basis('LGPD_ART7_IX_LEGITIMO_INTERESSE', 'Prazos próprios das integrações (parâmetros integration.*, M9-D203, D205, D207 e D212): o payload bruto de DEAD_LETTER por ATTEMPTS_EXHAUSTED fica 7 dias.') },
    { code: REVIEW_DEFAULT, name: 'Padrão: revisão humana', retentionMonths: 0, trigger: 'UPLOAD_DATE', disposition: 'REVIEW', exceptions: hold, dataTypes: ['FILES'], ownerDomain: 'TECNOLOGIA', legalBasis: basis('LGPD_ART7_IX_LEGITIMO_INTERESSE', 'Onde nenhuma política vale, o item vai para revisão assim que o gatilho ocorre; nada é descartado sem decisão humana.') },
  ];
}

module.exports = { seedPolicies, integrationMonths };
