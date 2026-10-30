'use strict';

const { ler, posicao, linhaDe } = require('./source');

const NOME = 'guard_no_blind_retry';
const OUTCOME = 'publications/worker/worker.outcome.js';
const CALL = 'publications/worker/worker.call.js';
const RECONCILE = 'publications/worker/worker.reconcile.js';

/** Corpo da função `nome` (da assinatura até a próxima função de topo). */
function corpo(texto, nome) {
  const inicio = texto.search(new RegExp(`async function ${nome}\\b`));
  if (inicio === -1) return null;
  const fim = texto.indexOf('\nasync function', inicio + 10);
  return { texto: texto.slice(inicio, fim === -1 ? undefined : fim), inicio };
}

/** Timeout vira UNKNOWN; só a reconciliação (findByIdempotencyKey) devolve o job a PENDING; o envio não tem laço de nova tentativa. */
function verificar(raiz) {
  const problemas = [];
  const outcome = ler(raiz, OUTCOME);
  const unknown = outcome && corpo(outcome, 'markUnknown');
  if (!unknown) problemas.push({ arquivo: OUTCOME, linha: 1, regra: 'markUnknown (timeout ou resposta incerta vira UNKNOWN) não existe' });
  else if (!/status:\s*'UNKNOWN'/.test(unknown.texto) || /status:\s*'PENDING'/.test(unknown.texto)) {
    problemas.push({ arquivo: OUTCOME, linha: linhaDe(outcome, unknown.inicio), regra: 'o timeout deve deixar o job em UNKNOWN; voltar a PENDING sem consultar o canal é retry cego e pode duplicar o post' });
  }
  const call = ler(raiz, CALL);
  if (call !== null && /\b(?:for|while)\s*\(|\bsetInterval\(|\bretry\w*\(/.test(call)) {
    problemas.push({ arquivo: CALL, linha: linhaDe(call, call.search(/\b(?:for|while)\s*\(|\bsetInterval\(|\bretry\w*\(/)), regra: 'o envio ao canal não pode ter laço de nova tentativa; depois do timeout só a reconciliação decide' });
  }
  const reconcile = ler(raiz, RECONCILE);
  if (reconcile === null) problemas.push({ arquivo: RECONCILE, linha: 1, regra: 'a reconciliação por chave de idempotência não existe' });
  else {
    const consulta = posicao(reconcile, /findByIdempotencyKey\(/);
    const volta = posicao(reconcile, /status:\s*'PENDING'/);
    if (consulta === -1 || (volta !== -1 && consulta > volta)) problemas.push({ arquivo: RECONCILE, linha: linhaDe(reconcile, Math.max(volta, 0)), regra: 'o job só volta a PENDING depois de findByIdempotencyKey confirmar que o post não existe' });
  }
  return problemas;
}

module.exports = { NOME, verificar };
