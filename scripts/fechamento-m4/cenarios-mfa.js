'use strict';
/**
 * Recusas por falta de MFA, capturadas ANTES de o perfil ter MFA (MFA_REQUIRED_NOT_ENABLED) e
 * depois de habilitado mas sem verificação recente (MFA_STEP_UP_REQUIRED). Provam que as ações
 * críticas do Financeiro exigem o autenticador (§8 passo 6, §16 reabertura, §17 exportação).
 */
const U = '00000000-0000-4000-8000-000000000000';

async function semMfaHabilitado(R) {
  await R.http({ id: 'MFA-01', linhas: ['M4-§8.6'], titulo: 'Executar intenção de pagamento sem MFA habilitado: recusado', quem: 'A:gestor', metodo: 'POST', rota: `/finance/payment-intents/${U}/execute`, corpo: {}, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.http({ id: 'MFA-02', linhas: ['M4-§16.4'], titulo: 'Reabrir período sem MFA habilitado: recusado', quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: '2071-03', reason: 'Reabertura de teste sem MFA' }, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
}

async function semVerificacaoRecente(R) {
  await R.http({ id: 'MFA-03', linhas: ['M4-§8.6', 'M4-G§5'], titulo: 'MFA habilitado mas sem verificação recente: executar intenção é recusado (step-up)', quem: 'A:gestor', metodo: 'POST', rota: `/finance/payment-intents/${U}/execute`, corpo: {}, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-04', linhas: ['M4-§10.1'], titulo: 'Baixa parcial sem verificação recente do autenticador: recusada', quem: 'A:gestor', metodo: 'POST', rota: `/finance/entries/${U}/settle-partial`, corpo: { partialAmount: '0.10', idempotencyKey: 'sem-mfa-recente-01' }, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-05', linhas: ['M4-G§18.2'], titulo: 'Baixa integral sem verificação recente: recusada (nada é baixado sem confirmação confiável)', quem: 'A:gestor', metodo: 'POST', rota: `/finance/entries/${U}/settle`, corpo: {}, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-06', linhas: ['M4-§17.9'], titulo: 'Exportação financeira governada sem verificação recente do MFA: bloqueada', quem: 'A:gestor', metodo: 'POST', rota: '/exports', cabecalhos: { 'Idempotency-Key': `m4-exp-sem-mfa-${Date.now()}` }, corpo: { resourceType: 'finance.entries', format: 'csv', purpose: 'AUDITORIA', justification: 'Conferência mensal do financeiro pela auditoria (captura do Marco 4)', filter: {} }, esperado: { status: [400, 403, 409, 422] } });
  await R.http({ id: 'MFA-07', linhas: ['M4-§16.4', 'M4-G§18.10'], titulo: 'Reabertura de período sem verificação recente: recusada', quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: '2071-03', reason: 'Reabertura sem verificação recente' }, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-08', linhas: ['M4-§15'], titulo: 'Transferência entre empresas sem verificação recente: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: {}, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-09', linhas: ['M4-§14.1'], titulo: 'Publicar regra de comissão sem verificação recente: recusada', quem: 'A:checker', metodo: 'POST', rota: '/finance/commission-rule', corpo: { componentPercentages: { BROKER: 5 } }, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-10', linhas: ['M4-§12.5'], titulo: 'Aprovar repasse sem verificação recente: recusado', quem: 'A:checker', metodo: 'POST', rota: `/finance/owner-repasses/${U}/approve`, corpo: {}, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await R.http({ id: 'MFA-11', linhas: ['M4-§9'], titulo: 'Alterar dados bancários sem verificação recente: recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/finance/bank-accounts/${c.baLoc}`, corpo: { pixKey: 'troca-sem-mfa@exemplo.test' }, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
}

module.exports = { semMfaHabilitado, semVerificacaoRecente };
