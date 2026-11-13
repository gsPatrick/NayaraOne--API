'use strict';

const { folhasDoPedido, achar, nomesDoCampo, normal } = require('./provaDoPedido');

/**
 * Erros de DADO (classe 22) e de INTEGRIDADE (classe 23) do Postgres que são do CLIENTE (rodada 7, DI-M9R-20; refeito na rodada 8 da verificação do
 * Marco 9, 12/11/2026, DI-M9R-25).
 *
 * Na rodada 7 toda a classe 22 (menos 2200H) virava 400, e 23502, 23503, 23514 e 23P01 viravam 4xx, sem prova de que o valor era do pedido: divisão
 * por zero, constante do código que não converte, texto do servidor maior que a coluna, NOT NULL e chave estrangeira esquecidos pelo código saíam
 * como erro do cliente, e alguns só como aviso, sem a pilha. Agora o mapeamento para 4xx exige PROVA de que o valor recusado veio do pedido
 * (provaDoPedido.js), ligada à coluna quando o banco ou o comando permitem descobri-la:
 * - o valor citado na mensagem do banco (22P02 `invalid input syntax for type uuid: "x"`, 22007, 22008, 22003 `value "x" is out of range`, enum ...)
 *   é o valor de um campo do pedido; se a coluna é conhecida (pelo comando com parâmetros do Sequelize), o campo tem o nome do atributo ou da coluna;
 * - 22001 (texto longo) e 22003 sem valor na mensagem (`numeric field overflow`, `integer out of range`): o valor que passa do limite está nos
 *   parâmetros do comando, na coluna recusada, e é o valor do campo do pedido com aquele nome;
 * - 23502: o comando gravava null na coluna e o pedido mandou o campo dela vazio (null ou ''); 23503: o identificador do detalhe do banco (ou do parâmetro da coluna) é o valor do
 *   campo do pedido, e no "still referenced" é o identificador do caminho ou do corpo; 23514: a coluna da regra (nome padrão `<tabela>_<coluna>_check`)
 *   tem no comando o valor do campo do pedido; 23P01: um dos valores do conflito é de um campo do pedido;
 * - 22021, 22P05 e 22P02 do tipo json (caractere que o banco não grava): ficam em requestRead.errors.js, com a mesma regra (o caractere está no pedido).
 * Sem a prova o erro não é mapeado: segue para o 500 do errorHandler, registrado como ERRO com a pilha. Outros códigos (22012 divisão por zero,
 * 22023, 2201B expressão regular, 2201W/2201X LIMIT/OFFSET, 2200H ...) nunca viram 4xx. Nenhuma resposta leva o valor; só o nome do campo.
 */
const erroPg = (err) => (err && (err.name === 'SequelizeDatabaseError' || err.name === 'DatabaseError' || err.parent) ? err.parent || err.original || null : null);

const semAspas = (nome) => nome.trim().replace(/^"|"$/g, '');
const parametroDe = (token, parametros) => {
  const m = /^\$(\d+)$/.exec(String(token).trim());
  return m && Array.isArray(parametros) ? parametros[Number(m[1]) - 1] : undefined;
};

