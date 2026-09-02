/**
 * SAN & CO. — backend/services/panteaoRepo.js
 * Camada de dados do Panteão. Só conversas individuais com a Miriel
 * persistem por enquanto — é a única de verdade conectada; Lux e Nova
 * continuam simuladas no front, então conversas do Conselho (modo
 * 'multi') nunca chegam aqui ainda.
 *
 * ESQUEMA (schema-supabase.sql, bloco 2)
 *   panteao_conversas   id (uuid), titulo, titulo_manual, modo,
 *                       agente_id, excluida_em, drive_file_id,
 *                       criada_em, atualizada_em
 *   panteao_mensagens   id (uuid), conversa_id, autor, agente_id, texto,
 *                       acoes (jsonb), timeline (jsonb), criada_em
 *
 * ARQUIVAMENTO NO DRIVE — a coluna drive_file_id já existe no schema pra
 * quando "excluir conversa" virar "arquivar no Drive" de verdade. Esta
 * versão só faz o soft-delete (excluida_em) — gravar o arquivo em si
 * ainda não está construído, é a próxima camada em cima desta.
 */

import { getSupabase } from './supabaseClient.js';

const supabase = getSupabase();

/**
 * Conversas ativas (não excluídas), mais recente primeiro — o que a
 * sidebar do Panteão carrega ao abrir. Só metadado, sem mensagens (fica
 * leve); as mensagens vêm por obterConversaComMensagens quando a conversa
 * específica é aberta.
 */
export async function listarConversas() {
  const { data, error } = await supabase
    .from('panteao_conversas')
    .select('id, titulo, titulo_manual, modo, agente_id, criada_em, atualizada_em')
    .is('excluida_em', null)
    .order('atualizada_em', { ascending: false });

  if (error) throw new Error(`Supabase/panteao_conversas: ${error.message}`);
  return data;
}

/** Uma conversa com todas as mensagens, em ordem cronológica. */
export async function obterConversaComMensagens(id) {
  const { data: conversa, error: erroConversa } = await supabase
    .from('panteao_conversas')
    .select('id, titulo, titulo_manual, modo, agente_id, criada_em, atualizada_em')
    .eq('id', id)
    .single();
  if (erroConversa) throw new Error(`Supabase/panteao_conversas: ${erroConversa.message}`);

  const { data: mensagens, error: erroMensagens } = await supabase
    .from('panteao_mensagens')
    .select('id, autor, agente_id, texto, acoes, timeline, criada_em')
    .eq('conversa_id', id)
    .order('criada_em', { ascending: true });
  if (erroMensagens) throw new Error(`Supabase/panteao_mensagens: ${erroMensagens.message}`);

  return { ...conversa, mensagens };
}

/**
 * Cria uma conversa nova — chamada na primeira mensagem real dela, nunca
 * antes (o front não cria uma linha no banco só por abrir "Nova
 * conversa" vazia).
 * @param {{ titulo?: string, modo?: 'multi'|'individual', agenteId?: string|null }} dados
 */
export async function criarConversa({ titulo, modo = 'multi', agenteId = null }) {
  const { data, error } = await supabase
    .from('panteao_conversas')
    .insert({ titulo: titulo || 'Nova conversa', modo, agente_id: agenteId })
    .select()
    .single();

  if (error) throw new Error(`Supabase/panteao_conversas insert: ${error.message}`);
  return data;
}

/** Renomear (marca titulo_manual — nunca mais sobrescrito automaticamente). */
export async function renomearConversa(id, titulo) {
  const { error } = await supabase
    .from('panteao_conversas')
    .update({ titulo, titulo_manual: true, atualizada_em: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Supabase/panteao_conversas update: ${error.message}`);
}

/**
 * Soft-delete — marca excluida_em, não apaga a linha. O gatilho de
 * "virar arquivo no Drive" (drive_file_id) ainda não existe; quando
 * existir, entra ANTES deste update, gravando o arquivo primeiro.
 */
export async function arquivarConversa(id) {
  const { error } = await supabase
    .from('panteao_conversas')
    .update({ excluida_em: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Supabase/panteao_conversas update: ${error.message}`);
}

/**
 * Grava uma mensagem e atualiza atualizada_em da conversa (pra ordenar a
 * sidebar pela mais recente ativa, não pela mais recente criada).
 * @param {{ conversaId: string, autor: string, agenteId?: string|null, texto: string, acoes?: Array, timeline?: object|null }} dados
 */
export async function adicionarMensagem({ conversaId, autor, agenteId = null, texto, acoes = [], timeline = null }) {
  const { data, error } = await supabase
    .from('panteao_mensagens')
    .insert({ conversa_id: conversaId, autor, agente_id: agenteId, texto, acoes, timeline })
    .select()
    .single();

  if (error) throw new Error(`Supabase/panteao_mensagens insert: ${error.message}`);

  await supabase
    .from('panteao_conversas')
    .update({ atualizada_em: new Date().toISOString() })
    .eq('id', conversaId);

  return data;
}

/**
 * O histórico de uma conversa, no formato que perguntarGemini() espera
 * (ver geminiService.js) — autor vira 'usuario' ou 'agente', a Gemini não
 * precisa saber qual dos três agentes falou, só a alternância de papéis.
 */
export async function historicoParaGemini(conversaId) {
  const { data, error } = await supabase
    .from('panteao_mensagens')
    .select('autor, texto')
    .eq('conversa_id', conversaId)
    .order('criada_em', { ascending: true });

  if (error) throw new Error(`Supabase/panteao_mensagens: ${error.message}`);

  return data
    .filter((m) => m.texto)   // mensagem em progresso (texto ainda vazio) não entra
    .map((m) => ({ autor: m.autor === 'usuario' ? 'usuario' : 'agente', texto: m.texto }));
}
