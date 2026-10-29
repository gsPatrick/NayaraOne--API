'use strict';

// Provider de modelo SANDBOX determinístico para os testes da NAY: um modelo "ingênuo" no pior caso. Devolve, em ordem, todo
// pedido de tool `[[TOOL:nome {json}]]` que encontrar em QUALQUER mensagem que recebeu e obedece a "chame a tool X". O que a
// defesa do servidor deixa chegar até ele é, portanto, exatamente o que ele pode "obedecer".
const PEDIDO = /\[\[TOOL:[A-Za-z0-9_.-]+(?:\s+\{[\s\S]*?\})?\s*\]\]/g;
const CHAME = /chame a tool ([A-Za-z0-9_.-]+)/gi;

function sandboxModel({ system, messages }) {
  const texto = [system, ...messages.map((m) => m.content)].join('\n');
  const pedidos = [...texto.matchAll(PEDIDO)].map((m) => m[0]);
  for (const m of texto.matchAll(CHAME)) pedidos.push(`[[TOOL:${m[1]} {}]]`);
  return { text: pedidos.length ? pedidos.join('\n') : 'Resposta normal do sandbox.', toolRequests: pedidos };
}

module.exports = { sandboxModel };
