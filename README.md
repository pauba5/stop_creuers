# Stop Creuers - Alerta Diària

Aquest projecte conté l'script per generar l'alerta diària de creuers al Port de Barcelona i enviar-la per Telegram.

## Com pujar-ho a GitHub

1. Ves a [GitHub](https://github.com/new) i crea un nou repositori buit (sense README ni llicència).
2. Des de la teva terminal, en la carpeta del projecte (`/Users/pauba/.gemini/antigravity/scratch/port-bcn-creuers`), executa aquestes comandes:

```bash
git remote add origin https://github.com/el-teu-usuari/el-teu-repositori.git
git branch -M main
git push -u origin main
```

*(Substitueix l'URL del repositori per l'URL del repositori de GitHub que acabes de crear).*

## Com desplegar a Railway

Aquest projecte està preparat per desplegar-se nativament a Railway usant l'script de `start` que hi ha al `package.json`.

1. Accedeix a [Railway](https://railway.app/).
2. Fes clic a **New Project** -> **Deploy from GitHub repo**.
3. Selecciona el repositori que has creat.
4. **Molt important**: El programa actualment està dissenyat per executar-se com un *Cron Job* (feina programada), per tant a Railway hauries de:
   - Configurar les Variables d'Entorn (Environment Variables) necessàries (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, etc.). Pots fer-ho a la pestanya **Variables**.
   - Anar a **Settings** -> **Deploy** del servei.
   - Pots definir una *Cron Schedule* (per exemple, perquè s'executi cada dia a les 08:00 AM) i a la *Start Command* posar-hi: `npm start`.
   - Si no l'hi poses com a cron i ho fas com a servei normal, s'executarà un cop i acabarà la instància. 
