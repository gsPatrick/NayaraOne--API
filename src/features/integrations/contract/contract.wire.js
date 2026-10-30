'use strict';

/**
 * O "fornecedor" dos contract tests (M9-D222 3.1): o servidor falso que erra por pedido. A suíte coloca o fio entre o adapter e o chamador: antes da operação (falha de
 * transporte, HTTP, lentidão) ou depois dela (resposta ilegível, campo faltando, tipo errado). O adapter de laboratório não precisa de código de falha próprio; o que se prova é o
 * que é do adapter: classificar o erro, devolver a resposta normalizada, mapear status e responder à saúde. Cabeçalho de pedido `x-sandbox-fail=<tipo>` equivale a `fault`.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const httpError = (status, extra = {}) => Object.assign(new Error(`O fornecedor respondeu ${status}.`), { status, ...extra });

/** Falhas ANTES da operação: devolve a função que lança. */
const BEFORE = Object.freeze({
  http: (status, extra) => async () => { throw httpError(status, extra); },
  rateLimit: (segundos) => async () => { throw httpError(429, { headers: { 'retry-after': String(segundos) } }); },
  auth: () => async () => { throw httpError(401); },
  expiredToken: () => async () => { throw httpError(401, { code: 'TOKEN_EXPIRED', credentialInvalid: true }); },
  // O fornecedor demora o dobro do prazo da política; o cliente desiste no prazo (ETIMEDOUT), como o transporte real.
  timeout: (prazoMs) => async () => {
    await Promise.race([sleep(prazoMs * 2), sleep(prazoMs).then(() => { throw Object.assign(new Error('Tempo esgotado esperando o fornecedor.'), { code: 'ETIMEDOUT', name: 'TimeoutError' }); })]);
  },
  truncatedJson: () => async () => { JSON.parse('{"status":"SE'); },
});

/** Falhas DEPOIS da operação: alteram a resposta. */
const AFTER = Object.freeze({
  missingField: (campo = 'status') => (resposta) => { const c = { ...resposta }; delete c[campo]; return c; },
  wrongType: (campo = 'status') => (resposta) => ({ ...resposta, [campo]: 12345 }),
  unknownStatus: (campo = 'status') => (resposta) => ({ ...resposta, [campo]: 'STATUS_INEDITO_DO_FORNECEDOR' }),
});

/** Cópia do adapter em que a operação passa pelo fio: `before` (async, pode lançar) e/ou `after` (altera a resposta). A cópia herda tudo do adapter original. */
function withWire(adapter, operation, { before, after } = {}) {
  const copia = Object.create(adapter);
  copia[operation] = async (...args) => {
    if (before) await before(...args);
    const resposta = await adapter[operation](...args);
    return after ? after(resposta) : resposta;
  };
  return copia;
}

module.exports = { BEFORE, AFTER, withWire, sleep, httpError };
