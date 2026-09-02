/**
 * SAN & CO. — backend/services/supabaseClient.js
 * Cliente Supabase compartilhado — um só, reaproveitado por qualquer
 * serviço que precisar dele (financasRepo.js, e no futuro panteaoRepo.js,
 * rotinaRepo.js, etc.), em vez de cada arquivo criar o próprio.
 *
 * Usa a service_role key — acesso total, ignora RLS por padrão (ver a
 * nota sobre isso no topo de schema-supabase.sql). Por isso este arquivo
 * NUNCA deve ser importado por nada que rode no navegador — só backend.
 */

import { createClient } from '@supabase/supabase-js';

let cliente = null;

/**
 * Devolve um Proxy, não o cliente direto — a checagem de variáveis de
 * ambiente só acontece na hora em que ALGUÉM DE FATO USA o Supabase
 * (`supabase.from(...)`), não no momento em que este arquivo é importado.
 *
 * Isso importa de verdade: sem isso, qualquer arquivo que só IMPORTASSE
 * financasRepo.js (mesmo sem chamar nenhuma função dele) derrubaria o
 * servidor inteiro se SUPABASE_URL/SUPABASE_SERVICE_KEY não estivessem no
 * .env — foi exatamente esse padrão de erro que quebrou o backend antes,
 * com financasRepo.js e o pacote do Supabase não instalado.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function getSupabase() {
  if (cliente) return cliente;

  const criarClienteReal = () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error(
        'SUPABASE_URL e/ou SUPABASE_SERVICE_KEY faltando no .env do backend. '
        + 'Pegue os dois em Configurações > API do projeto no Supabase '
        + '(a chave certa é a "service_role", não a "anon" — a anon respeita '
        + 'RLS e não tem permissão pra tudo que o backend precisa fazer).'
      );
    }
    cliente = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    return cliente;
  };

  // o Proxy adia a checagem: acessar QUALQUER propriedade (ex.: .from)
  // é o gatilho que cria o cliente de verdade — não o import do arquivo
  return new Proxy({}, {
    get(_alvo, propriedade) {
      const real = criarClienteReal();
      const valor = real[propriedade];
      return typeof valor === 'function' ? valor.bind(real) : valor;
    }
  });
}
