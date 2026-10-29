'use strict';

// M9-D020 — o gravador de UMA chamada de tool do orquestrador: o gravador de segurança da D017 (auditoria + evento do bloqueio) sobre
// a porta de ai.tool_calls da D006 (`createToolCallRecorder`, um por chamada), com o `seq` FIXO da chamada. O executor (D002) reivindica
// a linha antes de executar (`claim`): repetir o mesmo `seq` com os mesmos argumentos é o replay (devolve o resultado anterior, sem
// executar de novo; em andamento é 409 AI_TOOL_CALL_IN_PROGRESS). Uma tool que falha NÃO desfaz a transação do run: a linha FAILED persiste.

const { createToolCallStore } = require('../tools/toolCallStore');
const { createSecurityRecorder } = require('./securityRecorder');

function createCallRecorder({ execCtx, registry, agentCode, requestText, transaction, args, seq }) {
  const store = createToolCallStore({ execCtx, registry, seq });
  const security = createSecurityRecorder({ execCtx, agentCode, requestText, transaction, toolCallStore: store, args });
  return {
    record: security.record,
    emit: security.emit,
    claim: (params) => store.claim(params, transaction),
    get store() { return store; },
  };
}

module.exports = { createCallRecorder };
