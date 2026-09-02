-- ============================================================================
-- SAN & CO. — Migração 003: auditoria de ações dos agentes
--
-- Registra toda ação de ESCRITA que um agente executa de verdade (criar
-- compromisso, mandar e-mail) — é o mecanismo de supervisão combinado
-- com o usuário no lugar de bloquear cada ação esperando confirmação
-- prévia. Leitura (consultar Financeiro, listar e-mails/compromissos)
-- nunca entra aqui — só o que muda algo de verdade.
--
-- COMO RODAR: cole no SQL Editor do Supabase e execute — é aditivo, não
-- toca em nenhuma tabela existente.
-- ============================================================================

CREATE TABLE acoes_agentes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agente_id    TEXT NOT NULL,            -- 'hermes' (Miriel) hoje; só ela escreve por enquanto
  ferramenta   TEXT NOT NULL,            -- ex.: 'enviar_email', 'criar_compromisso'
  parametros   JSONB NOT NULL DEFAULT '{}',
  resultado    JSONB,
  criada_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_acoes_agentes_criada ON acoes_agentes (criada_em DESC);

ALTER TABLE acoes_agentes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_via_service_role" ON acoes_agentes FOR ALL USING (true) WITH CHECK (true);
