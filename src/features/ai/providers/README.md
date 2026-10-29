# providers
Adapters de modelo e o ModelRouter. Único lugar de src/features/ai que pode tocar SDK ou host de fornecedor (AI-002).

- `AIProviderAdapter` (M9-D010): a tomada comum (estende `IntegrationAdapter` por meio do port `AiAdapter`). `capabilities()` é a lista de operações, `models()` o catálogo, erros saem como `AiProviderError`, custo em reais com 6 casas. HTTP só por `ctx.http` (`IntegrationHttpClient`); credencial só por `ctx.secret()` no instante da chamada.
- `HttpModelAdapter` e as pastas `anthropic/` e `openai/`: adapters reais. Preços, limites, região e `safetyTier` dos modelos vêm de `config_json.models` da conexão; o endereço pode ser trocado por `config_json.baseUrl`.
- `sandbox/`: o provedor `ai-sandbox`, determinístico e sem rede (fixtures `[[ECO]]`, `[[JSON:{...}]]`, `[[TOOL:nome:{...}]]`, `[[FALHA:x]]`, `[[LENTO:ms]]`, `[[CUSTO:valor]]`).
- `ProviderRegistry` (M9-D011): visão do registro de integrações (domínio AI). `register`, `resolve`, `list`, `instance` (sandbox recusado em produção; real só com conexão ativa) e `candidates` (capability, política, criticidade, custo e latência). Não existe tabela `ai.providers`: o provedor é linha de `integration.providers` com `integration.connections`.
- Parâmetros: `ia.provedor.padrao`, `ia.provedor.safety_tier_minimo_critico` e `ia.ambiente` (`providers.settings.js`).
