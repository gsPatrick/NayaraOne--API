'use strict';

// Provider SANDBOX determinístico da NAY (código `ai-sandbox`): nunca acessa a rede, a resposta é função pura da entrada.
// Fixtures no último `user`: `[[ECO]] x` devolve x; `[[JSON:{...}]]` devolve o JSON; `[[TOOL:nome:{json}]]` devolve um pedido de tool; `[[CUSTO:valor]]` define o
// custo em reais; `[[LENTO:ms]]` define a latência informada; `[[RESPOSTA:texto]]` define o texto da resposta final; `[[TOOL!:nome:{json}]]`
// pede a tool em TODA volta (modelo insistente, para provar o limite de voltas). Depois de um resultado de tool na conversa
// (bloco `untrusted` com origin="TOOL_RESULT") ou o aviso "Ferramenta indisponível:" no system, o `[[TOOL:...]]` comum já foi atendido e a volta seguinte responde com texto. Sem fixture: texto derivado do hash. Custo = tokens x preço de
// teste fixo (micro-reais por token), em inteiros: sem ponto flutuante. O ProviderRegistry (M9-D011) envolve esta função.
const crypto = require('node:crypto');

const SANDBOX_PRICE_IN_MICROS = 2;
const SANDBOX_PRICE_OUT_MICROS = 6;
const ECO = /^\s*\[\[ECO\]\]\s*([\s\S]*)$/;
const TOOL = /\[\[TOOL:([A-Za-z0-9_.-]+)(?::(\{[\s\S]*?\}))?\]\]/g;
const TOOL_ALWAYS = /\[\[TOOL!:([A-Za-z0-9_.-]+)(?::(\{[\s\S]*?\}))?\]\]/g;
const RESPOSTA = /\[\[RESPOSTA:([\s\S]*?)\]\]/;
const TOOL_RESULT_MARK = 'origin="TOOL_RESULT"';
const TOOL_UNAVAILABLE_MARK = 'Ferramenta indisponível:';
const JSON_FIXTURE = /\[\[JSON:(\{[\s\S]*?\}|\[[\s\S]*?\])\]\]/;
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

function jsonValido(raw) {
  try { JSON.parse(raw); return true; } catch (e) { return false; }
}

/** generate({ system, messages }) -> { text, toolRequests, inputTokens, outputTokens, costMicros, latencyMs }. */
function sandboxGenerate({ system = '', messages = [] } = {}) {
  const ultimoUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const entrada = ultimoUser ? String(ultimoUser.content || '') : '';
  const digest = hash(`${system}\n${messages.map((m) => `${m.role}:${m.content}`).join('\n')}`);
  // Resultado de tool na conversa, ou o aviso do orquestrador de que a ferramenta está indisponível: o pedido comum já foi atendido.
  const jaTeveResultado = messages.some((m) => m && String(m.content || '').includes(TOOL_RESULT_MARK)) || String(system).includes(TOOL_UNAVAILABLE_MARK);
  const pedidos = [...(jaTeveResultado ? [] : entrada.matchAll(TOOL)), ...entrada.matchAll(TOOL_ALWAYS)];
  const toolRequests = pedidos.map((m) => ({ name: m[1], args: parseArgs(m[2]) }));
  const resposta = RESPOSTA.exec(entrada);
  const eco = ECO.exec(entrada);
  const fixtureJson = JSON_FIXTURE.exec(entrada);
  let text;
  if (eco) text = eco[1].replace(CUSTO, '').replace(LENTO, '').trim();
  else if (fixtureJson && jsonValido(fixtureJson[1])) text = fixtureJson[1];
  else if (toolRequests.length) text = '';
  else if (resposta) text = resposta[1].trim();
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
    fixedCost: Boolean(custo),
    latencyMs: lento ? Number(lento[1]) : 20 + (parseInt(digest.slice(0, 4), 16) % 80),
    digest,
    providerCode: 'ai-sandbox',
    modelCode: 'sandbox-1',
  };
}

module.exports = { sandboxGenerate, SANDBOX_PRICE_IN_MICROS, SANDBOX_PRICE_OUT_MICROS };
