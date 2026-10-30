'use strict';

/**
 * Textos do livro e escopos da autochecagem (M9-D258). Guia de Integrações, seção 15 (livro 511 a 514) e Guia da IA NAY (livro 273 a 277, só a primeira pergunta:
 * a M9-D258 é a dona única do cálculo de "Marcelo consegue fazer sozinho?" para os dois blocos). O texto das perguntas e das respostas é o do livro, palavra por palavra.
 */
const CODIGO = 'INTEGRATION_DOD_AUTOCHECK_FAILED';

const PERGUNTAS = Object.freeze({
  1: { texto: 'Marcelo consegue fazer sozinho?', resposta: 'SIM.' },
  2: { texto: 'Está blindado?', resposta: 'SIM para brechas previsíveis, condicionado a homologação por provider' },
  3: { texto: 'Tem caminho técnico?', resposta: 'SIM: framework, adapters, webhooks, retry, CI, tests e sprints.' },
  4: { texto: 'Outro programador assume?', resposta: 'SIM.' },
});

/** Mensagem de reprovação de cada pergunta (seção 4 da demanda). */
const MENSAGENS = Object.freeze({
  1: (v) => `Marcelo não consegue fazer sozinho: ${v} falhou.`,
  2: (v) => `Não está blindado: ${v} vermelho.`,
  3: (v) => `Caminho técnico incompleto: ${v}.`,
  4: (v) => `Outro programador não assume: ${v}.`,
});

const ESCOPOS = Object.freeze({
  integracoes: {
    nome: 'integracoes',
    titulo: 'Autochecagem das integrações',
    perguntas: [1, 2, 3, 4],
    respostaMarcelo: 'SIM.',
    /** Demandas do bloco B (M9-D200 a M9-D399). */
    demandas: /^M9-D[23]\d{2}$/,
    faixa: 'D200 a D399',
    relatorioOffline: 'reports/offline-run.json',
    sandbox: 'sandboxes dos providers',
  },
  'ia-nay': {
    nome: 'ia-nay',
    titulo: 'Autochecagem da IA NAY',
    perguntas: [1],
    respostaMarcelo: 'SIM, em LAB, se dominar backend e integração de APIs/LLMs.',
    /** Demandas do bloco A (M9-D001 a M9-D047). */
    demandas: /^M9-D0(?:[0-3]\d|4[0-7])$/,
    faixa: 'D001 a D047',
    relatorioOffline: 'reports/offline-run-ia.json',
    sandbox: 'provider sandbox de modelo',
    runbook: 'docs/runbooks/ai/operacao.md',
  },
});

module.exports = { CODIGO, PERGUNTAS, MENSAGENS, ESCOPOS };
