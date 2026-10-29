'use strict';

// Fábricas dos testes do grounding (M9-D025) e dos números (M9-D026): fontes, payload financeiro e um modelo "sandbox" roteirizado
// (determinístico: devolve as saídas na ordem e conta as chamadas; nunca chama fornecedor).

const crypto = require('node:crypto');

const AGORA = '2026-10-27T17:05:00.000Z'; // 14:05 em America/Sao_Paulo
const CONTRATO_ID = crypto.randomUUID();

/** Trecho de contrato com versão, cláusula e vigência: fonte exata para prazo crítico. */
function fonteContrato(extra = {}) {
  return {
    sourceType: 'DOCUMENT_CHUNK', sourceRef: CONTRATO_ID, title: 'Contrato de locação 123', version: '3', clause: '4.2',
    excerpt: 'Cláusula 4.2: o contrato vence em 30/11/2026, com multa de R$ 1.500,00.', classification: 'CONFIDENTIAL',
    effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: null, relevanceScore: 0.9, usedInAnswer: true, retrievedAt: AGORA,
    statusAtRetrieval: 'VIGENTE', ...extra,
  };
}

/** Fonte de read model (valor exato, sem pontuação de relevância). */
function fonteReadModel(extra = {}) {
  return {
    sourceType: 'READ_MODEL', sourceRef: 'finance.getWeeklyHealthReport', title: 'Saúde financeira', version: null,
    excerpt: 'Inadimplência: R$ 18.432,50 em 7 parcelas', classification: 'INTERNAL', relevanceScore: null, usedInAnswer: true,
    retrievedAt: AGORA, statusAtRetrieval: 'VIGENTE', ...extra,
  };
}

/** numbersPayload do exemplo do livro: R$ 18.432,50 em 7 parcelas. */
function payloadInadimplencia() {
  const base = { source: 'finance.getWeeklyHealthReport', asOf: AGORA };
  return [
    { ref: 'inad_valor', label: 'Inadimplência', value: '18432.50', unit: 'BRL', ...base },
    { ref: 'inad_parcelas', label: 'Parcelas', value: '7', unit: 'un', ...base },
  ];
}

/** Modelo falso roteirizado: cada chamada devolve a próxima saída; chamar além do roteiro é erro do teste. */
function modeloSandbox(saidas) {
  const chamadas = [];
  const fn = async (entrada) => {
    chamadas.push(entrada);
    if (chamadas.length > saidas.length) throw new Error('o modelo foi chamado mais vezes do que o roteiro prevê');
    return saidas[chamadas.length - 1];
  };
  fn.chamadas = chamadas;
  return fn;
}

const CONFIG_PADRAO = Object.freeze({});

module.exports = { AGORA, CONTRATO_ID, fonteContrato, fonteReadModel, payloadInadimplencia, modeloSandbox, CONFIG_PADRAO };
