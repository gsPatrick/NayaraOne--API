'use strict';

// Dados do servidor de UM run da NAY Comercial que passam de um gancho a outro (fontes do servidor -> revisão da saída -> recomendação):
// os fatos aprovados do imóvel e os fatos da mensagem lidos para o caminho de modelo. Fica fora do estado do run (o modelo nunca vê) e some
// com ele (WeakMap).
const store = new WeakMap();

const remember = (state, data) => { store.set(state, { ...(store.get(state) || {}), ...data }); };
const recall = (state) => store.get(state) || {};

module.exports = { remember, recall };
