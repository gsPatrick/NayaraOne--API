'use strict';

const Layer = require('express/lib/router/layer');
const { conferirConsulta } = require('./queryContract');

/**
 * Aplica o contrato da consulta (queryContract.js, DI-M9R-24) a TODAS as rotas de um router, inclusive dos routers montados dentro dele.
 *
 * Para cada rota, a conferência entra logo antes do último handler (o controller): depois da autenticação, da permissão e das validações próprias
 * da rota (que mantêm o código de erro do módulo para o que conferem) e antes de qualquer leitura da consulta pelo serviço. Os parâmetros que a rota
 * aceita como lista vêm das declarações nos handlers dela: `declararConsulta({ listas })` (propriedade `listasDaConsulta`) e os esquemas de consulta
 * de `validarEntrada` (propriedade `listasDaConsulta`, derivada dos campos do tipo `array`). Rota nova montada no agregador recebe o contrato sem
 * precisar lembrar dele. Idempotente (cada rota recebe a conferência uma vez).
 */
const MARCA = Symbol.for('nayara.contratoDaConsulta');

function listasDaRota(route) {
  const listas = new Set();
  for (const camada of route.stack) for (const nome of (camada.handle && camada.handle.listasDaConsulta) || []) listas.add(nome);
  return [...listas];
}

function camadaDoContrato(listas) {
  const conferir = function contratoDaConsulta(req, _res, next) {
    const problema = conferirConsulta(req.query, { listas });
    return problema ? next(problema) : next();
  };
  const camada = new Layer('/', {}, conferir);
  camada.method = undefined; // vale para o método da rota (a camada só roda quando a rota já casou)
  camada.contratoDaConsulta = true;
  return camada;
}

function aplicarNaRota(route) {
  if (route[MARCA]) return 0;
  route[MARCA] = true;
  let ultimo = -1;
  for (let i = route.stack.length - 1; i >= 0; i -= 1) {
    if (route.stack[i].handle && route.stack[i].handle.length < 4) { ultimo = i; break; }
  }
  if (ultimo < 0) return 0;
  route.stack.splice(ultimo, 0, camadaDoContrato(listasDaRota(route)));
  return 1;
}

/** Percorre o router; devolve quantas rotas receberam o contrato. */
function aplicarContratoDaConsulta(router) {
  let n = 0;
  const pilha = [router.stack];
  while (pilha.length > 0) {
    for (const camada of pilha.pop()) {
      if (camada.route) n += aplicarNaRota(camada.route);
      else if (camada.handle && Array.isArray(camada.handle.stack)) pilha.push(camada.handle.stack);
    }
  }
  return n;
}

module.exports = { aplicarContratoDaConsulta };
