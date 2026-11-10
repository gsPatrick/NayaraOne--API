'use strict';
/**
 * Antifraude (§17), exportação governada, NAY Financeira somente leitura (§18), relatório semanal
 * de saúde (§19), orçamento/projeção (§5.18) e casos de anomalia (§5.19).
 */
module.exports = async function relatorio(R) {
  const s = R.ctx.sfx;
  const hoje = R.ctx.hoje;

  // ---------- §19 Relatório semanal de saúde (um retrato por grupo de indicadores) ----------
  const saude = (id, linhas, titulo, rota = '/finance/reports/weekly-health') => R.http({ id, linhas, titulo, quem: 'A:leitura', metodo: 'GET', rota, esperado: { status: 200 } });
  await saude('H01', ['M4-§19.1', 'M4-§19.2', 'M4-G§13'], 'Relatório semanal: caixa disponível (conciliado, sem terceiros) e contas a pagar 7/30/60 dias');
  await saude('H02', ['M4-§19.3', 'M4-§19.4', 'M4-§19.5'], 'Relatório semanal: recebíveis 7/30/60, necessidade para respirar e margem por setor');
  await saude('H03', ['M4-§19.6', 'M4-§19.7', 'M4-§19.8'], 'Relatório semanal: inadimplência, pendências de conciliação e comissões provisionadas');
  await saude('H04', ['M4-§19.9', 'M4-§19.10', 'M4-G§1.15'], 'Relatório semanal: repasses pendentes e anomalias HIGH/CRITICAL abertas');
  await R.http({ id: 'H05', linhas: ['M4-G§19.F8'], titulo: 'Tenant B: relatório próprio, sem números do tenant A', quem: 'B:leitura', metodo: 'GET', rota: '/finance/reports/weekly-health', esperado: { status: 200 } });

  // ---------- §5.18 Orçamento/projeção ----------
  await R.http({ id: 'H10', linhas: ['M4-§5.18'], titulo: 'Orçamento/projeção de despesa da competência corrente', quem: 'A:gestor', metodo: 'POST', rota: '/finance/budget-forecasts', corpo: (c) => ({ competenceMonth: hoje.slice(0, 7), nature: 'PAYABLE', costCenterId: c.cc, description: `Orçamento de despesas ${s}`, forecastedAmount: 5000 }), esperado: { status: 201 } });
  await R.http({ id: 'H11', linhas: ['M4-§5.18', 'M4-G§20.10'], titulo: 'Orçado x realizado da competência (conferido contra os lançamentos)', quem: 'A:leitura', metodo: 'GET', rota: `/finance/budget-forecasts/compare?competenceMonth=${hoje.slice(0, 7)}`, esperado: { status: 200 } });

  // ---------- §18 NAY Financeira (somente leitura) ----------
  await R.http({ id: 'H20', linhas: ['M4-§18.1', 'M4-§18.4', 'M4-§1'], titulo: 'NAY Financeira explica caixa, inadimplência e anomalias citando as fontes internas', quem: 'A:leitura', metodo: 'GET', rota: '/finance/nay/insights', esperado: { status: 200 } });
  await R.http({ id: 'H21', linhas: ['M4-§18.2', 'M4-§18.5', 'M4-§18.6'], titulo: 'NAY sugere cobrança/priorização, separa realizado, previsto e estimado e avisa conclusão parcial', quem: 'A:gestor', metodo: 'GET', rota: '/finance/nay/insights', esperado: { status: 200 } });
  await R.http({ id: 'H22', linhas: ['M4-§18.3', 'M4-FIN-014', 'M4-FIN-TS-014'], titulo: 'NAY não tem rota de escrita: POST na NAY Financeira não existe', quem: 'A:gestor', metodo: 'POST', rota: '/finance/nay/insights', corpo: { action: 'pay', paymentIntentId: '00000000-0000-4000-8000-000000000000' }, esperado: { status: 404 } });
  await R.http({ id: 'H23', linhas: ['M4-G§18.9', 'M4-G§16.10'], titulo: 'Catálogo de ferramentas da IA é restrito ao administrador de IA (perfil financeiro não lista/aciona ferramentas)', quem: 'A:gestor', metodo: 'GET', rota: '/ai/tools', esperado: { status: 403 } });
  await R.http({ id: 'H24', linhas: ['M4-G§1.16'], titulo: 'NAY do tenant B responde só com os números do tenant B (leitura isolada por empresa)', quem: 'B:gestor', metodo: 'GET', rota: '/finance/nay/insights', esperado: { status: 200 } });
  await R.http({ id: 'H25', linhas: ['M4-§21.11'], titulo: 'Execução financeira sem sessão humana (como um agente sem login) é recusada: 401', quem: 'anonimo', metodo: 'POST', rota: (c) => `/finance/payment-intents/${c.pi}/execute`, corpo: {}, esperado: { status: 401 } });

  // ---------- §17 Antifraude ----------
  await R.http({ id: 'H30', linhas: ['M4-FIN-013', 'M4-§5.19', 'M4-G§1.14'], titulo: 'Casos de anomalia da empresa (troca de favorecido, confirmação pós-fechamento etc.)', quem: 'A:leitura', metodo: 'GET', rota: '/finance/anomaly-cases', esperado: { status: 200 }, guardar: (b, c) => { const l = b.data || []; const caso = l.find((x) => x.status === 'OPEN'); c.casoAberto = caso && caso.id; } });
  await R.http({ id: 'H31', linhas: ['M4-§17.2'], titulo: 'Lançamento com favorecido trocado fica retido para revisão manual: baixa recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c.pgF}/settle`, cabecalhos: { 'Idempotency-Key': `m4-rev-${s}` }, corpo: { idempotencyKey: `m4-rev-${s}` }, esperado: { status: 409 } });
  await R.http({ id: 'H32', linhas: ['M4-§17.2', 'M4-FIN-013'], titulo: 'Liberação da revisão manual por quem aprova (finance:approve + MFA recente), com nota', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/entries/${c.pgF}/clear-manual-review`, corpo: { reviewNote: 'Conferido com o fornecedor por telefone: a conta nova é legítima (teste da captura).' }, esperado: { status: 200 } });
  await R.http({ id: 'H33', linhas: ['M4-§19.10'], titulo: 'Resolver um caso de anomalia com nota de resolução', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/anomaly-cases/${c.casoAberto}/resolve`, corpo: { resolutionNote: 'Caso revisado na captura do Marco 4: sem fraude.' }, esperado: { status: 200 } });

  // Valor fora do padrão (§17.5): três pagamentos já liquidados na conta de pagamentos e um quarto 10x maior.
  await R.http({ id: 'H34', linhas: ['M4-§17.5'], titulo: 'Pagamento de valor muito acima do histórico da conta (anomaly score)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 30000, description: `Pagamento fora do padrão ${s}`, costCenterId: c.cc, bankAccountId: c.baPag }), esperado: { status: 201 }, guardar: (b, c) => { c.pgOut = b.data.id; } });
  await R.http({ id: 'H35', linhas: ['M4-§17.5'], titulo: 'Intenção de pagamento do valor fora do padrão', quem: 'A:gestor', metodo: 'POST', rota: '/finance/payment-intents', corpo: (c) => ({ financialEntryId: c.pgOut }), esperado: { status: 201 }, guardar: (b, c) => { c.piOut = b.data.id; } });
  await R.http({ id: 'H36', linhas: ['M4-§17.5'], titulo: 'O lançamento fora do padrão fica retido para revisão (requiresManualReview) e abre caso AMOUNT_OUTLIER', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/entries/${c.pgOut}`, esperado: { status: 200 } });

  // Estorno frequente (§17.8): mais dois estornos na janela de 30 dias (o primeiro foi no núcleo).
  for (const n of [1, 2]) {
    await R.http({ id: `H4${n}-a`, linhas: ['M4-§17.8'], titulo: `Recebível ${n}/2 para o alerta de estorno frequente`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 11 + n, description: `Estorno frequente ${n} ${s}`, resultCenterId: c.rc2 }), esperado: { status: 201 }, guardar: (b, c) => { c[`ef${n}`] = b.data.id; } });
    await R.http({ id: `H4${n}-b`, linhas: ['M4-§17.8'], titulo: `Recebimento ${n}/2 (MFA recente)`, quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c[`ef${n}`]}/settle`, cabecalhos: { 'Idempotency-Key': `m4-ef${n}-${s}` }, corpo: { idempotencyKey: `m4-ef${n}-${s}` }, esperado: { status: 200 } });
    await R.http({ id: `H4${n}-c`, linhas: ['M4-§17.8'], titulo: `Impacto do estorno ${n}/2`, quem: 'A:gestor', metodo: 'GET', rota: (c) => `/finance/entries/${c[`ef${n}`]}/impact`, esperado: { status: 200 }, guardar: (b, c) => { c[`ef${n}Imp`] = b.data; } });
    await R.http({ id: `H4${n}-d`, linhas: n === 2 ? ['M4-§17.8', 'M4-G§14.11'] : ['M4-§17.8'], titulo: `Estorno ${n}/2${n === 2 ? ': terceiro estorno em 30 dias abre caso FREQUENT_REVERSAL' : ''}`, quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c[`ef${n}`]}/reverse`, corpo: (c) => ({ reason: 'Estorno de teste para o alerta de estorno frequente.', confirmation: { typedCode: c[`ef${n}Imp`].record.code, justification: 'Estorno de teste para o alerta de estorno frequente.', impactToken: c[`ef${n}Imp`].impactToken, understood: true } }), esperado: { status: 200 } });
  }
  await R.http({ id: 'H43', linhas: ['M4-§17.8', 'M4-§17.7'], titulo: 'Casos de anomalia depois dos estornos e das conciliações manuais', quem: 'A:leitura', metodo: 'GET', rota: '/finance/anomaly-cases?status=OPEN', esperado: { status: 200 } });

  // Exportação financeira massiva (§17.9): MFA + auditoria + limite, pela exportação governada.
  await R.http({ id: 'H50', linhas: ['M4-§17.9'], titulo: 'Rota antiga de exportação não gera arquivo (410): exportação só pelo fluxo governado', quem: 'A:gestor', metodo: 'GET', rota: '/finance/exports/entries?competenceMonth=2030-01', esperado: { status: 410, codigo: 'GOV_EXPORT_MOVED' } });
  await R.http({ id: 'H51', linhas: ['M4-§17.9'], titulo: 'Catálogo de exportação: finance.entries com colunas, classificação, finalidades e limite', quem: 'A:gestor', metodo: 'GET', rota: '/exports/catalog', esperado: { status: 200 }, guardar: (b, c) => { const d = b.data || {}; const fin = (d.purposes || d.finalidades || []); c.finalidade = Array.isArray(fin) && fin.length ? (fin[0].code || fin[0].key || fin[0]) : 'AUDITORIA'; } });
  await R.http({ id: 'H52', linhas: ['M4-§17.9'], titulo: 'Exportação sem Idempotency-Key: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/exports', corpo: (c) => ({ resourceType: 'finance.entries', format: 'csv', purpose: c.finalidade, justification: 'Conferência mensal do financeiro pela auditoria (captura do Marco 4)', filter: {} }), esperado: { status: 400 } });
  await R.http({ id: 'H53', linhas: ['M4-§17.9', 'M4-G§20.13'], titulo: 'Exportação de lançamentos com finalidade, justificativa e MFA recente: pedido aprovado e auditado', quem: 'A:gestor', metodo: 'POST', rota: '/exports', cabecalhos: { 'Idempotency-Key': `m4-exp-${s}` }, corpo: (c) => ({ resourceType: 'finance.entries', format: 'csv', purpose: c.finalidade, justification: 'Conferência mensal do financeiro pela auditoria (captura do Marco 4)', filter: {} }), esperado: { status: [200, 201, 202] } });
  await R.http({ id: 'H54', linhas: ['M4-§17.9'], titulo: 'Perfil sem governance:dlp:export não exporta', quem: 'A:leitura', metodo: 'POST', rota: '/exports', cabecalhos: { 'Idempotency-Key': `m4-exp-l-${s}` }, corpo: (c) => ({ resourceType: 'finance.entries', format: 'csv', purpose: c.finalidade, justification: 'tentativa sem permissão de exportação', filter: {} }), esperado: { status: 403 } });
};
