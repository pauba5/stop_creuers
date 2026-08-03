import axios from 'axios';
import Papa from 'papaparse';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { extractPaxFromPDF } from './extract_pdf.js';

// Carregar variables d'entorn
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CSV_URL = "https://opendata.portdebarcelona.cat/dataset/0a5f703d-35e5-4262-84ac-b6930239f4aa/resource/9c803939-6ea4-4095-aa82-11127538154a/download/portbcncreuers.csv";

const PAX_PER_SHIP = 3500;

// Filtre de ferris segons la metodologia
const ferryKeywords = [
    'GNV', 'GRIMALDI', 'BALEARIA', 'TRASMED', 'CRUISE ROMA', 'CRUISE BARCELONA', 
    'CRUISE SARDEGNA', 'CRUISE EUROPA', 'MAJESTIC', 'TENACIA', 'ABEL MATUTES', 
    'MARGARITA SALAS', 'CIUDAD DE', 'HYPATIA', 'ROSALIND FRANKLIN', 'KERRY', 
    'VOLCAN DE', 'MARTIN I SOLER', 'MARTÍN I SOLER', 'FLORENCIA', 'EXCELLENT', 
    'EXCELSIOR', 'LA SUPREMA', 'ECO ', 'ELEANOR', 'SICILIA', 'NAPOLI', 
    'CAP DE BARBARIA', 'RAMON LLULL', 'JAUME', 'MARIE CURIE', 'VISUVIUS',
    'GUBAL', 'DENIA', 'JINANAH', 'ULUSOY'
];

function isFerry(shipName) {
    if (!shipName) return false;
    const name = shipName.toUpperCase();
    return ferryKeywords.some(keyword => name.includes(keyword));
}

// Funció que ara utilitza l'extracció directa de PDF
async function computeCapacitatTotal(shipName) {
    try {
        console.log(`[PASSATGERS] Buscant passatgers reals del vaixell: ${shipName}`);
        const exactPax = await extractPaxFromPDF(shipName);
        if (exactPax !== null) {
            console.log(`[PASSATGERS] Èxit! Nombre exacte obtingut del PDF pel ${shipName}: ${exactPax}`);
            return exactPax;
        }
    } catch (e) {
        console.warn(`[PASSATGERS] Error extreient PDF per ${shipName}: ${e.message}`);
    }
    
    console.warn(`⚠️ No s'ha pogut extreure els passatgers exactes per al vaixell: ${shipName}. S'ignorarà aquest vaixell.`);
    return null;
}

// Llegir la imatge local com a base64
async function getBase64Logo() {
    try {
        const logoPath = join(__dirname, 'assets', 'logo.png');
        const logoBuffer = await fs.readFile(logoPath);
        return `data:image/png;base64,${logoBuffer.toString('base64')}`;
    } catch (e) {
        console.error("No s'ha trobat el logo local.", e.message);
        return "";
    }
}

