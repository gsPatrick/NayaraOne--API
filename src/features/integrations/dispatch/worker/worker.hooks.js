'use strict';

/**
 * Pontos de extensão do worker de envios (M9-D214). Cada política de falha ou de espera entra aqui por registro, sem o worker
 * conhecer o módulo que a implementa:
 *  - preflight(ctx): verificações ANTES de gastar tentativa (retorna { until, reason } para esperar, ou null para seguir);
 *  - afterCall(ctx): observação de cada resposta ou erro (cota do fornecedor);
 *  - failureHandler: o que fazer com uma falha já classificada (retry por classe, M9-D216).
 * Sem failureHandler registrado, a falha leva o envio a FAILED com a classe gravada e sem nova tentativa: a escolha segura.
 */
const preflights = [];
const observers = [];
let failureHandler = null;

const registerPreflight = (fn) => { preflights.push(fn); return () => { const i = preflights.indexOf(fn); if (i >= 0) preflights.splice(i, 1); }; };
const registerCallObserver = (fn) => { observers.push(fn); return () => { const i = observers.indexOf(fn); if (i >= 0) observers.splice(i, 1); }; };
const registerFailureHandler = (fn) => { failureHandler = fn; };

const getPreflights = () => [...preflights];
const getCallObservers = () => [...observers];
const getFailureHandler = () => failureHandler;

module.exports = { registerPreflight, registerCallObserver, registerFailureHandler, getPreflights, getCallObservers, getFailureHandler };
