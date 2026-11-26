import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Verdadeiro somente se as duas variáveis de ambiente foram configuradas
// corretamente (evita que o app trave com uma tela em branco).
export const configOk = Boolean(url && key && /^https?:\/\//.test(url));

export const supabase = configOk
  ? createClient(url, key)
  : null;

// Simple key-value persistence on top of a single Supabase table (kv_store).
// Each "key" (funcionarios, obras, registros, edicoes, config) stores one JSON blob.
export async function loadKey(key_, fallback) {
  if (!configOk) return fallback;
  try {
    const { data, error } = await supabase
      .from("kv_store")
      .select("value")
      .eq("key", key_)
      .maybeSingle();
    if (error || !data) return fallback;
    return data.value;
  } catch {
    return fallback;
  }
}

export async function saveKey(key_, value) {
  if (!configOk) return;
  try {
    await supabase
      .from("kv_store")
      .upsert({ key: key_, value, updated_at: new Date().toISOString() });
  } catch (e) {
    console.error("Erro ao salvar", key_, e);
  }
}
