# envios-hub-v2 — Instrucciones para Claude

## ANTES DE CUALQUIER CAMBIO AL CÓDIGO

Siempre ejecutar estos comandos al inicio de la sesión:

```bash
cd /sessions/sharp-bold-meitner/envios-hub-fresh
git fetch origin
git reset --hard origin/main
git log --oneline -3
```

Esto garantiza que el clone del sandbox esté sincronizado con el remote antes de editar.
Si el directorio no existe, clonar de cero:

```bash
git clone https://github.com/maxidottori-dev/envios-hub-v2.git /sessions/sharp-bold-meitner/envios-hub-fresh
```

## FLUJO DE TRABAJO

1. Sincronizar con `git reset --hard origin/main` (ver arriba)
2. Editar `src/App.jsx` en `/sessions/sharp-bold-meitner/envios-hub-fresh/src/App.jsx`
3. Copiar al repo montado: `cp .../envios-hub-fresh/src/App.jsx .../mnt/Logisticas/envios-hub-v2/src/App.jsx`
4. El usuario hace `git add src\App.jsx && git commit -m "..." && git push origin main` desde PowerShell
5. Verificar deploy en Vercel con el MCP de Vercel

## STACK

- React + Vite (single file: `src/App.jsx`)
- Firebase Firestore (cliente web SDK)
- Vercel (deploy automático desde GitHub `main`)
- APIs propias en `/api/` (serverless functions Vercel)

## REGLAS IMPORTANTES

- **Nunca editar `src/App.jsx` sin haber sincronizado primero con origin/main**
- Siempre revisar el deploy en Vercel después de cada push
- Responder en español
- El usuario no puede compartir tokens/credenciales en el chat por seguridad
