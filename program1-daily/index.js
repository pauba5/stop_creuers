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
    'GUBAL', 'DENIA', 'JINANAH'
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
    
    // Si no es troba al PDF (ex: error de lectura o PDF no disponible) llencem error en comptes de posar 3500
    throw new Error(`No s'ha pogut extreure els passatgers exactes per al vaixell: ${shipName}`);
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
    try {
        response = await axios.get(CSV_URL, { timeout: 15000 });
    } catch (error) {
        console.error("❌ Error connectant amb l'API del Port de Barcelona:", error.message);
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "⚠️ *Error*: No s'ha pogut descarregar la previsió de l'Open Data del Port de Barcelona. El servidor no respon.", { parse_mode: 'Markdown' });
        }
        return;
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

        const arribadaStr = row['ETADIA'] || row['ARRIBADA'] || '';
        const sortidaStr = row['ETDDIA'] || row['SORTIDA'] || '';
        const arribadaHora = row['ETAHORA'] || '';
        const sortidaHora = row['ETDHORA'] || '';

        // Comprovem si el vaixell arriba o surt avui
        if (arribadaStr === avuiStr || sortidaStr === avuiStr || arribadaStr.includes(dataAvui)) {
            let tipusOperacio = "Trànsit";
            if (arribadaHora && sortidaHora && arribadaStr === sortidaStr) {
                const [hA, mA] = arribadaHora.split(':').map(Number);
                const [hS, mS] = sortidaHora.split(':').map(Number);
                const horesEstada = (hS + mS/60) - (hA + mA/60);
                if (horesEstada > 10) tipusOperacio = "Port Base";
            } else if (arribadaStr !== sortidaStr) {
                tipusOperacio = "Port Base (Fa nit)";
            }

            let pax;
            try {
                pax = await computeCapacitatTotal(vaixell);
            } catch (err) {
                console.error(err.message);
                if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                    const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
                    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `⚠️ *Error de Precisió de Dades*: ${err.message}. S'ha aturat l'alerta per no publicar dades falses/estimades.`, { parse_mode: 'Markdown' });
                }
                return; // Aturar el procés per complet
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

// Timeout global per evitar que es pengi a Railway (ex: 5 minuts)
setTimeout(() => {
    console.error("⏳ Timeout global: L'script ha trigat massa (més de 5 minuts). Es força el tancament.");
    process.exit(1);
}, 300000);

run().then(() => {
    console.log("Fi de l'execució de l'script.");
    process.exit(0);
}).catch(err => {
    console.error("❌ Error no controlat a l'script:", err);
    process.exit(1);
});
