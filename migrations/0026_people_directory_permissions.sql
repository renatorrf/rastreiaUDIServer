SET LOCAL search_path TO rastreia, public;

-- A manutenção do escopo de lojas substitui o conjunto anterior dentro de uma
-- transação autenticada e protegida por FORCE RLS.
GRANT DELETE ON user_store_access TO rastreia_runtime;
