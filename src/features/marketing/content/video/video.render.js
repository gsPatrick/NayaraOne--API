'use strict';

/**
 * M9-D426 — porta do renderizador de vídeo. A montagem entrega a lista de origens (com hash) e as operações permitidas e recebe de volta os bytes do arquivo NOVO. Sem
 * renderizador real registrado, vale o do sandbox: determinístico (mesma entrada, mesmos bytes), marcado como simulado no próprio arquivo e sem tocar em nenhum pixel.
 * O renderizador nunca recebe operação fora da allowlist (video.operations): quem registra um real só implementa as quatro operações do livro.
 */
const FTYP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
const DEFAULT_SECONDS_PER_MEDIA = 3;

let renderer = null;
const registerRenderer = (fn) => { if (typeof fn !== 'function') throw new TypeError('O renderizador deve ser uma função.'); renderer = fn; };
const clearRenderer = () => { renderer = null; };

function durationOf(spec) {
  if (Number.isInteger(spec.durationS) && spec.durationS > 0) return spec.durationS;
  const cuts = spec.operations.filter((o) => o.op === 'CUT').reduce((sum, o) => sum + (o.endS - o.startS), 0);
  return Math.max(1, Math.round(cuts || spec.sources.length * DEFAULT_SECONDS_PER_MEDIA));
}

/** Renderizador do sandbox: cabeçalho de arquivo MP4 e o manifesto da montagem (origens, operações, simulado = true). */
async function sandboxRenderer(spec) {
  const durationS = durationOf(spec);
  const manifest = { sandbox: true, format: spec.format, aspectRatio: spec.aspectRatio, durationS, sources: spec.sources, operations: spec.operations, synthetic: spec.syntheticKinds };
  return { buffer: Buffer.concat([FTYP, Buffer.from(JSON.stringify(manifest), 'utf8')]), mimeType: 'video/mp4', aspectRatio: spec.aspectRatio, durationS };
}

/** spec: { sources: [{fileId, sha256}], operations, format, aspectRatio, durationS, syntheticKinds } -> { buffer, mimeType, aspectRatio, durationS }. */
async function render(spec) {
  const out = await (renderer || sandboxRenderer)(spec);
  if (!out || !Buffer.isBuffer(out.buffer) || out.buffer.length === 0) throw new Error('O renderizador não devolveu o arquivo.');
  return out;
}

module.exports = { registerRenderer, clearRenderer, render };
