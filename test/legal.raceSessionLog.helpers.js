'use strict';

/**
 * Log nominal das corridas de prazo juridico com duas sessoes PostgreSQL independentes.
 *
 * So observa: registra o PID do backend de cada sessao, o numero da transacao, a ordem em que
 * cada uma executou e commitou e, enquanto a segunda espera, QUEM a bloqueia (pg_blocking_pids),
 * em qual lock (pg_locks) e qual comando ela esta esperando (pg_stat_activity). Nenhuma asserção
 * dos testes depende disto. A observacao usa uma TERCEIRA conexao do pool, fora das duas
 * transacoes da corrida.
 *
 * Saida: linhas com prefixo "[corrida]" no console e, se CORRIDA_LOG_FILE estiver definido,
 * tambem acrescentadas a esse arquivo.
 */

const fs = require('node:fs');

function createRaceLog(sequelize, title) {
  const t0 = Date.now();
  const emit = (msg) => {
    const line = `[corrida] +${String(Date.now() - t0).padStart(5, ' ')} ms | ${title} | ${msg}`;
    console.log(line);
    if (process.env.CORRIDA_LOG_FILE) fs.appendFileSync(process.env.CORRIDA_LOG_FILE, `${line}\n`);
  };

  /** Identifica a sessao (PID do backend e transacao) dentro da propria transacao. */
  async function session(label, tx) {
    const [[row]] = await sequelize.query('SELECT pg_backend_pid() AS pid, txid_current()::text AS txid', { transaction: tx });
    emit(`sessão ${label}: backend PID ${row.pid}, transação ${row.txid} aberta (BEGIN + SET LOCAL do tenant)`);
    return { label, pid: Number(row.pid), txid: row.txid };
  }

  /** Fotografa, por outra conexao, o estado da sessao `waiter` (espera de lock e quem bloqueia). */
  async function observe(waiter, sessionsByPid) {
    const [[act]] = await sequelize.query(
      `SELECT state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by, regexp_replace(query, '\\s+', ' ', 'g') AS query
         FROM pg_stat_activity WHERE pid = :pid`,
      { replacements: { pid: waiter.pid } }
    );
    const [locks] = await sequelize.query(
      `SELECT l.locktype, l.mode, l.granted, COALESCE(c.relname, '') AS relation, l.transactionid::text AS xid
         FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = :pid AND NOT l.granted`,
      { replacements: { pid: waiter.pid } }
    );
    if (!act) {
      emit(`observador: sessão ${waiter.label} (PID ${waiter.pid}) não encontrada em pg_stat_activity`);
      return { waiting: false, blockedBy: [] };
    }
    const blockedBy = (act.blocked_by || []).map(Number);
    const who = blockedBy.map((p) => (sessionsByPid[p] ? `sessão ${sessionsByPid[p].label} (PID ${p})` : `PID ${p}`)).join(', ') || 'ninguém';
    const txOf = (xid) => Object.values(sessionsByPid).find((x) => x.txid === xid);
    const waitingLocks = locks
      .map((l) => `${l.locktype}/${l.mode}${l.relation ? ` em ${l.relation}` : ''}${l.xid ? ` (espera o fim da transação ${l.xid}${txOf(l.xid) ? ` = sessão ${txOf(l.xid).label}` : ''})` : ''}`)
      .join('; ') || 'nenhum lock pendente';
    emit(`observador (3ª conexão): sessão ${waiter.label} PID ${waiter.pid} state=${act.state} wait=${act.wait_event_type || 'nenhum'}/${act.wait_event || 'nenhum'} bloqueada por: ${who}; locks não concedidos: ${waitingLocks}`);
    if (act.wait_event_type === 'Lock') {
      // So o trecho a partir do FROM (tabela, filtro e FOR UPDATE): a lista de colunas nao informa nada.
      const q = String(act.query || '');
      const from = q.indexOf(' FROM ');
      emit(`observador: comando em espera da sessão ${waiter.label}: ...${(from >= 0 ? q.slice(from) : q).slice(0, 220)}`);
    }
    return { waiting: act.wait_event_type === 'Lock', blockedBy };
  }

  const outcome = (r) => (r.ok ? 'OK' : `RECUSADA HTTP ${r.status} ${r.code || ''}`.trim());

  return { emit, session, observe, outcome };
}

module.exports = { createRaceLog };
