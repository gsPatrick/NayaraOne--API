'use strict';

const logger = require('../../../../utils/logger');
const { getSetting } = require('../../../settings/settings.service');
const { bodyHash } = require('./idempotency.hash');
const repository = require('./idempotency.repository');
const S = require('./standards.settings');
const E = require('./standards.errors');

/**
 * Idempotência HTTP (M9-D843 §3.3). `Idempotency-Key` (8 a 128 caracteres) em criações e ações sensíveis; exigida nas rotas da lista fechada (idempotency.routes.js), opcional nas demais.
 * Mesma chave + mesmo corpo dentro da validade devolve a resposta ORIGINAL (cabeçalho `Idempotent-Replay: true`) sem repetir o efeito; mesma chave com outro corpo, 422
 * GOV_IDEMPOTENCY_KEY_REUSED. Como funciona: a chave é reivindicada na MESMA transação do efeito (o primeiro `req.withTenantTransaction` da requisição; se o efeito desfaz, a chave some)
 * e a resposta é gravada logo antes de sair. Duas chamadas simultâneas: o INSERT da segunda espera a primeira terminar e então devolve a resposta dela, sem segundo efeito.
 */
class IdempotentReplay extends Error {
  constructor(status, body) { super('idempotent replay'); this.name = 'IdempotentReplay'; this.status = status; this.body = body; }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const POLL_MS = 100;

async function claimOrReplay(state, tenant, transaction) {
  const hours = Number(await getSetting(S.IDEM_HOURS_KEY, tenant, transaction, S.STANDARDS_SETTING_DEFAULTS[S.IDEM_HOURS_KEY]));
  const waitSeconds = Number(await getSetting(S.IDEM_WAIT_KEY, tenant, transaction, S.STANDARDS_SETTING_DEFAULTS[S.IDEM_WAIT_KEY]));
  await repository.deleteExpired(tenant.companyId, state.scope, state.key, transaction);
  const won = await repository.claim({ ...tenant, scope: state.scope, key: state.key, requestHash: state.hash, validityHours: hours }, transaction);
  if (won) { state.won = true; return; }
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const row = await repository.find(tenant.companyId, state.scope, state.key, transaction);
    if (!row) return; // a chave sumiu (a transação dona desfez): segue como se fosse a primeira
    if (row.requestHash !== state.hash) throw E.keyReused();
    if (row.responseStatus) throw new IdempotentReplay(row.responseStatus, row.responseBody);
    if (Date.now() >= deadline) throw E.responsePending();
    await sleep(POLL_MS);
  }
}

function validKey(raw) {
  const key = String(raw).trim();
  if (key.length < 8 || key.length > 128) throw E.keyInvalid();
  return key;
}

/** Middleware da rota. `required` = a chave é obrigatória (400 GOV_IDEMPOTENCY_KEY_REQUIRED sem ela). */
function idempotency({ required = false } = {}) {
  return function idempotencyMiddleware(req, res, next) {
    try {
      const raw = req.get('Idempotency-Key');
      if (raw === undefined || !String(raw).trim()) { if (required) throw E.keyRequired(); return next(); }
      const key = validKey(raw);
      if (!req.auth || typeof req.withTenantTransaction !== 'function') return next();
      const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
      const state = { key, hash: bodyHash(req.body), scope: `${req.auth.userId}:${req.method} ${req.route ? req.route.path : req.path}`, claimed: false, won: false };
      const original = req.withTenantTransaction;
      req.withTenantTransaction = (fn) => original(async (transaction) => {
        if (!state.claimed) { state.claimed = true; await claimOrReplay(state, tenant, transaction); }
        return fn(transaction);
      });
      const json = res.json.bind(res);
      res.json = (body) => {
        if (!state.won || res.statusCode >= 400) return json(body);
        // `res.locals.idempotencyStoredBody`: o handler pode guardar uma versão da resposta sem dado de exibição única (ex.: segredo de credencial); a repetição devolve essa versão.
        const stored = res.locals.idempotencyStoredBody === undefined ? body : res.locals.idempotencyStoredBody;
        repository.storeResponse({ companyId: tenant.companyId, scope: state.scope, key, status: res.statusCode, body: stored })
          .catch((err) => logger.error({ err: err.message }, 'idempotency.store.failed'))
          .finally(() => json(body));
        return res;
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * M9-D852: uma chave já usada (resposta guardada) NÃO passa pela confirmação de novo: o impacto já mudou por causa do próprio efeito e o cliente só quer a resposta
 * original (mesmo corpo) ou a recusa 422 GOV_IDEMPOTENCY_KEY_REUSED (outro corpo), decididas pela idempotência. Devolve true quando existe resposta guardada para a chave.
 */
async function hasStoredReplay(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined || !String(raw).trim() || !req.auth || typeof req.withTenantTransaction !== 'function') return false;
  const key = String(raw).trim();
  if (key.length < 8 || key.length > 128) return false;
  const scope = `${req.auth.userId}:${req.method} ${req.route ? req.route.path : req.path}`;
  const row = await req.withTenantTransaction((transaction) => repository.find(req.auth.companyId, scope, key, transaction));
  return Boolean(row && row.responseStatus);
}

/** Tratador de erro do router: devolve a resposta original de uma repetição (a transação já foi desfeita, nenhum efeito aconteceu). */
function replayErrorHandler(err, _req, res, next) {
  if (!(err instanceof IdempotentReplay)) return next(err);
  res.set('Idempotent-Replay', 'true');
  return res.status(err.status).json(err.body);
}

module.exports = { idempotency, replayErrorHandler, hasStoredReplay, IdempotentReplay };
