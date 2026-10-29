'use strict';

/**
 * Porta `toolCallStore.record(linha, transaction)` do gravador de segurança (M9-D017) ligada a `ai.tool_calls` (M9-D006).
 * Um store por chamada de tool: a primeira linha recebida faz o `claim` implícito (REQUESTED com argumentos sanitizados e hash)
 * e leva a mesma linha ao estado pedido; as seguintes (por exemplo, o executor gravando SUCCEEDED depois da autorização)
 * andam a MESMA linha, nunca criam outra. Chamada já registrada com a mesma chave (replay) não regrava nada.
 */
const { createToolCallRecorder } = require('./toolCallRecorder');

function createToolCallStore({ execCtx, registry }) {
  let recorder = null;
  let replayed = false;

  async function record(linha, transaction) {
    if (replayed) return null;
    if (!recorder) {
      if (!execCtx || !execCtx.runId) return null;
      const userId = execCtx.actor && execCtx.actor.type === 'USER' ? execCtx.actor.userId : null;
      const ctx = { groupId: execCtx.groupId, companyId: execCtx.companyId, userId };
      recorder = createToolCallRecorder({ ctx, transaction, runId: execCtx.runId });
      const tool = registry && typeof registry.get === 'function' ? registry.get(linha.toolName) : null;
      const claim = await recorder.claim({ toolName: linha.toolName, tool: tool || undefined, args: linha.args || {} });
      if (claim.replayed) {
        replayed = true;
        return null;
      }
    }
    return recorder.record(linha);
  }

  return { record, get current() { return recorder ? recorder.current : null; } };
}

module.exports = { createToolCallStore };
