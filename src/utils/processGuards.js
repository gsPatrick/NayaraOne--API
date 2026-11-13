'use strict';

const { erroParaLog } = require('../middlewares/errorHandler.safe');

/**
 * Proteção do processo da API (rodada 7, DI-M9R-19; refeita na rodada 8 da verificação do Marco 9, 12/11/2026, DI-M9R-23).
 *
 * Uma exceção sem tratamento (ou uma promessa rejeitada sem tratamento) escapa de um código que estava no meio do trabalho: um callback que ia
 * fazer o `commit` ou o `rollback`, um job que ia voltar `running = false`. Seguir atendendo nesse estado deixa a transação aberta ("idle in
 * transaction"), a linha travada e a conexão perdida do pool; com algumas falhas, o pool se esgota e a API para para TODAS as empresas com o
 * processo vivo (experimento da rodada 8). A documentação do Node diz o mesmo: depois de `uncaughtException` não é seguro retomar.
 *
 * Por isso, nas duas falhas:
 * 1. registra como FATAL, com a pilha e a origem;
 * 2. para de aceitar conexões (o servidor HTTP fecha a porta; as conexões ociosas são fechadas; as respostas em andamento saem com
 *    `Connection: close`, ver `marcarConexaoParaFechar`);
 * 3. espera os pedidos em andamento terminarem, por no máximo `PROCESS_FATAL_GRACE_MS` (padrão 10.000 ms, faixa 0 a 120.000);
 * 4. tenta fechar o pool do banco (no máximo 1 s) e sai com código 1. Ao sair, o Postgres encerra as sessões, desfaz as transações abertas e
 *    solta as travas; o supervisor (Easypanel, `restart` do contêiner) sobe um processo limpo.
 * Uma segunda falha durante o encerramento só é registrada (o encerramento já está em curso).
 *
 * Instalada só no processo do servidor (`node app.js`): os testes que carregam o app.js no próprio processo continuam com o tratamento do executor
 * de testes. Falha de configuração no boot continua encerrando o processo na hora, como antes.
 */
const PADRAO_GRACE_MS = 10000;
const FAIXA_GRACE_MS = [0, 120000];
const FECHAR_POOL_MS = 1000;

const estado = { instalada: false, encerrando: false };

/** Prazo de espera dos pedidos em andamento (variável de ambiente dentro da faixa; ausente ou inválida vale o padrão). */
function prazoDeEncerramento(env = process.env) {
  const bruto = env.PROCESS_FATAL_GRACE_MS;
  const n = Number(bruto);
  if (bruto === undefined || bruto === '' || !Number.isInteger(n) || n < FAIXA_GRACE_MS[0] || n > FAIXA_GRACE_MS[1]) return PADRAO_GRACE_MS;
  return n;
}

/** true depois da primeira falha fatal: a rota de saúde responde 503 e as respostas saem com `Connection: close`. */
const estaEncerrando = () => estado.encerrando;

/** Middleware: durante o encerramento, a resposta pede ao cliente para fechar a conexão (keep-alive não segura o processo). */
function marcarConexaoParaFechar(_req, res, next) {
  if (estado.encerrando) res.set('Connection', 'close');
  next();
}

const comPrazo = (promessa, ms) => Promise.race([Promise.resolve(promessa).catch(() => undefined), new Promise((r) => { setTimeout(r, ms).unref(); })]);

/**
 * Instala os ouvintes. `getServer` devolve o servidor HTTP (ou null antes de abrir a porta); `closePool` fecha o pool do banco; `exit` encerra o
 * processo (injetáveis para o teste de unidade). Devolve false se já estava instalada.
 */
function installProcessGuards({ log, proc = process, getServer = () => null, closePool = async () => {}, exit = (codigo) => proc.exit(codigo), graceMs = prazoDeEncerramento() } = {}) {
  if (estado.instalada) return false;
  estado.instalada = true;
  let saiu = false;
  const sair = (motivo) => {
    if (saiu) return;
    saiu = true;
    comPrazo(closePool(), FECHAR_POOL_MS).then(() => {
      try { log.fatal({ code: 'PROCESS_EXIT', reason: motivo, exitCode: 1 }, `[Processo] encerrando com código 1 (${motivo}); o supervisor reinicia a API`); } catch (_e) { /* */ }
      // a saída padrão pode ser assíncrona (pipe fora do Linux): espera o registro sair, no máximo 500 ms
      let feito = false;
      const fim = () => { if (!feito) { feito = true; exit(1); } };
      try { if (proc.stdout && typeof proc.stdout.write === 'function') proc.stdout.write('', fim); else fim(); } catch (_e) { fim(); }
      setTimeout(fim, 500).unref();
    });
  };
  const encerrar = (code, err, origem) => {
    if (estado.encerrando) {
      try { log.error({ code, origin: String(origem || ''), err: erroParaLog(err) }, '[Processo] nova falha durante o encerramento'); } catch (_e) { /* */ }
      return;
    }
    estado.encerrando = true;
    try {
      log.fatal({ code, origin: String(origem || ''), graceMs, err: erroParaLog(err) }, '[Processo] falha sem tratamento: a API para de aceitar conexões, espera os pedidos em andamento e encerra');
    } catch (_e) { /* o registro não impede o encerramento */ }
    const server = getServer();
    if (!server) { sair('sem servidor HTTP aberto'); return; }
    const fecharOciosas = () => { try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (_e) { /* */ } };
    const ciclo = setInterval(fecharOciosas, 200);
    try {
      server.close(() => { clearInterval(ciclo); sair('pedidos em andamento concluídos'); });
    } catch (_e) {
      clearInterval(ciclo);
      sair('servidor já fechado');
      return;
    }
    fecharOciosas();
    setTimeout(() => { clearInterval(ciclo); sair(`prazo de ${graceMs} ms esgotado com pedidos em andamento`); }, graceMs);
  };
  proc.on('uncaughtException', (err, origem) => encerrar('PROCESS_UNCAUGHT_EXCEPTION', err, origem));
  proc.on('unhandledRejection', (motivo) => encerrar('PROCESS_UNHANDLED_REJECTION', motivo, 'unhandledRejection'));
  return true;
}

/** Só para o teste de unidade: volta ao estado inicial. */
function _reiniciarParaTeste() {
  estado.instalada = false;
  estado.encerrando = false;
}

module.exports = { installProcessGuards, prazoDeEncerramento, estaEncerrando, marcarConexaoParaFechar, PADRAO_GRACE_MS, FAIXA_GRACE_MS, _reiniciarParaTeste };
