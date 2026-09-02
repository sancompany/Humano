/**
 * SAN & CO. — backend/services/auditoriaAgentes.js
 * Registro de toda ação de ESCRITA que um agente executa de verdade
 * (criar compromisso, mandar e-mail...). Não é log de debug — é o
 * mecanismo de supervisão combinado com o usuário: em vez de travar cada
 * ação esperando confirmação prévia, a Miriel age direto, e toda mudança
 * fica registrada aqui, consultável a qualquer momento.
 *
 * Leitura (consultar Financeiro, listar e-mails, listar compromissos)
 * NUNCA passa por aqui — só o que muda algo de verdade entra no registro.
 *
 * Quando Lux e Nova existirem de verdade, é esta mesma tabela que dá a
 * elas o que precisam pra "contestar" uma ação da Miriel — ainda não
 * construído, mas o registro já nasce no formato certo pra isso.
 */

import { getSupabase } from './supabaseClient.js';

const supabase = getSupabase();

/**
 * @param {{ agenteId: string, ferramenta: string, parametros: object, resultado: object }} dados
 */
export async function registrarAcaoAgente({ agenteId, ferramenta, parametros, resultado }) {
  const { error } = await supabase.from('acoes_agentes').insert({
    agente_id: agenteId,
    ferramenta,
    parametros,
    resultado
  });
  if (error) throw new Error(`Supabase/acoes_agentes insert: ${error.message}`);
}

/** As ações mais recentes — o que uma futura tela de consulta lista. */
export async function listarAcoesAgentes({ limite = 50 } = {}) {
  const { data, error } = await supabase
    .from('acoes_agentes')
    .select('id, agente_id, ferramenta, parametros, resultado, criada_em')
    .order('criada_em', { ascending: false })
    .limit(Math.min(limite, 200));
  if (error) throw new Error(`Supabase/acoes_agentes: ${error.message}`);
  return data;
}
