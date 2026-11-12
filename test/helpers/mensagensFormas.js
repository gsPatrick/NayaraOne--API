'use strict';

// Formas de entrada e o que cada campo das rotas de mensagem deve responder a cada uma (DI-M9R-11). Apoio de crm.messages.entrada.esquema.http.test.js.
const crypto = require('node:crypto');

const U1 = crypto.randomUUID();
const U2 = crypto.randomUUID();

/** Formas erradas usadas em TODOS os campos. As de texto ("textoLongo", "foraDoFormato" e os nomes do protótipo como valor) são erradas para os campos com formato. */
const FORMAS = Object.freeze({
  objeto: { id: U1 },
  lista: [U1, U2],
  listaDeUm: [U1],
  numero: 123,
  booleano: true,
  semToString: { toString: 1 },
  objetoVazio: {},
  listaVazia: [],
  textoLongo: 'x'.repeat(5000),
  foraDoFormato: 'nao-e-uuid',
  'valor:__proto__': '__proto__',
  'valor:constructor': 'constructor',
  'valor:toString': 'toString',
  'valor:hasOwnProperty': 'hasOwnProperty',
});
const TEXTOS = new Set(['textoLongo', 'foraDoFormato', 'valor:__proto__', 'valor:constructor', 'valor:toString', 'valor:hasOwnProperty']);
const PROTO_CAMPOS = Object.freeze(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']);

const E400 = (campo) => ({ status: 400, code: 'MESSAGE_VALIDATION', ...(campo ? { campo } : {}) });
const ok = (status) => ({ status });
const e422 = (code) => ({ status: 422, code });

/**
 * Regras por campo:
 * - `recusa`: qualquer forma da lista é errada (UUID, lista fechada, campo fora da rota);
 * - `texto`: só a forma que não é texto é errada; o texto vale (`aceito`) ou vai à regra da demanda (`regra`);
 * - `textoLimitado`: além disso, o texto longo é errado (coluna limitada, ou limite do canal no envio: DI-M9R-16);
 * - `formato`: texto só no formato (finalidade, CHECK da migration 753): longo e fora do formato são errados, os nomes do protótipo são válidos;
 * - `servidor`: o valor é descartado (autor, empresa, ligação com o fornecedor): sempre `aceito`;
 * - `listaDeTextos`: só lista de textos; a lista vazia e a de UUIDs vão à regra do modelo.
 */
const CAMPOS_CRIAR = Object.freeze({
  personId: { tipo: 'recusa' },
  opportunityId: { tipo: 'recusa' },
  conversationId: { tipo: 'recusa' },
  mediaQuarantineId: { tipo: 'recusa' },
  channel: { tipo: 'recusa' },
  direction: { tipo: 'recusa' },
  authorType: { tipo: 'recusa' },
  actionKey: { tipo: 'recusa' },
  externalMessageId: { tipo: 'textoLimitado', aceito: ok(201) },
  body: { tipo: 'texto', aceito: ok(201) },
  purpose: { tipo: 'formato', aceito: ok(201) },
  authorUserId: { tipo: 'servidor', aceito: ok(201) },
  connectionId: { tipo: 'servidor', aceito: ok(201) },
  dispatchId: { tipo: 'servidor', aceito: ok(201) },
  deliveryStatus: { tipo: 'servidor', aceito: ok(201) },
  groupId: { tipo: 'servidor', aceito: ok(201) },
  companyId: { tipo: 'servidor', aceito: ok(201) },
});
const DESCONHECIDOS_CRIAR = Object.freeze([...PROTO_CAMPOS, 'status', 'id', 'createdBy', 'updatedBy', 'mediaState', 'failureReason', 'occurredAt', 'summary', 'kind', 'to']);

const PHONE = e422('INTEGRATION_MESSAGING_PHONE_INVALID');
const MODELO = e422('INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED');
/** Campos de POST /messages/send por base (a base em que o campo faz sentido). */
const CAMPOS_ENVIAR = Object.freeze({
  template: {
    kind: { tipo: 'recusa' },
    personId: { tipo: 'recusa' },
    opportunityId: { tipo: 'recusa' },
    conversationId: { tipo: 'recusa' },
    to: { tipo: 'texto', aceito: PHONE },
    templateName: { tipo: 'texto', aceito: MODELO },
    language: { tipo: 'texto', aceito: MODELO },
    templateVars: { tipo: 'listaDeTextos' },
    purpose: { tipo: 'formato', aceito: ok(202) },
  },
  // Rodada 6 (DI-M9R-16): `text` e `caption` têm o limite do canal (4096 e 1024 caracteres, parâmetros da empresa): o texto longo (5000) é 400.
  text: { kind: { tipo: 'recusa' }, text: { tipo: 'textoLimitado', aceito: ok(202) }, caption: { tipo: 'textoLimitado', aceito: ok(202) } },
  media: { mediaRef: { tipo: 'recusa' }, caption: { tipo: 'textoLimitado', aceito: ok(202) } },
});
const DESCONHECIDOS_ENVIAR = Object.freeze([...PROTO_CAMPOS, 'mediaQuarantineId', 'groupId', 'companyId', 'authorUserId', 'body', 'channel', 'direction', 'status', 'actionKey', 'connectionId']);

function esperado(regra, campo, forma) {
  const ehTexto = TEXTOS.has(forma);
  if (regra.tipo === 'recusa') return E400(campo);
  if (regra.tipo === 'servidor') return regra.aceito;
  if (regra.tipo === 'listaDeTextos') {
    if (forma === 'listaVazia') return ok(202);
    if (['lista', 'listaDeUm'].includes(forma)) return e422('INTEGRATION_MESSAGING_TEMPLATE_VARIABLES_MISMATCH');
    return E400(campo);
  }
  if (!ehTexto) return E400(campo);
  if (regra.tipo === 'textoLimitado' && forma === 'textoLongo') return E400(campo);
  if (regra.tipo === 'formato' && ['textoLongo', 'foraDoFormato'].includes(forma)) return E400(campo);
  return regra.aceito;
}

/** Corpo com o campo como PRÓPRIO, em texto JSON (para `"__proto__"` chegar como campo). O campo substitui o da base, se houver. */
function comCampo(corpo, campo, valor) {
  const partes = Object.entries(corpo).filter(([k]) => k !== campo).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  partes.push(`${JSON.stringify(campo)}:${JSON.stringify(valor)}`);
  return `{${partes.join(',')}}`;
}

/** Ids de caminho fora da forma. */
const IDS_DE_CAMINHO = Object.freeze(['nao-e-uuid', '123', 'true', 'x'.repeat(300), '__proto__', 'constructor', 'toString', `${U1}x`]);

/** Consultas do GET /messages fora da forma: [consulta, campo citado]. */
const consultas = (personId) => [
  [`personId[id]=${personId}`, 'personId'], [`personId=${U1}&personId=${U2}`, 'personId'], ['personId[toString]=1', 'personId'], ['personId=nao-e-uuid', 'personId'],
  ['personId=123', 'personId'], ['personId=true', 'personId'], [`personId=${'x'.repeat(5000)}`, 'personId'], [`personId[]=${U1}`, 'personId'], ['personId[__proto__]=1', 'personId'],
  ['personId=constructor', 'personId'], [`opportunityId[]=${U1}`, 'opportunityId'], ['opportunityId=123', 'opportunityId'], [`opportunityId[id]=${U1}`, 'opportunityId'],
  ['opportunityId=toString', 'opportunityId'], ['x=1', 'x'], ['constructor=1', 'constructor'], ['toString=1', 'toString'], ['hasOwnProperty=1', 'hasOwnProperty'], ['limit=10', 'limit'],
];

module.exports = {
  FORMAS, PROTO_CAMPOS, CAMPOS_CRIAR, DESCONHECIDOS_CRIAR, CAMPOS_ENVIAR, DESCONHECIDOS_ENVIAR, IDS_DE_CAMINHO, E400, comCampo, consultas,
  esperadoCriar: esperado, esperadoEnviar: esperado,
};
