import fs from 'fs';
import Papa from 'papaparse';
import axios from 'axios';
import { supabase } from '../lib/supabase.js';

// Filtre de ferris segons la metodologia
const ferryKeywords = [
    'GNV', 'GRIMALDI', 'BALEARIA', 'TRASMED', 'CRUISE ROMA', 'CRUISE BARCELONA', 
    'CRUISE SARDEGNA', 'CRUISE EUROPA', 'MAJESTIC', 'TENACIA', 'ABEL MATUTES', 
    'MARGARITA SALAS', 'CIUDAD DE', 'HYPATIA', 'ROSALIND FRANKLIN', 'KERRY', 
    'VOLCAN DE', 'MARTIN I SOLER', 'MARTÍN I SOLER', 'FLORENCIA', 'EXCELLENT', 
    'EXCELSIOR', 'LA SUPREMA', 'ECO ', 'ELEANOR', 'SICILIA', 'NAPOLI', 
    'CAP DE BARBARIA', 'RAMON LLULL', 'JAUME', 'MARIE CURIE', 'VISUVIUS'
];

function isFerry(shipName) {
    if (!shipName) return false;
    const name = shipName.toUpperCase();
    return ferryKeywords.some(keyword => name.includes(keyword));
}

// Constant to define the classification logic
function calcularTipusOperacio(embarcats, desembarcats, transit) {
    const paxEmbarcats = parseInt(embarcats, 10) || 0;
    const paxDesembarcats = parseInt(desembarcats, 10) || 0;
    const paxTransit = parseInt(transit, 10) || 0;

    const totalPax = paxEmbarcats + paxDesembarcats + paxTransit;
    
    // Fallback if no passengers (e.g. repositioning or data error)
    if (totalPax === 0) return 'hibrid'; 
    
    const pctTransit = paxTransit / totalPax;
    const paxBase = paxEmbarcats + paxDesembarcats;
    const pctBase = paxBase / totalPax;

    // Condition 1: TRÀNSIT PUR
    if (pctTransit > 0.85 && paxBase < 100) {
        return 'transit';
    }
    
    // Condition 2: PORT BASE COMPLET
    if (pctBase > 0.85) {
        return 'port_base';
    }
    
    // Condition 3: INTERPORTING / HÍBRID
    return 'hibrid';
}

/**
 * Process a CSV stream or string and upsert into Supabase
 */
async function procesarCSV(csvData) {
    console.log("Iniciant el processament del CSV...");

    // Parse the CSV
    const parsed = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        // Optional: dynamic typing could be useful, but we parse integers manually for safety
    });

    if (parsed.errors.length > 0) {
        console.error("Errors al llegir el CSV:", parsed.errors);
    }

    const dataRows = parsed.data;
    console.log(`S'han llegit ${dataRows.length} files. Processant dades...`);

    const batchSize = 100;
    let batch = [];
    let insertedRows = 0;

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];

        // Format dates correctly (adjust according to the specific CSV date format)
        // Assuming DD/MM/YYYY or YYYY-MM-DD
        let dataEscala = null;
        if (row['DATA']) {
            const parts = row['DATA'].split('/');
            if (parts.length === 3) {
                dataEscala = `${parts[2]}-${parts[1]}-${parts[0]}`; // Convert DD/MM/YYYY to YYYY-MM-DD
            } else {
                dataEscala = row['DATA']; // Assuming it is already YYYY-MM-DD or valid Date string
            }
        }

        const nomVaixell = row['VAIXELL'] || row['NOM_VAIXELL'] || 'Desconegut';
        const moll = row['MOLL'] || 'Desconegut';
        
        const embarcats = parseInt(row['EMBARCATS'], 10) || 0;
        const desembarcats = parseInt(row['DESEMBARCATS'], 10) || 0;
        const transit = parseInt(row['TRANSIT'], 10) || 0;

        // Skip rows without valid date or ship name
        if (!dataEscala || !nomVaixell) continue;
        
        // Excloure ferris
        if (isFerry(nomVaixell)) continue;

        const tipusOperacio = calcularTipusOperacio(embarcats, desembarcats, transit);

        batch.push({
            data_escala: dataEscala,
            nom_vaixell: nomVaixell,
            moll: moll,
            pax_embarcats: embarcats,
            pax_desembarcats: desembarcats,
            pax_transit: transit,
            tipus_operacio: tipusOperacio,
            estat_dades: 'consolidat'
        });

        if (batch.length === batchSize || i === dataRows.length - 1) {
            // Upsert batch to Supabase
            // Use onConflict constraint 'escales_data_escala_nom_vaixell_key' created by the UNIQUE(data_escala, nom_vaixell)
            const { error } = await supabase
                .from('escales')
                .upsert(batch, { 
                    onConflict: 'data_escala, nom_vaixell',
                    ignoreDuplicates: false // We want to update existing rows with consolidated data
                });

            if (error) {
                console.error(`Error en fer UPSERT (fila ${i}):`, error.message);
            } else {
                insertedRows += batch.length;
                console.log(`Processades ${insertedRows}/${dataRows.length} files...`);
            }
            batch = [];
        }
    }

    console.log(`✅ Migració completada: s'han insertat/actualitzat ${insertedRows} files.`);
}

async function start() {
    const source = process.argv[2];

    if (!source) {
        console.error("Ús: node migrate.js <ruta_local.csv | url_csv>");
        console.log("Exemple 1: node migrate.js ./dades.csv");
        console.log("Exemple 2: node migrate.js https://opendata.portdebarcelona.cat/dataset/.../portbcncreuers.csv");
        process.exit(1);
    }

    try {
        let csvData;

        if (source.startsWith('http://') || source.startsWith('https://')) {
            console.log(`Descarregant CSV des de: ${source}`);
            const response = await axios.get(source, { responseType: 'text' });
            csvData = response.data;
        } else {
            console.log(`Llegint CSV local: ${source}`);
            csvData = fs.readFileSync(source, 'utf8');
        }

        await procesarCSV(csvData);
    } catch (err) {
        console.error("Error durant la migració:", err.message);
    }
}

start();
