'use strict';

/**
 * M9-D255 3.3 — teste de carga das integrações contra os sandboxes (banco descartável). Prova: 0 eventos perdidos (contagem da inbox = enviados menos
 * repetidos), 0 dispatches duplicados e fila totalmente drenada ao fim. O volume vem dos parâmetros integration.load.* (tamanho da carga, não meta).
 */
const { enviarWebhooks, lerInbox } = require('./webhooks');
const { pedirEnvios, drenar, lerEnvios } = require('./dispatch');
const inv = require('./invariantes');

const PRAZO_DRENAGEM_MS = 20 * 60 * 1000;

async function executarCarga(env, tenant, volume, { prazoMs = PRAZO_DRENAGEM_MS } = {}) {
  const inicio = Date.now();
  const rodada = Date.now().toString(36);
  const fw = await enviarWebhooks(env, tenant, volume, rodada);
  const inbox = await lerInbox(env, tenant, fw.canal.conn.id);
  const conexao = await env.conexaoAtiva(tenant, 'MESSAGING');
  const fd = await pedirEnvios(env, tenant, conexao, volume, rodada);
  const drenagem = await drenar(env, tenant, conexao.id, { prazoMs });
  const leitura = await lerEnvios(env, tenant, conexao.id);
  const dv = inv.dispatchesViolacoes(fd, leitura, drenagem);
  const violacoes = { webhooksPerdidos: inv.webhooksPerdidos(fw, inbox), webhooksDuplicados: inv.webhooksDuplicados(inbox), dispatchesPerdidos: dv.perdidos, dispatchesDuplicados: dv.duplicados, filaNaoDrenada: dv.fila };
  const totais = Object.fromEntries(Object.entries(violacoes).map(([k, v]) => [k, v.length]));
  const contagem = (lista, resultado) => lista.filter((r) => r.resultado === resultado).length;
  return {
    volume, rodada,
    webhooks: {
      enviados: fw.enviados, distintos: volume.webhooks.distintos, repetidos: volume.webhooks.repetidos, aceitos: contagem(fw.respostas, 'accepted'), devolvidosComoDuplicados: contagem(fw.respostas, 'duplicate'),
      linhasNaInbox: inbox.linhas, esperadoNaInbox: fw.enviados - volume.webhooks.repetidos,
    },
    dispatches: {
      pedidos: fd.pedidos, distintos: volume.dispatches.distintos, repetidos: volume.dispatches.repetidos, criados: fd.recibos.filter((r) => r.criado).length, enviosNoBanco: leitura.envios.length,
      rodadasDoWorker: drenagem.rodadas, filaDrenada: drenagem.drenada && leitura.abertos === 0, porStatus: leitura.envios.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] || 0) + 1 }), {}),
    },
    violacoes: Object.fromEntries(Object.entries(violacoes).map(([k, v]) => [k, v.slice(0, 20)])), totais,
    ok: Object.values(totais).every((n) => n === 0), duracaoMs: Date.now() - inicio, executadoEm: new Date().toISOString(),
  };
}

module.exports = { executarCarga };
