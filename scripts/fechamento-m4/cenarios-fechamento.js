'use strict';
/**
 * Operações entre empresas (§15) e fechamento mensal (§16): OPEN -> REVIEW -> CLOSED, bloqueio,
 * reabertura excepcional e ajuste posterior no período corrente.
 */
const { assinarWebhook } = require('./ambiente');

async function fecharMes(R, { prefixo, mes, linhas }) {
  await R.http({ id: `${prefixo}-1`, linhas: linhas[0], titulo: `Conferência humana do caixa de terceiros de ${mes}`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures/checks', corpo: { referenceMonth: mes, checkType: 'THIRD_PARTY_CASH', note: 'Caixa de terceiros conferido contra o extrato (captura do Marco 4)' }, esperado: { status: 200 } });
  await R.http({ id: `${prefixo}-2`, linhas: linhas[1], titulo: `Conferência de comissões e repasses de ${mes}`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures/checks', corpo: { referenceMonth: mes, checkType: 'COMMISSIONS_REPASSES', note: 'Comissões e repasses revisados (captura do Marco 4)' }, esperado: { status: 200 } });
  await R.http({ id: `${prefixo}-3`, linhas: linhas[2], titulo: `Pedido de fechamento de ${mes}: vai para REVIEW (aguarda aprovação)`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures', corpo: { referenceMonth: mes }, esperado: { status: 201 } });
  await R.http({ id: `${prefixo}-4`, linhas: linhas[3], titulo: `Aprovação do fechamento de ${mes} por outra pessoa com MFA recente: CLOSED`, quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/approve', corpo: { referenceMonth: mes }, esperado: { status: 200 } });
}

module.exports = async function fechamento(R) {
  const s = R.ctx.sfx;

  // ---------- §15 Transferências entre empresas ----------
  await R.http({ id: 'IC01', linhas: ['M4-§15'], titulo: 'Empresas de destino possíveis: só empresas do mesmo grupo', quem: 'A:gestor', metodo: 'GET', rota: '/finance/intercompany-transfers/destination-companies', esperado: { status: 200 } });
  await R.http({ id: 'IC02', linhas: ['M4-§15.1'], titulo: 'Contas da empresa de destino: quem não tem acesso financeiro na empresa B não lista nem usa as contas dela', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/finance/intercompany-transfers/destination-bank-accounts?toCompanyId=${c.companyA2}`, esperado: { status: 403, codigo: 'FINANCE_INTERCOMPANY_DESTINATION_FORBIDDEN' } });
  const ic = (extra) => (c) => ({ toCompanyId: c.companyA2, amount: 7500, reason: `Rateio administrativo da obra ${s}`, evidenceFileId: c.fileIc, fromBankAccountId: c.baObra, toBankAccountId: c.baA2, ...extra(c) });
  await R.http({ id: 'IC03', linhas: ['M4-§15'], titulo: 'Transferência sem motivo: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: ic(() => ({ reason: '' })), esperado: { status: 400, codigo: 'FINANCE_INTERCOMPANY_REASON_REQUIRED' } });
  await R.http({ id: 'IC04', linhas: ['M4-FIN-002'], titulo: 'Transferência para a própria empresa: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: ic((c) => ({ toCompanyId: R.tenant('A:gestor').companyId, toBankAccountId: c.baLoc })), esperado: { status: 400, codigo: 'FINANCE_INTERCOMPANY_SAME_COMPANY' } });
  await R.http({ id: 'IC05', linhas: ['M4-§15.1'], titulo: 'Transferência para empresa de OUTRO grupo (tenant B): recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: ic(() => ({ toCompanyId: R.tenant('B:gestor').companyId })), esperado: { status: [400, 403, 404] } });
  await R.http({ id: 'IC06', linhas: ['M4-§5.16', 'M4-G§1.12', 'M4-§3.3'], titulo: 'Pedido formal A -> A2 (Construção/BB) com motivo, documento e contas (MFA recente): PENDING_APPROVAL', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: ic(() => ({})), esperado: { status: 201 }, guardar: (b, c) => { c.ic = (b.data.transfer || b.data).id; } });
  await R.http({ id: 'IC07', linhas: ['M4-§15'], titulo: 'Quem pediu não aprova a própria transferência', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/intercompany-transfers/${c.ic}/approve`, corpo: {}, esperado: { status: 403 } });
  await R.http({ id: 'IC08', linhas: ['M4-FIN-TS-016', 'M4-§21.9', 'M4-§15'], titulo: 'Aprovação por outra pessoa (MFA recente): nascem os DOIS lados vinculados pelo id da transferência', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/intercompany-transfers/${c.ic}/approve`, corpo: {}, esperado: { status: 200 } });
  await R.http({ id: 'IC09', linhas: ['M4-FIN-TS-016', 'M4-FIN-002'], titulo: 'Transferência com lado de saída (A) e lado de entrada (A2) vinculados', quem: 'A:leitura', metodo: 'GET', rota: '/finance/intercompany-transfers', esperado: { status: 200 } });
  await R.http({ id: 'IC10', linhas: ['M4-G§19.F7'], titulo: 'Conciliação da transferência entre empresas', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/intercompany-transfers/${c.ic}/reconcile`, corpo: {}, esperado: { status: 200 } });
  await R.http({ id: 'IC11', linhas: ['M4-§5.16'], titulo: 'Conciliar de novo: recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/intercompany-transfers/${c.ic}/reconcile`, corpo: {}, esperado: { status: 409, codigo: 'FINANCE_INTERCOMPANY_ALREADY_RECONCILED' } });
  await R.http({ id: 'IC12', linhas: ['M4-§15.2', 'M4-§3.2'], titulo: 'Consolidado do grupo: a transferência interna é eliminada só na apresentação', quem: 'A:gestor', metodo: 'GET', rota: '/finance/reports/group-consolidated', esperado: { status: 200 } });
  await R.http({ id: 'IC13', linhas: ['M4-§15.1'], titulo: 'Tenant B não enxerga a transferência do grupo A', quem: 'B:gestor', metodo: 'GET', rota: '/finance/intercompany-transfers', esperado: { status: 200 } });

  // ---------- §16 Fechamento mensal ----------
  const mes = `2071-${String(1 + (Number(s) % 6)).padStart(2, '0')}`;
  R.ctx.mesFechado = mes;
  await R.http({ id: 'F01', linhas: ['M4-§16.2', 'M4-G§12'], titulo: `Pré-condições do fechamento de ${mes} (extratos, conciliação, terceiros, comissões/repasses)`, quem: 'A:leitura', metodo: 'GET', rota: `/finance/period-closures/${mes}/preconditions`, esperado: { status: 200 } });
  await R.http({ id: 'F02', linhas: ['M4-§16.2'], titulo: 'Fechar sem as conferências humanas: recusado e nada gravado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures', corpo: { referenceMonth: mes }, esperado: { status: 409, codigo: 'FINANCE_PERIOD_PRECONDITIONS_NOT_MET' } });
  await fecharMes(R, { prefixo: 'F03', mes, linhas: [['M4-§16.2'], ['M4-G§19.F7'], ['M4-§16.1', 'M4-G§1.13'], ['M4-§16.1', 'M4-§5.17', 'M4-FIN-012']] });
  await R.http({ id: 'F04', linhas: ['M4-§21.10', 'M4-G§20.9', 'M4-G§12'], titulo: 'Histórico de fechamentos: mês CLOSED com retrato (snapshot), autor e aprovador', quem: 'A:leitura', metodo: 'GET', rota: `/finance/period-closures?referenceMonth=${mes}`, esperado: { status: 200 } });
  await R.http({ id: 'F05', linhas: ['M4-§16.3', 'M4-FIN-TS-010', 'M4-G§16.9'], titulo: 'Lançamento com competência no mês CLOSED: bloqueado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 50, description: 'Lançamento no mês fechado', costCenterId: c.cc, competenceMonth: mes }), esperado: { status: 409 } });
  await R.http({ id: 'F06', linhas: ['M4-§16.1', 'M4-G§17.10'], titulo: 'Pedir de novo o fechamento do mês já fechado: recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures', corpo: { referenceMonth: mes }, esperado: { status: 409, codigo: 'FINANCE_PERIOD_ALREADY_CLOSED' } });
  await R.http({ id: 'F07', linhas: ['M4-FIN-TS-011'], titulo: 'Usuário comum (maker) tenta reabrir: negado', quem: 'A:maker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: mes, reason: 'Tentativa de reabertura por usuário comum' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'F08', linhas: ['M4-§16.4', 'M4-G§18.10'], titulo: 'Reabertura sem motivo: recusada', quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: mes }, esperado: { status: 400 } });
  await R.http({ id: 'F09', linhas: ['M4-§16.4', 'M4-FIN-012'], titulo: 'Reabertura excepcional com permissão crítica, MFA recente e motivo (auditada)', quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: mes, reason: 'Correção de classificação identificada pela auditoria (teste da captura)' }, esperado: { status: 200 } });
  await R.http({ id: 'F10', linhas: ['M4-G§20.9'], titulo: 'Depois da reabertura, o histórico mostra fechamento e reabertura com autor e motivo', quem: 'A:leitura', metodo: 'GET', rota: `/finance/period-closures?referenceMonth=${mes}`, esperado: { status: 200 } });

  // ---------- §16.5 Ajuste posterior entra no período corrente ----------
  const mesAj = `2072-${String(1 + (Number(s) % 6)).padStart(2, '0')}`;
  R.ctx.mesAjuste = mesAj;
  await R.http({ id: 'F20', linhas: ['M4-§16.5'], titulo: `Pagamento com competência ${mesAj} registrado antes do fechamento (ainda não pago)`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 420, description: `Pagamento confirmado após o fechamento ${s}`, costCenterId: c.cc, bankAccountId: c.baPag, competenceMonth: mesAj }), esperado: { status: 201 }, guardar: (b, c) => { c.pgAj = b.data.id; } });
  await fecharMes(R, { prefixo: 'F24', mes: mesAj, linhas: [['M4-§16.2'], ['M4-§16.2'], ['M4-§16.1'], ['M4-G§14.10']] });
  await R.http({ id: 'F21', linhas: ['M4-§16.5'], titulo: 'Intenção do pagamento do mês já fechado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/payment-intents', corpo: (c) => ({ financialEntryId: c.pgAj }), esperado: { status: [201, 409] }, guardar: (b, c) => { c.piAj = b.data.id; } });
  await R.http({ id: 'F22', linhas: ['M4-§16.5'], titulo: 'Aprovação por outra pessoa', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/payment-intents/${c.piAj}/approve`, corpo: {}, esperado: { status: 200 } });
  await R.http({ id: 'F23', linhas: ['M4-§16.5'], titulo: 'Envio ao banco sandbox (fica aguardando confirmação)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/payment-intents/${c.piAj}/submit-to-bank`, corpo: { paymentMethod: 'PIX' }, esperado: { status: [200, 201] }, guardar: (b, c) => { const d = b.data || {}; c.extAj = d.externalSubmissionId || (d.intent && d.intent.externalSubmissionId); } });
  await R.http({
    id: 'F25', linhas: ['M4-§16.5'], titulo: 'Confirmação do banco chega DEPOIS do fechamento: liquidado no período corrente com referência ao original', quem: 'anonimo', metodo: 'POST', rota: '/finance/webhooks/bank-payment',
    corpoBruto: (c) => assinarWebhook(c, { externalSubmissionId: c.extAj, status: 'CONFIRMED' }).bruto,
    cabecalhos: (c) => ({ 'x-webhook-signature': assinarWebhook(c, { externalSubmissionId: c.extAj, status: 'CONFIRMED' }).assinatura }),
    esperado: { status: 200 },
  });
  await R.http({ id: 'F26', linhas: ['M4-§16.5', 'M4-§16.3'], titulo: 'Caso registrado: confirmação pós-fechamento (POST_CLOSING_BANK_CONFIRMATION) apontando o mês original', quem: 'A:leitura', metodo: 'GET', rota: '/finance/anomaly-cases', esperado: { status: 200 } });
};
