'use strict';

/**
 * Ponto de entrega do envio incerto à reconciliação (M9-D215 consulta o fornecedor antes de qualquer repetição). A política de
 * retry (M9-D216) só decide QUE o envio é UNKNOWN e o entrega a quem se registrou aqui; ela nunca repete uma operação perigosa.
 */
let reconciler = null;

const registerUnknownReconciler = (fn) => { reconciler = typeof fn === 'function' ? fn : null; };
const getUnknownReconciler = () => reconciler;

module.exports = { registerUnknownReconciler, getUnknownReconciler };
