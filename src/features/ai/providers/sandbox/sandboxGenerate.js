'use strict';

// Provider SANDBOX determinístico da NAY (código `ai-sandbox`): nunca acessa a rede, a resposta é função pura da entrada.
// Fixtures no último `user`: `[[ECO]] x` devolve x; `[[TOOL:nome:{json}]]` devolve um pedido de tool; `[[CUSTO:valor]]` define o
// custo em reais; `[[LENTO:ms]]` define a latência informada. Sem fixture: texto derivado do hash. Custo = tokens x preço de
// teste fixo (micro-reais por token), em inteiros: sem ponto flutuante. O ProviderRegistry (M9-D011) envolve esta função.
const crypto = require('node:crypto');

const SANDBOX_PRICE_IN_MICROS = 2;
const SANDBOX_PRICE_OUT_MICROS = 6;
const ECO = /^\s*\[\[ECO\]\]\s*([\s\S]*)$/;
const TOOL = /\[\[TOOL:([A-Za-z0-9_.-]+)(?::(\{[\s\S]*?\}))?\]\]/g;
const CUSTO = /\[\[CUSTO:([0-9]+(?:[.,][0-9]{1,6})?)\]\]/;
const LENTO = /\[\[LENTO:([0-9]{1,7})\]\]/;

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tokensOf = (t) => Math.ceil(String(t).length / 4);

function microsOf(texto) {
  const [inteiro, fracao = ''] = texto.replace(',', '.').split('.');
  return Number(inteiro) * 1000000 + Number(fracao.padEnd(6, '0'));
}

function parseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

/** generate({ system, messages }) -> { text, toolRequests, inputTokens, outputTokens, costMicros, latencyMs }. */
function sandboxGenerate({ system = '', messages = [] } = {}) {
  const ultimoUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const entrada = ultimoUser ? String(ultimoUser.content || '') : '';
  const digest = hash(`${system}\n${messages.map((m) => `${m.role}:${m.content}`).join('\n')}`);
  const toolRequests = [...entrada.matchAll(TOOL)].map((m) => ({ name: m[1], args: parseArgs(m[2]) }));
  const eco = ECO.exec(entrada);
  let text;
  if (eco) text = eco[1].replace(CUSTO, '').replace(LENTO, '').trim();
  else if (toolRequests.length) text = '';
  else text = `Resposta de teste ${digest.slice(0, 8)}.`;
  const inputTokens = tokensOf(`${system}${entrada}`);
  const outputTokens = tokensOf(text);
  const custo = CUSTO.exec(entrada);
  const lento = LENTO.exec(entrada);
  return {
    text,
    toolRequests,
    inputTokens,
    outputTokens,
    costMicros: custo ? microsOf(custo[1]) : inputTokens * SANDBOX_PRICE_IN_MICROS + outputTokens * SANDBOX_PRICE_OUT_MICROS,
    latencyMs: lento ? Number(lento[1]) : 20 + (parseInt(digest.slice(0, 4), 16) % 80),
    providerCode: 'ai-sandbox',
    modelCode: 'sandbox-1',
  };
}

module.exports = { sandboxGenerate, SANDBOX_PRICE_IN_MICROS, SANDBOX_PRICE_OUT_MICROS };
