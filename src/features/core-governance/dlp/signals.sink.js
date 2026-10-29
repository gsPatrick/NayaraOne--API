'use strict';

/**
 * Destino do `access_signal` (M9-D821 §3.1b; dona: M9-D824, detecção de anomalia). Cada decisão do guard (leve: VIEW, COPY, AI; completa: EXPORT, SHARE, PRINT) entrega um sinal
 * { actorUserId, action, classification, decision, blockReason, resourceType, occurredAt }. Sem a M9-D824, o destino padrão não faz nada.
 * A M9-D824 troca o destino chamando `setSignalSink` com a mesma assinatura: sink(tenant, signal, transaction) -> Promise<void>.
 */
const discard = async () => {};
let current = discard;

const setSignalSink = (fn) => { current = fn; };
const resetSignalSink = () => { current = discard; };
const emitSignal = (tenant, signal, transaction) => current(tenant, signal, transaction);

module.exports = { setSignalSink, resetSignalSink, emitSignal };
