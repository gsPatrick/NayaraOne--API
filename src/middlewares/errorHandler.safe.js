'use strict';

/**
 * Montagem SEGURA da resposta de erro (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-19).
 *
 * Antes, `PUT /settings/:key` com `value` aninhado em 50 mil níveis devolvia o valor recebido em `details`; o `JSON.stringify` da resposta estourava a
 * pilha dentro do errorHandler (que é `async`), a promessa rejeitada ficava sem tratamento e o processo da API terminava. Aqui:
 * - `limitarDetalhes`: `details` só vai à resposta dentro de limites (profundidade, quantidade de valores, tamanho de texto). Dentro deles, sai IGUAL
 *   (mesmo objeto); fora, sai uma cópia cortada, montada sem recursão. Nunca lança.
 * - `respostaDeUltimoRecurso`: se montar ou enviar a resposta falhar, sai um 500 mínimo (corpo fixo, sem nada do pedido nem do erro); se nem isso for
 *   possível, a conexão é encerrada. Nunca lança.
 * - `erroParaLog`: o erro vira só texto (nome, código, mensagem e stack cortados), para o registro também não depender de percorrer dado do cliente.
 */
const LIMITES = Object.freeze({ maxDepth: 16, maxNodes: 5000, maxString: 10000 });
const CORTADO = '[cortado: passa do limite da resposta de erro]';

const ehObjetoDeDados = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return Array.isArray(v) || proto === Object.prototype || proto === null;
};

/** Confere sem copiar: true se `valor` cabe nos limites (só dados simples: texto, número, booleano, null, lista e objeto comum). */
function cabeNosLimites(valor, limites) {
  const pilha = [[valor, 0]];
  let nos = 0;
  while (pilha.length > 0) {
    const [atual, nivel] = pilha.pop();
    nos += 1;
    if (nos > limites.maxNodes) return false;
    if (typeof atual === 'string') { if (atual.length > limites.maxString) return false; continue; }
    if (typeof atual === 'number' || typeof atual === 'boolean' || atual === null || atual === undefined) continue;
    if (!ehObjetoDeDados(atual)) return false;
    if (nivel >= limites.maxDepth) return false;
    for (const chave of Object.keys(atual)) pilha.push([atual[chave], nivel + 1]);
  }
  return true;
}

/** Valor simples de um item que não é dado simples (Date, Buffer, instância de modelo, BigInt, função): o que o JSON faria, sem recursão. */
function simples(valor) {
  if (typeof valor === 'bigint') return valor.toString();
  if (typeof valor === 'function' || typeof valor === 'symbol') return undefined;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
  if (Buffer.isBuffer(valor)) return CORTADO;
  return valor;
}

/** Cópia cortada, iterativa: cada nível além do limite, cada valor além da conta e cada texto longo demais vira a marca de corte. */
function copiaCortada(valor, limites) {
  const raiz = { v: undefined };
  const pilha = [[valor, raiz, 'v', 0]];
  let nos = 0;
  while (pilha.length > 0) {
    const [bruto, destino, chave, nivel] = pilha.pop();
    nos += 1;
    if (nos > limites.maxNodes) { destino[chave] = CORTADO; continue; }
    let atual = simples(bruto);
    if (atual && typeof atual === 'object' && !ehObjetoDeDados(atual) && typeof atual.toJSON === 'function') {
      try { atual = simples(atual.toJSON()); } catch (_e) { atual = CORTADO; }
    }
    if (typeof atual === 'string') { destino[chave] = atual.length > limites.maxString ? `${atual.slice(0, limites.maxString)}…` : atual; continue; }
    if (atual === null || typeof atual !== 'object') { destino[chave] = atual; continue; }
    if (!ehObjetoDeDados(atual) || nivel >= limites.maxDepth) { destino[chave] = CORTADO; continue; }
    const copia = Array.isArray(atual) ? new Array(atual.length) : {};
    destino[chave] = copia;
    for (const k of Object.keys(atual)) pilha.push([atual[k], copia, k, nivel + 1]);
  }
  return raiz.v;
}

/** `details` pronto para a resposta: o mesmo valor quando cabe nos limites; senão, a cópia cortada. Nunca lança. */
function limitarDetalhes(details, limites = LIMITES) {
  if (details === undefined) return undefined;
  try {
    return cabeNosLimites(details, limites) ? details : copiaCortada(details, limites);
  } catch (_e) {
    return CORTADO;
  }
}

const textoCurto = (v, max = 4000) => {
  try {
    const s = typeof v === 'string' ? v : String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (_e) {
    return '[sem texto]';
  }
};

/** Lê uma propriedade sem deixar um acessor quebrado lançar. */
const ler = (obj, prop) => {
  try { return obj[prop]; } catch (_e) { return '[ilegível]'; }
};

/** O erro como texto para o registro (nunca percorre objeto do cliente e nunca lança). */
function erroParaLog(err) {
  if (err === null || err === undefined) return { message: String(err) };
  if (typeof err !== 'object' && typeof err !== 'function') return { message: textoCurto(err) };
  const code = ler(err, 'code');
  return {
    name: textoCurto(ler(err, 'name') || '', 200),
    code: typeof code === 'string' || typeof code === 'number' ? textoCurto(code, 200) : undefined,
    message: textoCurto(ler(err, 'message') || ''),
    stack: textoCurto(ler(err, 'stack') || '', 8000),
  };
}

/** Código de suporte da requisição como texto curto (vem do cabeçalho X-Correlation-Id ou é gerado pela API). */
function codigoDeSuporte(req, res) {
  try {
    const id = (req && req.correlationId) || (res && typeof res.getHeader === 'function' && res.getHeader('X-Correlation-Id')) || null;
    return id === null ? null : textoCurto(id, 128);
  } catch (_e) {
    return null;
  }
}

/** 500 mínimo quando montar ou enviar a resposta de erro falhou. Registra as duas falhas e nunca lança. */
function respostaDeUltimoRecurso({ falha, original, req, res, log }) {
  const traceId = codigoDeSuporte(req, res);
  try {
    log.error({ correlationId: traceId, method: req && req.method, path: req && textoCurto(req.originalUrl, 512), err: erroParaLog(original), falhaNaResposta: erroParaLog(falha) },
      '[ErrorHandler] a resposta de erro falhou; devolvida a resposta mínima');
  } catch (_e) { /* o registro não pode impedir a resposta */ }
  try {
    if (res.headersSent) { res.destroy(); return; }
    const corpo = JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: `Algo deu errado. Informe o código ${traceId} ao suporte.`, traceId } });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(corpo));
    res.end(corpo);
  } catch (_e) {
    try { res.destroy(); } catch (_e2) { /* nada mais a fazer */ }
  }
}

module.exports = { limitarDetalhes, erroParaLog, respostaDeUltimoRecurso, codigoDeSuporte, LIMITES, CORTADO };