/** Pares [coluna, valor] de um INSERT ou UPDATE com parâmetros ($1, $2 ...), como o Sequelize monta. Comando que não reconhece: lista vazia. */
function paresDoComando(sql, parametros) {
  if (typeof sql !== 'string' || !Array.isArray(parametros)) return [];
  const insert = /^\s*INSERT\s+INTO\s+[^(]+\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
  if (insert) {
    const valores = insert[2].split(',');
    return insert[1].split(',').map((c, i) => [semAspas(c), parametroDe(valores[i] || '', parametros)]);
  }
  const update = /^\s*UPDATE\s+\S+\s+SET\s+([\s\S]*?)\s+WHERE\s/i.exec(sql);
  if (update) return update[1].split(',').map((par) => par.split('=')).filter((p) => p.length === 2).map(([c, v]) => [semAspas(c), parametroDe(v, parametros)]);
  return [];
}

/** Modelo da tabela do comando (INSERT INTO / UPDATE), ou null. */
function modeloDoComando(sql, tabelaDoBanco) {
  try {
    const { sequelize } = require('../models');
    const m = typeof sql === 'string' ? /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?([\w]+)"?\.)?"?([\w]+)"?/i.exec(sql) : null;
    const tabela = tabelaDoBanco || (m && m[2]);
    if (!tabela) return null;
    return Object.values(sequelize.models).find((modelo) => { const n = modelo.getTableName(); return (typeof n === 'string' ? n : n.tableName) === tabela; }) || null;
  } catch (_e) { return null; }
}

/** Nome do campo na API (atributo do modelo) para a coluna; sem modelo conhecido, a própria coluna. */
function nomeDoCampo(coluna, sql, tabela) {
  const modelo = modeloDoComando(sql, tabela);
  if (!modelo || !coluna) return coluna;
  const atributo = Object.entries(modelo.rawAttributes).find(([, def]) => def.field === coluna);
  return atributo ? atributo[0] : coluna;
}

/** Valor citado pelo Postgres na mensagem, ou null. */
function valorCitado(mensagem) {
  const m = /^value "([\s\S]*)" is out of range for type/.exec(mensagem) || /^invalid value "([\s\S]*)" for "/.exec(mensagem)
    || /^time zone "([\s\S]*)" not recognized/.exec(mensagem) || /: "([\s\S]*)"\s*$/.exec(mensagem);
  return m ? m[1] : null;
}

/** Comprimento como o Postgres conta (pontos de código). */
const caracteres = (texto) => { let n = 0; for (const _c of texto) n += 1; return n; }; // eslint-disable-line no-unused-vars

/** Prova pelo valor citado: { campo } ou null. Com a coluna conhecida pelo comando, o campo do pedido tem de ter o nome dela. */
function provaPeloValorCitado(err, pg, folhas) {
  const valor = valorCitado(String(pg.message || ''));
  if (valor === null) return null;
  const par = paresDoComando(err.sql, err.parameters).find(([, v]) => v !== undefined && v !== null && normal(v) === normal(valor));
  if (par) {
    const campo = nomeDoCampo(par[0], err.sql);
    const f = achar(folhas, { valor, nomes: nomesDoCampo(par[0], campo) });
    return f ? { campo } : null;
  }
  if (normal(valor) === '') return null; // vazio sem coluna conhecida: coincidência fácil demais para ser prova
  const f = achar(folhas, { valor });
  if (!f) return null;
  return { campo: f.parte === 'params' ? null : f.campo }; // parâmetro do caminho: o campo não é nomeado
}

/** 22001: as colunas do comando cujo texto passa do limite e que vieram, iguais, do campo de mesmo nome do pedido. */
function provaDoTextoLongo(err, pg, folhas) {
  const max = Number((/character varying\((\d+)\)|character\((\d+)\)/i.exec(String(pg.message || '')) || []).slice(1).find(Boolean));
  if (!Number.isInteger(max)) return null;
  const campos = [];
  for (const [coluna, v] of paresDoComando(err.sql, err.parameters)) {
    if (typeof v !== 'string' || v.length <= max || caracteres(v) <= max) continue;
    const campo = nomeDoCampo(coluna, err.sql);
    if (achar(folhas, { valor: v, nomes: nomesDoCampo(coluna, campo) })) campos.push(campo);
  }
  if (campos.length === 0 && typeof err.sql === 'string') {
    // comando sem parâmetros (consulta com substituições): o texto longo do pedido está, escapado, no próprio comando
    for (const f of folhas) {
      if (typeof f.valor === 'string' && f.valor.length > max && caracteres(f.valor) > max && err.sql.includes(`'${f.valor.replace(/'/g, "''")}'`)) campos.push(f.campo);
    }
  }
  return campos.length ? { campos: [...new Set(campos)], max } : null;
}

/** 22003 sem valor na mensagem: número do comando fora da faixa da coluna (DECIMAL(p,s) do modelo, ou inteiro) que veio do campo de mesmo nome. */
function provaDoNumeroGrande(err, pg, folhas) {
  const msg = String(pg.message || '');
  const inteiro = /^(smallint|integer|bigint) out of range$/.exec(msg);
  if (!inteiro && !/numeric field overflow/i.test(msg)) return null;
  const modelo = modeloDoComando(err.sql);
  const LIMITE = { smallint: 32767, integer: 2147483647, bigint: Number.MAX_SAFE_INTEGER * 1024 };
  for (const [coluna, v] of paresDoComando(err.sql, err.parameters)) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) continue;
    let fora = false;
    if (inteiro) fora = Math.abs(n) > LIMITE[inteiro[1]];
    else {
      const def = modelo && Object.values(modelo.rawAttributes).find((d) => d.field === coluna);
      const opt = def && def.type && def.type.options;
      if (opt && Number.isInteger(opt.precision)) fora = Math.abs(n) >= 10 ** (opt.precision - (opt.scale || 0));
    }
    if (!fora) continue;
    const campo = nomeDoCampo(coluna, err.sql);
    if (achar(folhas, { valor: v, nomes: nomesDoCampo(coluna, campo) }) || folhas.some((f) => nomesDoCampo(coluna, campo).includes(f.campo) && Number(f.valor) === n)) return { campo };
  }
  return null;
}

