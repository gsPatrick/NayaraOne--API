'use strict';

const adapterRegistry = require('../../registry/adapterRegistry');
const { runHealthCheck } = require('../../registry/adapterHealth');
const { invoke } = require('../../registry/adapterInvoke');
const { readConnectionSecret } = require('../../secrets/secretReader');
const { SecretValue } = require('../../secrets/SecretValue');
const { sanitizeText } = require('../../errors/sanitizeForError');

const TLS_RE = /(certificad|tls|ssl|handshake|self[- ]signed|cert_)/i;

/** Mensagem de erro segura: só texto de erro de negócio (AppError, já em português e sem segredo); qualquer outra falha vira a frase genérica. */
const mensagemSegura = (err, padrao) => (err && err.isOperational && err.message ? sanitizeText(err.message, 200) : padrao);

/** Operações marcadas como consulta inócua (safeProbe) que o adapter suporta. NUNCA uma operação mutável: a marca só existe nas consultas sem campo obrigatório. */
function safeProbeOperations(adapter) {
  const operacoes = adapter.constructor.operations || {};
  const suportadas = adapter.capabilities();
  return Object.keys(operacoes).filter((nome) => operacoes[nome].safeProbe === true && suportadas.includes(nome));
}

/** auth: provedor real precisa de credencial gravada e legível (cofre); sandbox não usa. Devolve { ok, message, secrets } (os textos secretos só servem para limpar a resposta). */
async function checkAuth(connection, provider, tenant, transaction, override) {
  if (override) return { ok: true, secrets: [override.value] };
  if (provider.sandboxAvailable === true) return { ok: true, secrets: [] };
  if (!connection.secretRef) return { ok: false, message: 'A credencial da integração não foi informada.', secrets: [] };
  try {
    const entrega = await readConnectionSecret(connection, tenant, { purpose: 'test-connection', transaction });
    return { ok: true, secrets: [entrega.value.reveal()] };
  } catch (err) {
    return { ok: false, message: mensagemSegura(err, 'Não foi possível ler a credencial da integração.'), secrets: [] };
  }
}

/** O adapter da connection, com o tempo do teste e, na rotação, o segredo candidato no lugar do gravado (nunca sai daqui). */
async function buildProbeAdapter(connection, tenant, transaction, { timeoutMs, secretOverride }) {
  const adapter = await adapterRegistry.resolve(connection, tenant, transaction);
  const ctx = { ...adapter.ctx, healthCheckTimeoutMs: timeoutMs };
  if (secretOverride) ctx.secret = async () => ({ value: new SecretValue(secretOverride.value), version: secretOverride.version, expiresAt: null });
  adapter.ctx = Object.freeze(ctx);
  return adapter;
}

/** A chamada de leitura inócua do adapter (se houver); falha dela reprova a saúde. Devolve { ok, ran }. */
async function runSafeProbe(adapter, tenant, transaction, remainingMs) {
  const [operacao] = safeProbeOperations(adapter);
  if (!operacao) return { ok: true, ran: false };
  let timer;
  try {
    await Promise.race([
      invoke(adapter, operacao, {}, { tenant, transaction }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tempo esgotado')), Math.max(1, remainingMs)); }),
    ]);
    return { ok: true, ran: true };
  } catch (err) {
    return { ok: false, ran: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * runConnectionProbe — o corpo do teste de conexão (M9-D250 3.2): auth, saúde (healthCheck do adapter + a consulta inócua) e TLS. Nunca lança: a falha vira
 * `ok:false` com motivo em português. Não chama operação mutável e não envia mensagem. A resposta não traz segredo (mensagens fixas ou saneadas).
 */
async function runConnectionProbe(connection, provider, tenant, transaction, { timeoutMs, secretOverride = null } = {}) {
  const started = Date.now();
  const auth = await checkAuth(connection, provider, tenant, transaction, secretOverride);
  let health = { ok: false };
  let message = null;
  // Credencial ausente ou ilegível: o fornecedor nem é chamado (não se bate na porta do fornecedor sem chave).
  if (auth.ok) {
    try {
      const adapter = await buildProbeAdapter(connection, tenant, transaction, { timeoutMs, secretOverride });
      const check = await runHealthCheck(adapter, tenant, transaction);
      health = { ok: check.ok === true };
      message = check.detail || null;
      if (health.ok) {
        const probe = await runSafeProbe(adapter, tenant, transaction, timeoutMs - (Date.now() - started));
        if (!probe.ok) { health = { ok: false }; message = 'A consulta de leitura de teste ao fornecedor falhou.'; }
      }
    } catch (err) {
      message = mensagemSegura(err, 'Não foi possível preparar o teste com este fornecedor.');
    }
  }
  // TLS: sandbox não usa rede; em fornecedor real a conexão segura falha quando o motivo dito pelo teste aponta para certificado ou TLS.
  const tls = { ok: !(provider.sandboxAvailable !== true && !health.ok && TLS_RE.test(String(message || ''))) };
  const ok = auth.ok && tls.ok && health.ok;
  const bruto = ok ? 'A integração respondeu ao teste.' : (auth.ok ? (message || 'O fornecedor não respondeu ao teste de saúde.') : auth.message);
  // Defesa em profundidade: o texto da credencial, se o fornecedor o ecoar numa mensagem, nunca sai.
  const texto = sanitizeText(auth.secrets.filter(Boolean).reduce((t, segredo) => t.split(segredo).join('[removido]'), bruto), 300);
  return {
    ok, latencyMs: Math.max(0, Date.now() - started),
    checks: [{ name: 'auth', ok: auth.ok }, { name: 'tls', ok: tls.ok }, { name: 'health', ok: health.ok }],
    message: texto,
  };
}

module.exports = { runConnectionProbe, safeProbeOperations };
