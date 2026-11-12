'use strict';

/**
 * Erros de DADO do banco causados pelo valor que o cliente mandou (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-20).
 *
 * A classe 22 do Postgres ("data exception") é o banco recusando um VALOR: texto maior que a coluna (22001), número fora da faixa (22003), data
 * inválida (22007, 22008), texto que não converte para o tipo (22P02) e assim por diante. Antes só o UUID inválido e o "numeric field overflow" eram
 * mapeados; o resto (por exemplo `legalName` com 256 caracteres em `POST /people`) dava 500. Agora toda a classe 22 vira 400, com o nome do campo
 * quando o banco ou o comando permitem descobri-lo, e nunca com o valor. Fica de fora só 2200H (fim da sequência), que é do servidor.
 *
 * Os códigos que só o valor do cliente produz são registrados como aviso; os demais da classe (divisão por zero, argumento inválido de função, ...)
 * também viram 400, mas são registrados como ERRO com a pilha, porque podem ser falha do próprio código: aparecem no log para serem corrigidos.
 *
 * A classe 23 (integridade: identificador que não existe, campo obrigatório ausente, valor fora da CHECK, conflito de faixa) também vira 4xx, com a
 * coluna e sem o valor; como pode ser do pedido ou do código, é sempre registrada como ERRO. A unicidade (23505) mantém o 409 que já tinha.
 *
 * O identificador com tipo errado ("Argument passed to findByPk is invalid", 42883 "operator does not exist: uuid = integer") precisa de prova no
 * pedido e fica em clientTypeErrors.js.
 */
const DO_CLIENTE = new Set(['22001', '22003', '22007', '22008', '22P02', '22021', '22P05', '22025', '2201B', '2201W', '2201X', '22015', '22009', '22018', '22026']);
const DO_SERVIDOR = new Set(['2200H']);

const erroPg = (err) => (err && (err.name === 'SequelizeDatabaseError' || err.name === 'DatabaseError' || err.parent) ? err.parent || err.original || null : null);

/** Comprimento em caracteres como o Postgres conta (pontos de código), sem copiar o texto quando já cabe. */
function caracteres(texto, limite) {
  if (texto.length <= limite) return texto.length;
  let n = 0;
  for (const _c of texto) n += 1; // eslint-disable-line no-unused-vars
  return n;
}

const semAspas = (nome) => nome.trim().replace(/^"|"$/g, '');
const parametroDe = (token, parametros) => {
  const m = /^\$(\d+)$/.exec(token.trim());
  return m && Array.isArray(parametros) ? parametros[Number(m[1]) - 1] : undefined;
};