/** Coluna e valor de "Key (coluna)=(valor)" no detalhe do banco. */
function chaveDoDetalhe(detalhe) {
  const m = /^Key \(("?)([a-z_][a-z0-9_]*)\1\)=\(([\s\S]*?)\)( is | conflicts|$)/i.exec(String(detalhe || ''));
  return m ? { coluna: m[2], valor: m[3] } : null;
}

/** Classe 23 com prova: { campo } ou null. */
function provaDaIntegridade(err, pg, folhas) {
  const pares = paresDoComando(err.sql, err.parameters);
  const doComando = (coluna) => { const p = pares.find(([c]) => c === coluna); return p ? p[1] : undefined; };
  if (pg.code === '23502') {
    const coluna = typeof pg.column === 'string' ? pg.column : null;
    // o comando (com parâmetros) gravava null nessa coluna, e o pedido mandou o campo dela vazio; NULL escrito no próprio SQL é do código
    if (!coluna || !pares.some(([c, v]) => c === coluna && (v === null || v === undefined))) return null;
    const campo = nomeDoCampo(coluna, err.sql, pg.table);
    return achar(folhas, { nomes: nomesDoCampo(coluna, campo), aceitaNulo: true }) ? { campo } : null;
  }
  if (pg.code === '23503') {
    const chave = chaveDoDetalhe(pg.detail);
    if (chave && /still referenced/i.test(String(pg.detail || ''))) return achar(folhas, { valor: chave.valor }) ? { campo: null, emUso: true } : null;
    const tabela = typeof pg.table === 'string' ? pg.table : '';
    const restricao = typeof pg.constraint === 'string' ? pg.constraint : '';
    const coluna = chave ? chave.coluna : (tabela && restricao.startsWith(`${tabela}_`) && restricao.endsWith('_fkey') ? restricao.slice(tabela.length + 1, -'_fkey'.length) : null);
    const valor = chave ? chave.valor : (coluna ? doComando(coluna) : undefined);
    if (!coluna || valor === undefined || valor === null) return null;
    const campo = nomeDoCampo(coluna, err.sql, tabela);
    return achar(folhas, { valor, nomes: nomesDoCampo(coluna, campo) }) ? { campo } : null;
  }
  if (pg.code === '23514') {
    const tabela = typeof pg.table === 'string' ? pg.table : '';
    const restricao = typeof pg.constraint === 'string' ? pg.constraint : '';
    const coluna = tabela && restricao.startsWith(`${tabela}_`) && restricao.endsWith('_check') ? restricao.slice(tabela.length + 1, -'_check'.length) : null;
    const valor = coluna ? doComando(coluna) : undefined;
    if (!coluna || valor === undefined || valor === null) return null;
    const campo = nomeDoCampo(coluna, err.sql, tabela);
    return achar(folhas, { valor, nomes: nomesDoCampo(coluna, campo) }) ? { campo } : null;
  }
  if (pg.code === '23P01') {
    const m = /^Key \(([^)]*)\)=\(([\s\S]*?)\) conflicts/i.exec(String(pg.detail || ''));
    if (!m) return null;
    const valores = m[2].split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter((v) => v && !/^[[(]/.test(v));
    return valores.some((v) => achar(folhas, { valor: v })) ? { campo: null } : null;
  }
  return null;
}

/** Código e mensagem por SQLSTATE da classe 22; `c` é o nome do campo, quando se sabe. */
const MENSAGENS = Object.freeze({
  '22003': ['VALUE_TOO_LARGE', (c) => (c ? `O valor do campo "${c}" é grande demais.` : 'O valor informado é grande demais para este campo.')],
  '22007': ['INVALID_DATE_VALUE', (c) => (c ? `A data ou hora do campo "${c}" não é válida.` : 'Uma data ou hora informada não é válida.')],
  '22008': ['INVALID_DATE_VALUE', (c) => (c ? `A data ou hora do campo "${c}" está fora da faixa aceita.` : 'Uma data ou hora informada está fora da faixa aceita.')],
  '22015': ['INVALID_DATE_VALUE', (c) => (c ? `O intervalo de tempo do campo "${c}" está fora da faixa aceita.` : 'Um intervalo de tempo informado está fora da faixa aceita.')],
  '22009': ['INVALID_DATE_VALUE', (c) => (c ? `O fuso horário do campo "${c}" não é válido.` : 'O fuso horário informado não é válido.')],
});
const OUTRO = ['INVALID_FIELD_VALUE', (c) => (c ? `O valor do campo "${c}" não é válido.` : 'Um valor enviado não é válido para o campo.')];
/** Códigos da classe 22 que podem ser do valor do cliente (com prova). Os demais da classe são sempre do servidor. */
const COM_VALOR = new Set(['22001', '22003', '22007', '22008', '22009', '22015', '22018', '22P02', '22023']);

/** Classe 23: [status, código, mensagem(campo)]. */
const INTEGRIDADE = Object.freeze({
  '23503': [400, 'REFERENCE_NOT_FOUND', (c) => (c ? `O registro informado em "${c}" não existe ou não pode ser usado aqui.` : 'Um registro informado não existe ou não pode ser usado aqui.')],
  '23502': [400, 'REQUIRED_FIELD_MISSING', (c) => (c ? `O campo "${c}" é obrigatório.` : 'Falta um campo obrigatório.')],
  '23514': [400, 'INVALID_FIELD_VALUE', () => 'Um valor enviado não é aceito pelas regras do cadastro.'],
  '23P01': [409, 'CONFLICTING_RECORD', () => 'O registro conflita com outro já existente (por exemplo, no mesmo período).'],
});

const comCampo = (campo) => (campo ? { fields: [campo], problems: [{ field: campo, message: null }] } : { fields: [] });
function resposta(statusCode, code, message, campo, extra = {}) {
  const details = comCampo(campo);
  if (details.problems) details.problems[0].message = message;
  return { statusCode, code, message, details: { ...details, ...extra } };
}

/**
 * Erro do banco -> { statusCode, code, message, details } quando há prova de que o valor recusado é do pedido; null nos demais casos (o
 * errorHandler responde 500 e registra como ERRO, com a pilha).
 */
function mapClientDataDbError(err, req) {
  const pg = erroPg(err);
  if (!pg || typeof pg.code !== 'string' || !req) return null;
  const folhas = folhasDoPedido(req);
  if (pg.code.startsWith('22')) {
    if (!COM_VALOR.has(pg.code)) return null;
    if (pg.code === '22001') {
      const p = provaDoTextoLongo(err, pg, folhas);
      if (!p) return null;
      const message = p.campos.length === 1 ? `O texto do campo "${p.campos[0]}" passa do tamanho máximo (${p.max} caracteres).` : `Um texto enviado passa do tamanho máximo do campo (${p.max} caracteres).`;
      return { statusCode: 400, code: 'VALUE_TOO_LONG', message, details: { fields: p.campos, problems: p.campos.map((field) => ({ field, message: `O texto do campo "${field}" passa do tamanho máximo (${p.max} caracteres).` })), maxLength: p.max } };
    }
    const p = provaPeloValorCitado(err, pg, folhas) || (pg.code === '22003' ? provaDoNumeroGrande(err, pg, folhas) : null);
    if (!p) return null;
    if (pg.code === '22P02' && /type uuid/i.test(String(pg.message || ''))) return resposta(400, 'INVALID_ID_FORMAT', 'O identificador informado não é válido.', p.campo);
    const [code, mensagem] = MENSAGENS[pg.code] || OUTRO;
    return resposta(400, code, mensagem(p.campo), p.campo);
  }
  if (pg.code.startsWith('23') && INTEGRIDADE[pg.code]) {
    const p = provaDaIntegridade(err, pg, folhas);
    if (!p) return null;
    if (p.emUso) return { statusCode: 409, code: 'RECORD_IN_USE', message: 'O registro está em uso por outros cadastros e não pode ser removido ou alterado.', details: { fields: [] } };
    const [statusCode, code, mensagem] = INTEGRIDADE[pg.code];
    return resposta(statusCode, code, mensagem(p.campo), p.campo);
  }
  return null;
}

module.exports = { mapClientDataDbError, paresDoComando, valorCitado, chaveDoDetalhe, INTEGRIDADE, COM_VALOR };
