import { execSync } from 'child_process';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseOcrNumber(str) {
    if (!str) return 0;
    let clean = str.replace(/\./g, '').replace(/,/g, '');
    clean = clean.replace(/[gG]/g, '8').replace(/[oO]/g, '0').replace(/[lI]/g, '1').replace(/[sS]/g, '5');
    const num = parseInt(clean, 10);
    return isNaN(num) ? 0 : num;
}

let cachedFullText = null;

export async function extractPaxFromPDF(shipName) {
    if (cachedFullText === null) {
        const pdfUrl = "https://opendata.portdebarcelona.cat/dataset/0a5f703d-35e5-4262-84ac-b6930239f4aa/resource/695fb2cc-6a71-43a1-a040-4d907b6a2472/download/portbcncreuersferris7dies.pdf";
        const pdfPath = join(__dirname, 'temp_forecast.pdf');
        let fullText = '';
        
        try {
            console.log(`[OCR] Descarregant PDF des de ${pdfUrl}...`);
            execSync(`curl -s -o "${pdfPath}" "${pdfUrl}"`);
            
            console.log(`[OCR] Convertint pàgines del PDF a imatge (GS)...`);
            const pngPattern = join(__dirname, 'temp_page_%d.png');
            // Convert all 7 pages as 'today' is typically at the end
            execSync(`gs -dNOPAUSE -dBATCH -sDEVICE=png16m -r300 -dFirstPage=1 -dLastPage=7 -sOutputFile="${pngPattern}" "${pdfPath}"`);
            
            const files = await fs.readdir(__dirname);
            const pngFiles = files.filter(f => f.startsWith('temp_page_') && f.endsWith('.png'));
            
            for (const file of pngFiles) {
                const filePath = join(__dirname, file);
                console.log(`[OCR] Llegint text de ${file} amb Tesseract...`);
                const out = execSync(`tesseract "${filePath}" stdout -l eng+spa --psm 6 2>/dev/null`);
                fullText += out.toString() + '\n';
                await fs.unlink(filePath); // Cleanup
            }
            
            // Remove PDF
            await fs.unlink(pdfPath);
            cachedFullText = fullText;
        } catch (e) {
            console.error(`[OCR] Error en el procés: ${e.message}`);
            // Ensure cleanup on error
            try { await fs.unlink(pdfPath); } catch (ex) {}
            return null;
        }
    }

    try {
        // Cerca del vaixell
        const lines = cachedFullText.split('\n');
        for (let line of lines) {
            // Normalitzem una mica per evitar que espais OCR ens robin el match
            const normalizedLine = line.toUpperCase().replace(/\s+/g, ' ');
            const normalizedShip = shipName.toUpperCase().replace(/\s+/g, ' ');
            
            if (normalizedLine.includes(normalizedShip)) {
                console.log(`[OCR] Trobada la línia pel vaixell ${shipName}: ${line}`);
                const paxMatches = [...line.matchAll(/([a-zA-Z0-9.,]+)Pax/gi)];
                if (paxMatches.length >= 1) {
                    let total = 0;
                    for (const match of paxMatches) {
                        total += parseOcrNumber(match[1]);
                    }
                    console.log(`[OCR] Valors extrets -> Suma total de ${paxMatches.length} valors Pax: ${total}`);
                    return total;
                }
            }
        }
        console.log(`[OCR] Vaixell ${shipName} no trobat amb Pax al PDF.`);
        
    } catch (e) {
        console.error(`[OCR] Error al buscar el vaixell: ${e.message}`);
    }
    
    return null;
}
