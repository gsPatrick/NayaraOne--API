'use strict';

/**
 * Proteção do fluxo operacional contra a leitura do BI (livro, BI §19 "consultas OLTP críticas protegidas" e §21 "Dashboard pesado não degrada
 * OLTP em teste de carga"; achado da carga em escala cheia da etapa 13, 16/11/2026).
 *
 * Sem limite, cada GET de BI abria a sua transação no mesmo banco do fluxo operacional: 8 pessoas abrindo painéis e detalhes mantinham 8 sessões
 * do BI ocupando o banco ao mesmo tempo (cerca de 2.500 consultas por segundo) e o p95 de criar, liquidar e mover registro subia de 2 para 6 a 9 ms.
 * Esta porta limita quantas transações de leitura do BI rodam ao mesmo tempo NESTE processo da API; as demais esperam a vez na fila, em ordem
 * de chegada, sem ocupar o banco. Quem espera mais que o tempo máximo de consulta do BI (analytics.consulta.timeout_ms) recebe 503
 * ANALYTICS_READ_BUSY ("tente de novo"), em vez de uma fila sem fim.
 *
 * Limite: parâmetro do administrador analytics.consulta.max_simultaneas (padrão 3, aba "BI e Centro de Comando"). O livro não dá número; 3 deixa
 * a maior parte dos núcleos do banco para o fluxo operacional e mantém os painéis dentro das metas p95 na carga em escala cheia. O valor é lido na
 * transação do próprio GET (contexto da empresa) no máximo a cada `RELEITURA_MS` e vale a partir do GET seguinte. Reentrante por requisição:
 * a requisição que já tem a vez não pede outra (sem trava em transação dentro de transação).
 */
const PADRAO_LIMITE = 3;
const PADRAO_ESPERA_MS = 10000;
const RELEITURA_MS = 30000;

function createGate({ limite = PADRAO_LIMITE, esperaMaxMs = PADRAO_ESPERA_MS, agora = () => Date.now() } = {}) {
  let max = limite;
  let espera = esperaMaxMs;
  let ativos = 0;
  let lidoEm = -Infinity;
  const fila = [];
  const stats = { atendidos: 0, esperaram: 0, recusados: 0, maxFila: 0 };

  function liberar() {
    ativos -= 1;
    while (ativos < max && fila.length) {
      const proximo = fila.shift();
      clearTimeout(proximo.timer);
      ativos += 1;
      proximo.resolve();
    }
  }

  /** Espera a vez. Devolve a função que devolve a vez (chamar uma vez só). Estoura a espera: rejeita com erro `code = 'ANALYTICS_READ_BUSY'`. */
  function entrar() {
    stats.atendidos += 1;
    let devolvido = false;
    const sair = () => { if (!devolvido) { devolvido = true; liberar(); } };
    if (ativos < max) { ativos += 1; return Promise.resolve(sair); }
    stats.esperaram += 1;
    return new Promise((resolve, reject) => {
      const item = { resolve: () => resolve(sair) };
      item.timer = setTimeout(() => {
        const i = fila.indexOf(item);
        if (i >= 0) fila.splice(i, 1);
        stats.recusados += 1;
        const err = new Error('Leitura do BI ocupada: tente de novo em instantes.');
        err.code = 'ANALYTICS_READ_BUSY';
        reject(err);
      }, espera);
      fila.push(item);
      stats.maxFila = Math.max(stats.maxFila, fila.length);
    });
  }

  /** Atualiza o limite e a espera (valores do parâmetro); quem estava na fila entra se abriu vaga. */
  function configurar({ limite: novoLimite, esperaMaxMs: novaEspera } = {}) {
    if (Number.isInteger(novoLimite) && novoLimite >= 1) max = novoLimite;
    if (Number.isInteger(novaEspera) && novaEspera >= 1) espera = novaEspera;
    lidoEm = agora();
    while (ativos < max && fila.length) { const p = fila.shift(); clearTimeout(p.timer); ativos += 1; p.resolve(); }
  }

  return {
    entrar, configurar,
    precisaReler: () => agora() - lidoEm >= RELEITURA_MS,
    esquecer: () => { lidoEm = -Infinity; }, // a próxima transação relê o parâmetro (teste e troca de parâmetro)
    estado: () => ({ limite: max, esperaMaxMs: espera, ativos, naFila: fila.length, ...stats }),
  };
}

const gate = createGate();

module.exports = { createGate, gate, PADRAO_LIMITE, PADRAO_ESPERA_MS, RELEITURA_MS };
