'use strict';

/** M9-D255 3.3 — as invariantes da carga. Cada função devolve a lista de violações (vazia = ok). */

/** Evento enviado e ausente da caixa de entrada; evento que apareceu mais de uma vez; resposta que não foi 200 (evento que o fornecedor teria de reenviar). */
function webhooksPerdidos(fase, inbox) {
  const perdidos = fase.ids.filter((id) => !inbox.contagem.has(id)).map((id) => ({ tipo: 'evento_sem_linha_na_inbox', id }));
  const recusados = fase.respostas.filter((r) => r.status !== 200).map((r) => ({ tipo: 'resposta_diferente_de_200', id: r.id, status: r.status }));
  return [...perdidos, ...recusados];
}
const webhooksDuplicados = (inbox) => inbox.repetidosNaInbox.map((id) => ({ tipo: 'evento_gravado_mais_de_uma_vez', id }));

/** Pedido sem envio; mesma chave com mais de um envio; envio com mais de uma tentativa (chamada repetida ao fornecedor); fila que não esvaziou. */
function dispatchesViolacoes(fase, leitura, drenagem) {
  const porChave = new Map();
  leitura.envios.forEach((e) => porChave.set(e.idempotency_key, [...(porChave.get(e.idempotency_key) || []), e]));
  const semEnvio = fase.chaves.filter((c) => !porChave.has(c)).map((c) => ({ tipo: 'pedido_sem_envio', chave: c }));
  const duplicados = [...porChave].filter(([, v]) => v.length > 1).map(([chave, v]) => ({ tipo: 'chave_com_mais_de_um_envio', chave, envios: v.length }));
  const repetidos = leitura.tentativas.filter((t) => t.n > 1).map((t) => ({ tipo: 'envio_com_mais_de_uma_tentativa', dispatchId: t.dispatch_id, tentativas: t.n }));
  const erros = fase.recibos.filter((r) => r.erro).map((r) => ({ tipo: 'pedido_recusado', chave: r.chave, erro: r.erro }));
  const fila = drenagem.drenada && leitura.abertos === 0 ? [] : [{ tipo: 'fila_nao_drenada', abertos: leitura.abertos }];
  return { perdidos: [...semEnvio, ...erros], duplicados: [...duplicados, ...repetidos], fila };
}

module.exports = { webhooksPerdidos, webhooksDuplicados, dispatchesViolacoes };
