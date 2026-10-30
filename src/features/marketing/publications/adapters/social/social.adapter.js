'use strict';

const { SandboxChannelAdapter } = require('../sandbox/SandboxChannelAdapter');
const { RealChannelAdapter } = require('../real/RealChannelAdapter');
const { DEFAULT_CAPABILITIES } = require('./networks');
const { assertContentFits } = require('./social.capabilities');
const { normalizeResultError } = require('./social.errors');
const { watermarkFor, applyWatermark } = require('./social.watermark');

const VIDEO_FORMATS = ['VIDEO', 'REEL'];
const REDACTED_MARKER = '[REDIGIDO]';

/** O que a mídia informa para a conferência de capability (formato, proporção, duração e tamanho) a partir do resumo da mídia do conteúdo. */
const contentOf = (post, media) => ({
  caption: post && typeof post.texto === 'string' ? post.texto : '',
  format: media ? media.formato : null, ratio: media ? media.proporcao : null, durationS: media ? media.duracaoS : null, sizeBytes: media ? media.tamanhoBytes : null,
});

/** Referência da mídia que vai ao provedor real: só id, formato e hash, nunca caminho do arquivo. */
const mediaRef = (media) => ({ fileId: media.arquivoId, format: media.formato, sha256: media.sha256 });

/**
 * M9-D428 — o que é comum aos cinco adapters de rede, sobre o sandbox ou sobre o adapter real: capabilities da rede, conferência antes de enviar (a segunda trava, depois
 * da do agendamento), marca de idempotência no texto (a rede não tem chave de idempotência) e erros com o código do Marketing. `opts`: networkCaps, watermarkMode,
 * hashtagPrefix e tolerancePct, lidos dos parâmetros da empresa (na falta valem os padrões de networks.js).
 */
function socialMixin(Base, network) {
  return class SocialNetworkAdapter extends Base {
    constructor(channel, ...args) {
      super(channel || network, ...args);
      const opts = (Base === SandboxChannelAdapter ? args[0] : args[1]) || {};
      this.network = network;
      this.caps = opts.networkCaps || DEFAULT_CAPABILITIES[network];
      this.watermarkOptions = { mode: opts.watermarkMode, hashtagPrefix: opts.hashtagPrefix };
      this.tolerancePct = Number.isFinite(opts.tolerancePct) ? opts.tolerancePct : 2;
    }

    /** As capabilities da rede (formatos, proporções, duração, tamanho, legenda). Não confundir com capabilities(), que lista as operações do contrato. */
    networkCapabilities() { return this.caps; }

    watermark(key) { return watermarkFor(key, this.watermarkOptions); }

    /** Cópia sem segredo (redação do bloco B, M9-D246) com o marcador único do Marketing, [REDIGIDO], em lugar do [REDACTED] da biblioteca. */
    redact(value) { return JSON.parse(JSON.stringify(super.redact(value)).split('[REDACTED]').join(REDACTED_MARKER)); }

    /** Confere o conteúdo e devolve o post já com a marca. A chave inválida segue para a validação do adapter de base. */
    prepare(post, options = {}) {
      const mark = this.watermark(String(options.idempotencyKey || ''));
      assertContentFits({ network, caps: this.caps, content: contentOf(post, options.media), tolerancePct: this.tolerancePct, reserve: mark.suffix.length });
      return { mark, marked: applyWatermark(post, mark) };
    }

    finish(result, mark, options) {
      const processing = result.status === 'PUBLISHED' && !result.replayed && options.media && VIDEO_FORMATS.includes(options.media.formato) && this.isSandbox;
      return { ...normalizeResultError(result), ...(processing ? { status: 'PROCESSING' } : {}), watermark: mark.code };
    }
  };
}

/** Sandbox da rede: o simulador determinístico do bloco D430 com as regras da rede. Vídeo entra em PROCESSING e só vira LIVE quando o canal é consultado. */
function socialSandbox(network) {
  return class SocialSandbox extends socialMixin(SandboxChannelAdapter, network) {
    async publish(post, options = {}) {
      const { mark, marked } = this.prepare(post, options);
      return this.finish(await super.publish(marked, options), mark, options);
    }

    async getStatus(providerRef) {
      const status = await super.getStatus(providerRef);
      return status.found ? { ...status, status: 'LIVE' } : status;
    }
  };
}

/** Adapter real da rede: o RealChannelAdapter do bloco D430 (token só pelo cofre, `ctx.secret`) com as regras da rede e a busca do post pela marca. */
function socialReal(network) {
  return class SocialReal extends socialMixin(RealChannelAdapter, network) {
    async publish(post, options = {}) {
      const { mark, marked } = this.prepare(post, options);
      const body = options.media ? { ...marked, media: mediaRef(options.media) } : marked;
      return this.finish(await super.publish(body, options), mark, options);
    }

    /** A rede não guarda a chave: procura o post pelo código da marca, que sai da mesma chave. */
    async findByIdempotencyKey(key) {
      return super.findByIdempotencyKey(this.watermark(key).code);
    }
  };
}

module.exports = { socialSandbox, socialReal, contentOf };
