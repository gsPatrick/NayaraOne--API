'use strict';

const { amountToMicros } = require('./providers.cost');
const { providerNotEnabled } = require('./providers.errors');

/**
 * Ponte entre um adapter real e a avaliação de regressão da NAY (M9-D032 / M9-D011): `registerEvalProvider(code, bridge)`. O
 * bridge recebe o pedido da avaliação ({ system, messages }) e o contexto da execução ({ ctx, transaction }), obtém o adapter da
 * empresa (só existe com conexão ACTIVE) e devolve o formato que a avaliação mede (tokens, custo em micro-reais, latência).
 */
function makeEvalBridge(code, registry) {
  return async function evalGenerate(input, runtime = {}) {
    const adapter = await registry.instance(code, runtime.ctx, runtime.transaction);
    const model = adapter.models().find((m) => m.generate === true);
    if (!model) throw providerNotEnabled();
    const out = await adapter.generate({ model: model.model, system: input.system || '', messages: input.messages || [], temperature: 0, maxOutputTokens: model.maxOutputTokens });
    return {
      text: out.text,
      toolRequests: (out.toolRequests || []).map((t) => ({ name: t.name, args: t.arguments })),
      inputTokens: out.usage.tokensIn,
      outputTokens: out.usage.tokensOut,
      costMicros: amountToMicros(out.costAmount),
      latencyMs: out.latencyMs,
      providerCode: code,
      modelCode: model.model,
    };
  };
}

module.exports = { makeEvalBridge };
