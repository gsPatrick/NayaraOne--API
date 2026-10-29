'use strict';

// Fluxo comum dos testes de aprovação da M9-D019: a NAY propõe o pagamento (parâmetro Ligado) e uma pessoa decide.

const { cenario, pedir, argsPagamento, setParam, lancamentoAPagar, ctxAprovador, abrirRun } = require('./iaAprovacao');

/** Cenário + proposta de pagamento criada pelo solicitante. Devolve { c, id } (id = recomendação). */
async function propor(tenant, tx, { tool = 'finance.proposePayment', args, solicitante } = {}) {
  await setParam(tenant, tx, 'ia.financeira.permitir_proposta_pagamento', true);
  const c = await cenario(tenant, tx, { solicitante });
  const { res, err } = await pedir(tenant, tx, c, { tool, args: args || argsPagamento(c) });
  if (err) throw err;
  return { c, id: res.proposal.id };
}

/** Outra proposta de pagamento no mesmo cenário (novo lançamento e novo run do mesmo solicitante). */
async function proporOutra(tenant, tx, c) {
  const entry = await lancamentoAPagar(tenant, tx, 800);
  const runId = await abrirRun(tenant, tx, c.solicitante, c.agent.code);
  const { res, err } = await pedir(tenant, tx, c, { tool: 'finance.proposePayment', args: { financialEntryId: entry.id }, runId });
  if (err) throw err;
  return { entry, runId, id: res.proposal.id };
}

const aprovador = (tenant, c, extra = {}) => ({ ...ctxAprovador(tenant, c.aprovador), ...extra });

module.exports = { propor, proporOutra, aprovador };
