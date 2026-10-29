# retrieval
RAG da NAY (M9-D022 e M9-D023): ingestão segura de arquivo, URL e conhecimento homologado e busca isolada por empresa e permissão.

- `ingestion.*`: pipeline autorização -> malware -> hash -> classificação -> leitura (`parse/`) -> segredos (`secretScanner.js`) e PII -> chunks (`chunker.js`) -> vetores (`embedder.js`) -> índice. Estados em `ai.ingestions`; recusa de conteúdo grava REJECTED (não lança), o controller converte em 422 depois do commit.
- `urlFetcher.js`: URL só por pedido humano, com a lista `ia.rag.dominios_permitidos` E a do guarda SSRF (`nay_document`); a rede é toda de `ssrfGuard.fetchExternalUrl` (M9-D245).
- `RetrievalService.js`: empresa/estado -> permissão/classificação (no banco, antes de ler conteúdo) -> similaridade e texto -> rerank determinístico -> dupla checagem na origem (`doubleCheck.js`) -> `ai_sources`. O resultado é `untrusted`; o RAG nunca soma permissão.
- `reconcileJob.js`: copia permissão e classificação da origem para os chunks (job `src/engines/jobs/aiRagJob.js`, a cada `ia.rag.reconciliar_minutos`).
- SQL só em `../readmodels/ragSupport.readmodel.js` (archGuard AI-004). Parâmetros `ia.rag.*` em `retrieval.settings.js`.
- Rotas: `POST /v1/ai/ingestions`, `GET /v1/ai/ingestions/:id`, `PUT /v1/ai/files/:fileId/classification`.
