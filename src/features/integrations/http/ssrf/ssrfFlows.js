'use strict';

/**
 * Fluxos que baixam URL de terceiro (M9-D245 3.1 item 8). Cada fluxo declara os hosts que o próprio fornecedor usa e os
 * tipos de conteúdo que aceita; a empresa soma hosts em `integration.ssrf.fetch_allowlist` (fluxo:host1,host2). Um fluxo
 * sem host declarado nem configurado não baixa nada. A allowlist de saída dos fornecedores (M9-D244) nunca vale aqui.
 */
const flows = new Map();

function registerFlow({ code, hosts = [], contentTypes = [] }) {
  flows.set(code, Object.freeze({ code, hosts: Object.freeze(hosts.map((h) => h.toLowerCase())), contentTypes: Object.freeze(contentTypes.map((t) => t.toLowerCase())) }));
}

const getFlow = (code) => flows.get(code) || null;
const listFlows = () => [...flows.values()];

// Documento assinado devolvido pelo fornecedor de assinatura (Clicksign e ZapSign entregam por link do próprio domínio ou do S3).
registerFlow({ code: 'signature_download', hosts: ['*.clicksign.com', '*.zapsign.com.br', '*.amazonaws.com'], contentTypes: ['application/pdf'] });
// Fotos de anúncio enviadas por portal (M9-D231/D232), mídia de mensagem recebida (M9-D230) e documento citado à NAY (M9-D022):
// sem host de fábrica; cada empresa informa os CDNs que aceita.
registerFlow({ code: 'portal_photo', contentTypes: ['image/jpeg', 'image/png', 'image/webp'] });
registerFlow({ code: 'message_media', contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] });
registerFlow({ code: 'nay_document', contentTypes: ['application/pdf', 'image/jpeg', 'image/png'] });
registerFlow({ code: 'import_by_url', contentTypes: ['application/pdf', 'image/jpeg', 'image/png'] });

module.exports = { registerFlow, getFlow, listFlows };