async function run() {
    console.log("Descarregant previsió a 7 dies...");
    let response;
    let retries = 6;
    let success = false;

    while (retries > 0 && !success) {
        try {
            // Augmentem el timeout a 60s per ser més permissius
            response = await axios.get(CSV_URL, { timeout: 60000 });
            success = true;
        } catch (error) {
            retries--;
            console.error(`❌ Error connectant amb l'API del Port de Barcelona: ${error.message}. Intents restants: ${retries}`);
            if (retries > 0) {
                console.log("⏳ Reintentant en 5 minuts...");
                await new Promise(res => setTimeout(res, 300000));
            } else {
                if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                    const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
                    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *Error del Servidor del Port*: No s'ha pogut descarregar la previsió de l'Open Data del Port de Barcelona. Després de 6 intents separats per 5 minuts (30 minuts de marge), el servidor segueix sense respondre o donant timeout.", { parse_mode: 'Markdown' });
                }
                return;
            }
        }
    }
    
    const parsed = Papa.parse(response.data, { header: true, skipEmptyLines: true, delimiter: ',' });
    
    const dades = parsed.data;
    
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    const dataAvui = `${day}-${month}`;
    const avuiStr = `${year}-${month}-${day}`;
    
    console.log(`Buscant escales per a avui: ${avuiStr}`);

    const escalesAvui = [];

    for (const row of dades) {
        const vaixell = row['VAIXELLNOM'] || row['NOMVAIXELL'] || row['VAIXELL'] || 'Desconegut';
        
        // El nou CSV d'arribades té el tipus de vaixell a VAIXELLTIPUS
        const tipus = row['VAIXELLTIPUS'] || '';
        
        // Excloure si té tipus i no és passatge
        if (tipus && tipus !== 'Passatge') continue;
        
        // Excloure ferris
        if (isFerry(vaixell)) {
            continue;
        }

        let arribadaStr = row['ETADIA'] || row['ARRIBADA'] || '';
        let sortidaStr = row['ETDDIA'] || row['SORTIDA'] || '';
        let arribadaHora = row['ETAHORA'] || '';
        let sortidaHora = row['ETDHORA'] || '';

        // Separar data i hora si estan juntes (nou format CSV)
        if (arribadaStr.includes(' ')) {
            const parts = arribadaStr.split(' ');
            arribadaStr = parts[0];
            if (!arribadaHora) arribadaHora = parts[1];
        }
        if (sortidaStr.includes(' ')) {
            const parts = sortidaStr.split(' ');
            sortidaStr = parts[0];
            if (!sortidaHora) sortidaHora = parts[1];
        }

        // Funció per convertir DD-MM a Date
        const parseDDMM = (str) => {
            if (!str) return null;
            const parts = str.split('-');
            if (parts.length === 2) {
                return new Date(year, parseInt(parts[1]) - 1, parseInt(parts[0]));
            }
            if (str.includes('-')) {
                // pot ser YYYY-MM-DD
                const p = str.split('-');
                if (p[0].length === 4) return new Date(p[0], parseInt(p[1]) - 1, parseInt(p[2]));
            }
            return null;
        };

        const arrDateObj = parseDDMM(arribadaStr);
        const depDateObj = parseDDMM(sortidaStr);
        const todayObj = new Date(year, today.getMonth(), today.getDate());

        let isAtPortToday = false;
        if (arrDateObj && depDateObj) {
            isAtPortToday = (todayObj >= arrDateObj && todayObj <= depDateObj);
        } else if (arrDateObj) {
            isAtPortToday = (todayObj.getTime() === arrDateObj.getTime());
        } else {
            // fallback
            isAtPortToday = (arribadaStr === avuiStr || sortidaStr === avuiStr || arribadaStr.includes(dataAvui));
        }

        // Comprovem si el vaixell està a port avui
        if (isAtPortToday) {
            let tipusOperacio = "Trànsit";
            if (arribadaHora && sortidaHora && arribadaStr === sortidaStr) {
                const [hA, mA] = arribadaHora.split(':').map(Number);
                const [hS, mS] = sortidaHora.split(':').map(Number);
                const horesEstada = (hS + (mS||0)/60) - (hA + (mA||0)/60);
                if (horesEstada > 10) tipusOperacio = "Port Base";
            } else if (arribadaStr !== sortidaStr) {
                tipusOperacio = "Port Base (Fa nit)";
            }

            let pax = await computeCapacitatTotal(vaixell);
            if (pax === null) {
                continue; // Saltem aquest vaixell perquè assumim que no és un creuer
            }

            escalesAvui.push({
                vaixell,
                moll: row['TERMINALNOM'] || row['MOLL'] || 'Desconegut',
                arribada: arribadaStr,
                sortida: sortidaStr,
                arribadaHora,
                sortidaHora,
                tipusOperacio,
                pax
            });
        }
    }

    // Ordenar per nombre de passatgers de més gran a més petit
    escalesAvui.sort((a, b) => b.pax - a.pax);

    const numVaixellsAvui = escalesAvui.length;
    const paxEstimats = escalesAvui.reduce((sum, v) => sum + v.pax, 0);

    if (numVaixellsAvui === 0 || paxEstimats === 0) {
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            try {
                const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
                await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *Error Detectat*: La previsió ha donat 0 vaixells o 0 passatgers (possible error de format a les dades del Port). S'ha aturat la previsió automàtica per precaució.", { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Error enviant l'avís a Telegram:", err.message);
            }
        }
        console.warn("⚠️ Previsió aturada: 0 vaixells o 0 passatgers detectats.");
        return;
    }

    // Configurar colors i missatges segons semàfor (Estil brutalista Stop Creuers)
    let bgColor = "#10b981"; // Verd esmeralda
    let textColor = "#ffffff";
    let nivellAlerta = "VERDA";
    let semaforIcon = "🟢";
    let logoFilter = "filter: brightness(0) invert(1);";

    if (paxEstimats > 0) {
        bgColor = "#fbbf24"; // Groc
        textColor = "#000000";
        nivellAlerta = "GROGA";
        semaforIcon = "🟡";
        logoFilter = "filter: none;";
    }
    if (paxEstimats > 8000) {
        bgColor = "#f97316"; // Taronja
        textColor = "#ffffff";
        nivellAlerta = "TARONJA";
        semaforIcon = "🟠";
        logoFilter = "filter: brightness(0) invert(1);";
    }
    if (paxEstimats > 15000) {
        bgColor = "#ef4444"; // Vermell
        textColor = "#ffffff";
        nivellAlerta = "VERMELLA";
        semaforIcon = "🔴";
        logoFilter = "filter: brightness(0) invert(1);";
    }
    if (paxEstimats > 50000) {
        bgColor = "#000000"; // Negre pur
        textColor = "#ffffff";
        nivellAlerta = "NEGRA";
        semaforIcon = "⚫";
        logoFilter = "filter: brightness(0) invert(1);";
    }

    // Preparar missatge de text complet per Telegram
    let missatge = `🛳 *Previsió Diària - Port de Barcelona*\n`;
    missatge += `Data: ${dataAvui}\n\n`;
    missatge += `📊 *Semàfor de Pressió*: ${semaforIcon} ALERTA ${nivellAlerta}\n`;
    missatge += `👥 *Pax Estimat Total*: ${paxEstimats.toLocaleString()} passatgers\n\n`;
    missatge += `*Vaixells previstos avui:*\n`;

    let llistaVaixellsHtml = "";

    if (numVaixellsAvui === 0) {
        missatge += `No hi ha vaixells programats avui.\n`;
        llistaVaixellsHtml = `<div class="no-ships">Cap creuer programat per avui.</div>`;
    } else {
        // Mostrem tots els vaixells (el canvas s'adaptarà a l'alçada)
        for (let i = 0; i < escalesAvui.length; i++) {
            const v = escalesAvui[i];
            const tArribada = v.arribadaHora || v.arribada;
            const tSortida = v.sortidaHora || v.sortida;
            llistaVaixellsHtml += `
                <div class="ship-card">
                    <div class="ship-name">${v.vaixell}</div>
                    <div class="ship-details" style="font-weight: 700; opacity: 1;">👥 ${v.pax.toLocaleString()} pax</div>
                    <div class="ship-details">${tArribada} a ${tSortida} | ${v.moll}</div>
                    <div class="ship-tag">${v.tipusOperacio}</div>
                </div>
            `;
        }
        
        escalesAvui.forEach(v => {
            missatge += `- *${v.vaixell}* (${v.pax.toLocaleString()} pax)\n  ${v.moll} | ${v.arribada} a ${v.sortida} -> _${v.tipusOperacio}_\n`;
        });
    }

    missatge += `\n*FONT:* Port de Barcelona\n[PDF de previsió](https://opendata.portdebarcelona.cat/dataset/0a5f703d-35e5-4262-84ac-b6930239f4aa/resource/695fb2cc-6a71-43a1-a040-4d907b6a2472/download/portbcncreuersferris7dies.pdf)\n`;

    const browser = await puppeteer.launch({ 
        headless: 'new', 
        defaultViewport: { width: 1080, height: 1080 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    const base64Logo = await getBase64Logo();

    // 1. GENERAR IMATGE SEMÀFOR
    console.log("Generant imatge Semàfor...");
    const templateSemaforPath = join(__dirname, 'template_semafor.html');
    let templateSemafor = await fs.readFile(templateSemaforPath, 'utf8');
    templateSemafor = templateSemafor
        .replace(/{{BG_COLOR}}/g, bgColor)
        .replace(/{{TEXT_COLOR}}/g, textColor)
        .replace('{{LOGO_FILTER}}', logoFilter)
        .replace('{{LOGO_SRC}}', base64Logo)
        .replace('{{DATA_AVUI}}', dataAvui)
        .replace('{{NIVELL_ALERTA}}', nivellAlerta)
        .replace('{{PAX_ESTIMATS}}', paxEstimats.toLocaleString())
        .replace('{{NUM_VAIXELLS}}', numVaixellsAvui);
    
    const page1 = await browser.newPage();
    await page1.setContent(templateSemafor, { waitUntil: 'load' });
    const bufferSemafor = await (await page1.$('#capture-area')).screenshot();

    // 2. GENERAR IMATGE DETALL (Mida fixa 1080x1080 amb dense-mode si cal)
    console.log("Generant imatge Detall Vaixells...");
    const templateDetallPath = join(__dirname, 'template_detall.html');
    let templateDetall = await fs.readFile(templateDetallPath, 'utf8');
    templateDetall = templateDetall
        .replace(/{{BG_COLOR}}/g, bgColor)
        .replace(/{{TEXT_COLOR}}/g, textColor)
        .replace('{{LOGO_FILTER}}', logoFilter)
        .replace('{{LOGO_SRC}}', base64Logo)
        .replace('{{DATA_AVUI}}', dataAvui)
        .replace('{{DENSE_CLASS}}', numVaixellsAvui > 12 ? 'dense-mode' : '')
        .replace('{{LLISTA_VAIXELLS_HTML}}', llistaVaixellsHtml);
        
    const page2 = await browser.newPage();
    await page2.setContent(templateDetall, { waitUntil: 'load' });
    const bufferDetall = await (await page2.$('#capture-area')).screenshot();

    await browser.close();
    console.log("Dues imatges generades correctament.");

    // Enviament a Telegram
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
            console.log("Enviant l'àlbum a Telegram...");
            const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
            
            await bot.telegram.sendMediaGroup(TELEGRAM_CHAT_ID, [
                { type: 'photo', media: { source: Buffer.from(bufferSemafor) } },
                { type: 'photo', media: { source: Buffer.from(bufferDetall) } }
            ]);
            
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, missatge, {
                parse_mode: 'Markdown'
            });
            console.log("✅ Enviat correctament.");
        } catch (error) {
            console.error("❌ Error enviant a Telegram:", error.message);
        }
    } else {
        console.log("⚠️ No s'ha enviat a Telegram perquè falten les variables d'entorn.");
    }
}

// Timeout global per evitar que es pengi a Railway (ex: 40 minuts)
setTimeout(() => {
    console.error("⏳ Timeout global: L'script ha trigat massa (més de 40 minuts). Es força el tancament.");
    process.exit(1);
}, 2400000);

run().then(() => {
    console.log("Fi de l'execució de l'script.");
    process.exit(0);
}).catch(async err => {
    console.error("❌ Error no controlat a l'script:", err);
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
            const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `⚠️ *Error Intern de Processament*: Ha fallat la generació de l'alerta.\n\nMotiu: ${err.message}`, { parse_mode: 'Markdown' });
        } catch (tErr) {
            console.error("No s'ha pogut enviar error intern a Telegram", tErr);
        }
    }
    process.exit(1);
});