/** Pares [coluna, valor] de um INSERT ou UPDATE com parâmetros ($1, $2 ...), como o Sequelize monta. Comando que não reconhece: lista vazia. */
function paresDoComando(sql, parametros) {
  if (typeof sql !== 'string' || !Array.isArray(parametros)) return [];
  const insert = /^\s*INSERT\s+INTO\s+[^(]+\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
  if (insert) {
    const colunas = insert[1].split(',');
    const valores = insert[2].split(',');
    return colunas.map((c, i) => [semAspas(c), parametroDe(valores[i] || '', parametros)]);
  }
  const update = /^\s*UPDATE\s+\S+\s+SET\s+([\s\S]*?)\s+WHERE\s/i.exec(sql);
  if (update) {
    return update[1].split(',').map((par) => par.split('=')).filter((p) => p.length === 2).map(([c, v]) => [semAspas(c), parametroDe(v, parametros)]);
  }
  return [];
}

/** Nome do campo na API (atributo do modelo) para uma coluna da tabela do comando; sem modelo conhecido, o nome da coluna. */
function nomeDoCampo(coluna, sql) {
  try {
    const { sequelize } = require('../models');
    const tabela = /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?([\w]+)"?\.)?"?([\w]+)"?/i.exec(sql);
    if (!tabela) return coluna;
    for (const modelo of Object.values(sequelize.models)) {
      const nome = modelo.getTableName();
      const tab = typeof nome === 'string' ? nome : nome.tableName;
      if (tab !== tabela[2]) continue;
      const atributo = Object.entries(modelo.rawAttributes).find(([, def]) => def.field === coluna);
      if (atributo) return atributo[0];
    }
  } catch (_e) { /* sem modelo: fica a coluna */ }
  return coluna;
}

/** 22001: as colunas cujo texto passa do limite citado na mensagem do banco ("character varying(200)"). */
function camposDoTextoLongo(err, pg) {
  const max = Number((/character varying\((\d+)\)|character\((\d+)\)/i.exec(String(pg.message || '')) || []).slice(1).find(Boolean));
  if (!Number.isInteger(max)) return { max: null, campos: [] };
  const campos = paresDoComando(err.sql, err.parameters)
    .filter(([, v]) => typeof v === 'string' && caracteres(v, max) > max)
    .map(([coluna]) => nomeDoCampo(coluna, err.sql));
  return { max, campos: [...new Set(campos)] };
}

/** Código e mensagem por SQLSTATE; `c` é o nome do campo, quando se sabe. */
const MENSAGENS = Object.freeze({
  '22003': ['VALUE_TOO_LARGE', (c) => (c ? `O valor do campo "${c}" é grande demais.` : 'O valor informado é grande demais para este campo.')],
  '22007': ['INVALID_DATE_VALUE', (c) => (c ? `A data ou hora do campo "${c}" não é válida.` : 'Uma data ou hora informada não é válida.')],
  '22008': ['INVALID_DATE_VALUE', (c) => (c ? `A data ou hora do campo "${c}" está fora da faixa aceita.` : 'Uma data ou hora informada está fora da faixa aceita.')],
  '22015': ['INVALID_DATE_VALUE', (c) => (c ? `O intervalo de tempo do campo "${c}" está fora da faixa aceita.` : 'Um intervalo de tempo informado está fora da faixa aceita.')],
  '22009': ['INVALID_DATE_VALUE', (c) => (c ? `O fuso horário do campo "${c}" não é válido.` : 'O fuso horário informado não é válido.')],
});
const OUTRO = ['INVALID_FIELD_VALUE', (c) => (c ? `O valor do campo "${c}" não é válido.` : 'Um valor enviado não é válido para o campo.')];

/** Classe 23: [status, código, mensagem(campo)]. Registrados como ERRO: podem ser do valor enviado ou de falha do código. */
const INTEGRIDADE = Object.freeze({
  '23503': [400, 'REFERENCE_NOT_FOUND', (c) => (c ? `O registro informado em "${c}" não existe ou não pode ser usado aqui.` : 'Um registro informado não existe ou não pode ser usado aqui.')],
  '23502': [400, 'REQUIRED_FIELD_MISSING', (c) => (c ? `O campo "${c}" é obrigatório.` : 'Falta um campo obrigatório.')],
  '23514': [400, 'INVALID_FIELD_VALUE', () => 'Um valor enviado não é aceito pelas regras do cadastro.'],
  '23P01': [409, 'CONFLICTING_RECORD', () => 'O registro conflita com outro já existente (por exemplo, no mesmo período).'],
});

/** Coluna de um erro de integridade: o campo `column` (23502) ou o nome dentro de "Key (coluna)=" do detalhe (23503); sem o valor. */
function colunaDaIntegridade(pg) {
  if (typeof pg.column === 'string' && pg.column) return pg.column;
  const m = /^Key \(("?)([a-z_][a-z0-9_]*)\1\)=/i.exec(String(pg.detail || ''));
  return m ? m[2] : null;
}

/**
 * Erro de dado do banco -> { statusCode, code, message, details?, logLevel } ou null. Os erros de dado que já tinham código próprio (UUID inválido,
 * caractere que o banco não grava) são tratados antes, no errorHandler, e mantêm o código.
 */
function mapClientDataDbError(err) {
  const pg = erroPg(err);
  if (pg && typeof pg.code === 'string' && pg.code.startsWith('22') && !DO_SERVIDOR.has(pg.code)) {
    const logLevel = DO_CLIENTE.has(pg.code) ? 'warn' : 'error';
    const coluna = typeof pg.column === 'string' && pg.column ? nomeDoCampo(pg.column, err.sql) : null;
    if (pg.code === '22001') {
      const { max, campos } = camposDoTextoLongo(err, pg);
      const lista = campos.length ? campos : (coluna ? [coluna] : []);
      const limite = max ? ` (${max} caracteres)` : '';
      const message = lista.length === 1 ? `O texto do campo "${lista[0]}" passa do tamanho máximo${limite}.` : `Um texto enviado passa do tamanho máximo do campo${limite}.`;
      return { statusCode: 400, code: 'VALUE_TOO_LONG', message, details: { fields: lista, ...(max ? { maxLength: max } : {}) }, logLevel };
    }
    const [code, mensagem] = MENSAGENS[pg.code] || OUTRO;
    return { statusCode: 400, code, message: mensagem(coluna), details: { fields: coluna ? [coluna] : [] }, logLevel };
  }
  // Classe 23 (integridade), menos a unicidade, que já tem 409 próprio: identificador que não existe (23503), campo obrigatório ausente (23502),
  // valor fora da regra da tabela (23514) e conflito de faixa (23P01). O detalhe do banco traz o valor ("Key (person_id)=(...)"): só a coluna sai.
  if (pg && pg.code === '23503' && /still referenced/i.test(String(pg.detail || ''))) {
    return { statusCode: 409, code: 'RECORD_IN_USE', message: 'O registro está em uso por outros cadastros e não pode ser removido ou alterado.', logLevel: 'error' };
  }
  if (pg && INTEGRIDADE[pg.code]) {
    const [statusCode, code, mensagem] = INTEGRIDADE[pg.code];
    const coluna = colunaDaIntegridade(pg);
    const campo = coluna ? nomeDoCampo(coluna, err.sql) : null;
    return { statusCode, code, message: mensagem(campo), details: { fields: campo ? [campo] : [] }, logLevel: 'error' };
  }
  return null;
}

module.exports = { mapClientDataDbError, paresDoComando, camposDoTextoLongo, DO_CLIENTE, INTEGRIDADE };
