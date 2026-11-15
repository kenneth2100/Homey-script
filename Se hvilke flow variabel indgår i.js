/**
 * =========================================================================
 * HomeyScript: Avanceret Variabel Søgning & Udskiftning (Find & Replace)
 * =========================================================================
 * Dette script giver dig fuldt overblik over variabler og tags i din Homey.
 * 
 * ACTION — vælg én:
 *
 * 'SEARCH'
 *   Finder hvor variableToFind bruges. Skriver ingenting.
 *   Viser flow/script, mappe, kort og et tekst-udsnit.
 *   Linjer mærket "fritekst" er ordet i en besked, kommentar eller kode.
 *   Logic-ID er den rigtige variabelreference. Homey gemmer den som UUID,
 *   ikke som navnet.
 *   FIND_MODE = 'reference' skjuler fritekst og viser kun ID plus navn
 *   skrevet i anførselstegn, f.eks. getVar('lux').
 *
 * 'REPLACE'
 *   Omdøber Logic-variablen variableToFind til newVariableName.
 *   Med dryRun = true vises planen, og der gemmes intet.
 *   Standard (REPLACE_FREE_TEXT = false): kun selve Logic-variablen omdøbes.
 *   Homey opdaterer selv tags, der peger på dens ID. Beskeder og scripts
 *   røres ikke.
 *   REPLACE_FREE_TEXT = true: ordet erstattes også i HomeyScript-kode.
 *   Flow-JSON sendes kun tilbage, hvis WRITE_FLOW_JSON også er true.
 *   Et mappefilter omdøber ikke Logic-variablen, for det ville ramme alle flows.
 *
 * 'UNUSED'
 *   Rapport over Logic-variabler uden spor i de flows og scripts, scriptet
 *   kan læse. Sletter og omdøber ingenting.
 *   "Uden spor" betyder: intet variabel-ID i flows/scripts, og navnet står
 *   heller ikke som tekst. Dashboards, favoritter, andre apps og
 *   stemmeassistent er ikke med, fordi Homey ikke udstiller dem her.
 *   variableToFind bruges ikke.
 * - SIKKERHED: Indbygget beskyttelse mod specialtegn og system-reserverede 
 *   ord, så du ikke kan komme til at korrumpere dine flows. Scriptet genkender
 *   sig selv via fingerprint (SELF_MARKER) og springer kopier over ved REPLACE.
 * 
 * VIGTIGT: FORSTÅELSE AF ID vs. NAVN
 * ------------------------------------
 * Homey refererer primært til Logic Variabler via et internt ID, ikke deres navn.
 * Når du omdøber en Logic Variabel, sker der to ting med dette script:
 * 1. OMDØBNING AF SELVE VARIABLEN (standard): Scriptet bruger Homeys API til at
 *    omdøbe selve variablen. Homey opdaterer derefter automatisk navnet på alle
 *    tags, der er linket via ID. Fritekst i beskeder røres ikke.
 * 2. FRITEKST (kun hvis REPLACE_FREE_TEXT = true): Scriptet scanner flows og
 *    scripts og erstatter tekst-forekomster af det gamle navn (notifikationer,
 *    log-beskeder, kommentarer). Det kan ramme ordet, også hvor det ikke er
 *    en variabelreference. Flow-JSON klones og der skrives kun i kendte
 *    kort-felter (Standard: trigger/conditions/actions, Advanced: cards).
 * =========================================================================
 */

const ACTION = 'SEARCH'; // 'SEARCH' = find brug, skriv intet. 'REPLACE' = omdøb Logic-variablen (dryRun viser først). 'UNUSED' = list variabler uden spor. Sletter intet.
const variableToFind = 'Lux';
const newVariableName = 'nyt lys'; // Det nye variabelnavn (kun relevant hvis ACTION = 'REPLACE')
const dryRun = true; // Sæt til false for at udføre faktiske ændringer ved 'REPLACE'!
const REPLACE_FREE_TEXT = false; // false = kun omdøb Logic-variabel (ID-tags). true = også fritekst i scripts (og flows, hvis WRITE_FLOW_JSON).
const WRITE_FLOW_JSON = false; // true = REPLACE må sende flow-JSON tilbage. Kræver også REPLACE_FREE_TEXT. Lad den stå false, medmindre du bevidst vil rette tekst inde i flows.
const FIND_MODE = 'all'; // 'all' = også beskeder/scripts. 'reference' = kun Logic-ID og navn i anførselstegn ('lux' / "lux").
const MIN_FREE_TEXT_LENGTH = 4; // Kortere søgeord (f.eks. "on") matches kun som ID eller i anførselstegn.
const REPLACE_SAFETY_LIMIT = 20; // Sikkerhedsgrænse: Scriptet stopper, hvis REPLACE rammer flere end dette antal steder (og dryRun=false).
const MAX_SNIPPETS_PER_ITEM = 6; // Max antal kort-udsnit pr. flow/script i loggen.

// Begræns hvilke kilder der scannes. Tom folder = alle mapper (matcher i mappestien, f.eks. "Knap").
const SCOPE = {
    standardFlows: true,
    advancedFlows: true,
    scripts: true,
    logicVars: true,
    tokens: true,
    folder: ''
};

// Unik fingerprint: slet eller ret ALDRIG denne streng. Scriptet genkender sig selv (og kopier) på den.
const SELF_MARKER = 'HS-FIND-REPLACE-SELF:8f3c1a9e-b7d2';
// Valgfrit ekstra skip (tom streng = kun auto-find via fingerprint/navn).
const THIS_SCRIPT_ID = '';
const THIS_SCRIPT_NAME = ''; // Valgfrit: eksakt navn på dette HomeyScript, hvis du vil tvinge skip uden at hente kode.

// Timeout for API-kald i millisekunder
const API_TIMEOUT_MS = 15000;

// Funktion til at indkapsle asynkrone API-kald med en timeout for at forhindre script-hang
function withTimeout(promise, ms, name) {
    // Den oprindelige, robuste implementering genindsættes.
    // HomeyScript-miljøet understøtter ikke altid standard `setTimeout`.
    // Denne funktion tjekker for `setTimeout` og falder tilbage på den Homey-specifikke `wait()`-funktion, hvis det er nødvendigt.
    if (typeof setTimeout === 'function' && typeof clearTimeout === 'function') {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                console.error(`⏳ TIMEOUT: API-kald '${name}' timede ud efter ${ms}ms.`);
                reject(new Error(`Timeout: ${name}`));
            }, ms);
            promise.then(res => { clearTimeout(timer); resolve(res); })
                   .catch(err => { clearTimeout(timer); reject(err); });
        });
    } else if (typeof wait === 'function') {
        let isResolved = false;
        const wrappedPromise = promise.then(res => { isResolved = true; return res; }, err => { isResolved = true; throw err; });
        const timeoutPromise = wait(ms).then(() => {
            if (!isResolved) {
                console.error(`⏳ TIMEOUT: API-kald '${name}' timede ud efter ${ms}ms.`);
                throw new Error(`Timeout: ${name}`);
            }
        });
        return Promise.race([wrappedPromise, timeoutPromise]);
    }
    return promise; // Ingen timeout-mekanisme fundet, returner det oprindelige promise.
}

// Hjælpefunktion til at tjekke om et tegn er et "ord"-tegn (inkl. æøå)
function isWordChar(char) {
    return /[a-zA-Z0-9_æøåÆØÅäöüÄÖÜ]/.test(char);
}

function applyCaseStyle(originalMatch, replaceStr) {
    if (!originalMatch || typeof replaceStr !== 'string') return replaceStr;
    const isUpperCase = originalMatch === originalMatch.toUpperCase();
    const isLowerCase = originalMatch === originalMatch.toLowerCase();
    if (isUpperCase) return replaceStr.toUpperCase();
    if (isLowerCase) return replaceStr.toLowerCase();
    if (originalMatch[0] === originalMatch[0].toUpperCase() && originalMatch.slice(1) === originalMatch.slice(1).toLowerCase()) {
        return replaceStr.charAt(0).toUpperCase() + replaceStr.slice(1).toLowerCase();
    }
    if (originalMatch.split(' ').every(w => w.length === 0 || (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()))) {
        return replaceStr.split(' ').map(w => w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '').join(' ');
    }
    return replaceStr;
}

function describeScope() {
    const parts = [];
    if (SCOPE.standardFlows) parts.push('Standard Flows');
    if (SCOPE.advancedFlows) parts.push('Advanced Flows');
    if (SCOPE.scripts) parts.push('HomeyScripts');
    if (SCOPE.logicVars) parts.push('Logic');
    if (SCOPE.tokens) parts.push('Tags');
    const folder = String(SCOPE.folder || '').trim();
    if (!parts.length) return 'ingen kilder valgt';
    return folder ? `${parts.join(', ')} | mappe indeholder "${folder}"` : parts.join(', ');
}

function isShortSearchTerm(searchStr) {
    return String(searchStr || '').trim().length < MIN_FREE_TEXT_LENGTH;
}

function isQuotedAt(text, index, length) {
    const before = index > 0 ? text[index - 1] : '';
    const after = index + length < text.length ? text[index + length] : '';
    return (before === "'" && after === "'")
        || (before === '"' && after === '"')
        || (before === '`' && after === '`');
}

function acceptsTextMatch(text, index, length, searchStr) {
    const strict = FIND_MODE === 'reference' || isShortSearchTerm(searchStr);
    if (!strict) return true;
    return isQuotedAt(text, index, length);
}

function previewReplaceSnippet(snippet) {
    return String(snippet).replace(/«([^»]+)»/g, (_, inner) => `«${inner}» → «${applyCaseStyle(inner, newVariableName)}»`);
}

// Manuel søg og erstat der undgår ustabile RegExp lookbehinds og respekterer danske tegn
function searchAndReplaceWithBoundaries(text, searchStr, replaceStr, performReplace) {
    if (!text || typeof text !== 'string') return { hasMatch: false, resultText: text };
    // Beskyttelse mod uendelig løkke, hvis searchStr er tom.
    if (searchStr === '') return { hasMatch: false, resultText: text };
    
    let hasMatch = false;
    let result = '';
    let searchLower = searchStr.toLowerCase();
    let textLower = text.toLowerCase();
    let i = 0;

    while (i < text.length) {
        let index = textLower.indexOf(searchLower, i);
        if (index === -1) {
            result += text.substring(i);
            break;
        }

        let charBefore = index > 0 ? text[index - 1] : null;
        let charAfter = index + searchStr.length < text.length ? text[index + searchStr.length] : null;

        // Tjekker om grænserne er rigtige (må IKKE være omgivet af andre bogstaver/tal)
        let boundaryBeforeOk = !charBefore || !isWordChar(charBefore);
        let boundaryAfterOk = !charAfter || !isWordChar(charAfter);

        if (boundaryBeforeOk && boundaryAfterOk && acceptsTextMatch(text, index, searchStr.length, searchStr)) {
            hasMatch = true;
            result += text.substring(i, index);

            const originalMatch = text.substring(index, index + searchStr.length);
            if (performReplace) {
                // Forsøg at bevare den oprindelige case
                const isUpperCase = originalMatch === originalMatch.toUpperCase();
                const isLowerCase = originalMatch === originalMatch.toLowerCase();
                
                if (isUpperCase) {
                    result += replaceStr.toUpperCase();
                } else if (isLowerCase) {
                    result += replaceStr.toLowerCase();
                } else if (originalMatch[0] === originalMatch[0].toUpperCase() && originalMatch.slice(1) === originalMatch.slice(1).toLowerCase()) {
                    // "Sentence case" detektion (f.eks. "Første ord stort")
                    result += replaceStr.charAt(0).toUpperCase() + replaceStr.slice(1).toLowerCase();
                } else if (originalMatch.split(' ').every(w => w.length === 0 || (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()))) {
                    // "Title Case" detektion (f.eks. "Hvert Ord Stort")
                    result += replaceStr.split(' ').map(w => w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '').join(' ');
                } else {
                    result += replaceStr; // Fallback til den angivne case
                }
            } else {
                result += originalMatch;
            }
        } else {
            // Ikke et validt match (f.eks. del af et andet ord), behold original tekst
            result += text.substring(i, index + searchStr.length);
        }
        
        i = index + searchStr.length;
    }

    return { hasMatch, resultText: result };
}

function collectBoundaryMatches(text, searchStr) {
    const hits = [];
    if (!text || typeof text !== 'string' || !searchStr) return hits;
    const searchLower = searchStr.toLowerCase();
    const textLower = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
        const index = textLower.indexOf(searchLower, i);
        if (index === -1) break;
        const charBefore = index > 0 ? text[index - 1] : null;
        const charAfter = index + searchStr.length < text.length ? text[index + searchStr.length] : null;
        const boundaryBeforeOk = !charBefore || !isWordChar(charBefore);
        const boundaryAfterOk = !charAfter || !isWordChar(charAfter);
        if (boundaryBeforeOk && boundaryAfterOk && acceptsTextMatch(text, index, searchStr.length, searchStr)) {
            hits.push({ index, length: searchStr.length });
        }
        i = index + searchStr.length;
    }
    return hits;
}

function formatSnippet(text, index, length, radius = 40) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + length + radius);
    const before = text.slice(start, index).replace(/\s+/g, ' ').trimStart();
    const match = text.slice(index, index + length);
    const after = text.slice(index + length, end).replace(/\s+/g, ' ').trimEnd();
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return `${prefix}${before}«${match}»${after}${suffix}`;
}

function stripCardTitle(title) {
    return String(title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isLikelyFlowCard(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.ownerUri) return true;
    if (obj.uri && (obj.args !== undefined || obj.droptoken !== undefined || obj.droptokens !== undefined)) return true;
    return false;
}

function isUuidLike(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function cardTypeLabel(type) {
    const t = String(type || '').toUpperCase();
    if (t === 'WHEN' || t === 'TRIGGER') return 'Når';
    if (t === 'AND' || t === 'CONDITION') return 'Og';
    if (t === 'THEN' || t === 'ACTION') return 'Så';
    if (t === 'OR') return 'Eller';
    return '';
}

function humanizeOwnerUri(uri) {
    if (!uri) return '';
    const s = String(uri);
    if (s.includes('homey:manager:logic')) return 'Logic';
    if (s.includes('homey:manager:notifications')) return 'Notifikation';
    if (s.includes('homey:manager:flow')) return 'Flow';
    if (s.includes('homey:manager:presence')) return 'Tilstedeværelse';
    if (s.startsWith('homey:device:')) {
        const parts = s.split(':');
        const card = parts.slice(3).filter(p => p && !isUuidLike(p)).join(' · ');
        return card ? `Enhed · ${card}` : 'Enhed';
    }
    if (s.startsWith('homey:app:')) {
        const parts = s.split(':').filter(p => p && p !== 'homey' && p !== 'app' && !isUuidLike(p));
        return parts.length ? `App · ${parts.join(' · ')}` : 'App';
    }
    const last = s.split(':').filter(p => p && !isUuidLike(p)).pop();
    return last || '';
}

function describeCard(card, fallback) {
    if (card && typeof card === 'object') {
        for (const raw of [card.titleFormatted, card.title]) {
            if (typeof raw === 'string' && raw.trim() && !isUuidLike(raw)) {
                const cleaned = stripCardTitle(raw);
                if (cleaned && !isUuidLike(cleaned)) return cleaned;
            }
        }
        const type = cardTypeLabel(card.type);
        const owner = humanizeOwnerUri(card.ownerUri || card.uri);
        const combined = [type, owner].filter(Boolean).join(' · ');
        if (combined) return combined;
    }
    if (fallback && !isUuidLike(fallback) && !['id', 'args', 'tokens', 'droptokens'].includes(fallback)) {
        return fallback;
    }
    return 'Kort';
}

function prettyLogicSnippet(text, logicVarId, logicVarName) {
    if (!text) return text;
    let snippet = String(text);
    if (logicVarId && logicVarName && snippet.includes(logicVarId)) {
        return `Logic-variabel «${logicVarName}»`;
    }
    return snippet.replace(/\[\[|\]\]/g, '');
}

function describeFieldPath(keyName, path) {
    const rawParts = String(path || '').split(/[.\[\]]+/).filter(Boolean);
    const parts = rawParts.filter(p => p !== '$' && !isUuidLike(p) && !/^\d+$/.test(p));
    if (keyName && !isUuidLike(keyName) && !parts.includes(keyName)) parts.push(keyName);
    const useful = parts.slice(-3).join('.');
    if (useful) return useful;
    if (keyName && !isUuidLike(keyName)) return keyName;
    return 'felt';
}

function collectFlowHits(root, searchStr, logicVarId, logicVarName) {
    const hits = [];
    const visited = new WeakSet();
    const skipTextKeys = ['metadata', 'description'];

    function addHit(card, snippet, kind) {
        if (!snippet) return;
        const existing = hits.find(h => h.card === card && h.snippet === snippet && h.kind === kind);
        if (existing) {
            existing.count += 1;
            return;
        }
        hits.push({ card, snippet, kind, count: 1 });
    }

    function traverse(item, keyName, cardLabel, isRoot, path) {
        const skipText = skipTextKeys.includes(keyName);
        const here = path || (keyName ? String(keyName) : '$');

        if (typeof item === 'string') {
            const field = describeFieldPath(keyName, here);
            const label = (cardLabel && !isUuidLike(cardLabel)) ? cardLabel : (isUuidLike(keyName) ? 'Kort' : (keyName || 'Tekst'));
            if (!skipText) {
                for (const m of collectBoundaryMatches(item, searchStr)) {
                    addHit(label, prettyLogicSnippet(formatSnippet(item, m.index, m.length), logicVarId, logicVarName), 'tekst');
                }
            }
            if (logicVarId && item.includes(logicVarId)) {
                addHit(`${label} · ${field}`, `Logic-variabel «${logicVarName || searchStr}»`, 'id');
            }
            return;
        }

        if (logicVarId && item === logicVarId) {
            const field = describeFieldPath(keyName, here);
            const label = (cardLabel && !isUuidLike(cardLabel)) ? cardLabel : 'ID-reference';
            addHit(`${label} · ${field}`, `Logic-variabel «${logicVarName || searchStr}»`, 'id');
            return;
        }

        if (item === null || typeof item !== 'object') return;
        if (visited.has(item)) return;
        visited.add(item);

        if (Array.isArray(item)) {
            for (let i = 0; i < item.length; i++) {
                traverse(item[i], keyName, cardLabel, false, `${here}[${i}]`);
            }
            return;
        }

        const nextCard = isLikelyFlowCard(item) ? describeCard(item, keyName) : cardLabel;
        for (const key of Object.keys(item)) {
            if (isRoot && (key === 'id' || key === 'folder')) continue;
            traverse(item[key], key, nextCard, false, `${here}.${key}`);
        }
    }

    traverse(root, null, null, true, '$');
    return hits;
}

function isCommentLine(line) {
    const t = String(line || '').trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

function collectScriptHits(code, searchStr) {
    const hits = [];
    if (typeof code !== 'string') return hits;
    const lines = code.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const matches = collectBoundaryMatches(line, searchStr);
        if (!matches.length) continue;
        const m = matches[0];
        hits.push({
            card: `linje ${i + 1}`,
            snippet: formatSnippet(line, m.index, m.length),
            kind: isCommentLine(line) ? 'kommentar' : 'tekst',
            count: 1
        });
    }
    return hits;
}

// Hjælpefunktion til dyb søgning og sikker udskiftning af string-værdier i et objekt.
function deepSearchAndReplace(obj, searchStr, replacementStr, performReplace) {
    let hasMatch = false;
    let hasReplaceableMatch = false;
    const visited = new WeakSet(); // For at undgå uendelig rekursion ved cirkulære referencer

    // Nøgler vi ALDRIG må ændre indholdet af (for at undgå korruption af system-links)
    const noReplaceKeys = [
        'id', 'uri', 'ownerUri', 'type', 'token', 'folder',
        'createdAt', 'modifiedAt', 'icon', 'color', 'version'
    ];

    // Nøgler vi slet ikke gider at lede i (for at undgå falske positive i ren metadata)
    const skipKeys = [
        'metadata', 'description', 'titleFormatted'
    ];

    function traverse(item, keyName = null, depth = 0) {
        // Beskyttelse mod cirkulære referencer. Hvis vi har set dette objekt før, stop.
        if (item !== null && typeof item === 'object') {
            if (visited.has(item)) {
                return item;
            }
            visited.add(item);
        }

        // Spring metadata og beskrivelser helt over i søgningen
        if (skipKeys.includes(keyName)) {
            return item;
        }

        if (typeof item === 'string') {
            // Specifik beskyttelse: Undgå at omdøbe selve flowet/scriptet ved et tilfælde.
            // Vi tillader kun erstatning, hvis nøglen ikke er beskyttet.
            // 'name' på topniveau (depth === 1) er beskyttet for at undgå at omdøbe selve flowet.
            const isTopLevelName = (keyName === 'name' && depth === 1);
            const isProtected = noReplaceKeys.includes(keyName) || isTopLevelName;
            const canReplace = performReplace && !isProtected;

            const { hasMatch: stringMatch, resultText } = searchAndReplaceWithBoundaries(item, searchStr, replacementStr, canReplace);
            if (stringMatch) {
                hasMatch = true;
                if (!isProtected) {
                    hasReplaceableMatch = true;
                }
                return resultText;
            }
            return item;
        } else if (Array.isArray(item)) {
            for (let i = 0; i < item.length; i++) {
                const traversedEl = traverse(item[i], keyName, depth + 1);
                if (performReplace && traversedEl !== item[i]) {
                    item[i] = traversedEl;
                }
            }
            return item;
        } else if (item !== null && typeof item === 'object') {
            for (const key in item) { // key er her en string, f.eks. "name"
                const traversedVal = traverse(item[key], key, depth + 1);
                if (performReplace && traversedVal !== item[key]) {
                    item[key] = traversedVal;
                }
            }
            return item;
        }
        return item;
    }

    const resultObj = traverse(obj);
    return { hasMatch, hasReplaceableMatch, resultObj };
}

function cloneJson(obj) {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch (err) {
        return null;
    }
}

function stableWithoutCardRoots(flow, itemTypeName) {
    const copy = {};
    const skip = new Set(getFlowCardRootKeys(itemTypeName));
    for (const key of Object.keys(flow || {})) {
        if (skip.has(key)) continue;
        copy[key] = flow[key];
    }
    try {
        return JSON.stringify(copy);
    } catch (err) {
        return null;
    }
}

function getFlowCardRootKeys(itemTypeName) {
    if (itemTypeName === 'Standard Flow') return ['trigger', 'conditions', 'actions'];
    if (itemTypeName === 'Advanced Flow') return ['cards'];
    return [];
}

function getPresentFlowCardRoots(flow, itemTypeName) {
    return getFlowCardRootKeys(itemTypeName).filter(key => flow && flow[key] != null);
}

function replaceInFlowCardRoots(flow, itemTypeName, searchStr, replacementStr, performReplace) {
    const keys = getPresentFlowCardRoots(flow, itemTypeName);
    if (!keys.length) {
        return { hasMatch: false, hasReplaceableMatch: false, ok: false };
    }
    let hasMatch = false;
    let hasReplaceableMatch = false;
    for (const key of keys) {
        const result = deepSearchAndReplace(flow[key], searchStr, replacementStr, performReplace);
        hasMatch = hasMatch || result.hasMatch;
        hasReplaceableMatch = hasReplaceableMatch || result.hasReplaceableMatch;
        if (performReplace) flow[key] = result.resultObj;
    }
    return { hasMatch, hasReplaceableMatch, ok: true };
}

// Ny hjælpefunktion til at søge efter et specifikt ID i et objekt.
// Dette er nødvendigt, da standard flows ofte kun refererer til variabler via ID, ikke navn.
function deepSearchForId(obj, idToFind) {
    let hasMatch = false;
    const visited = new WeakSet();

    function traverse(item) {
        if (hasMatch) return; // Optimeret: Stop så snart et match er fundet

        // Tjek for match. Som du korrekt påpeger, kan ID'et være en del af en streng
        // (f.eks. i et token) eller en direkte værdi. Vi tjekker for begge dele.
        if (typeof item === 'string' && item.includes(idToFind)) {
            hasMatch = true;
            return;
        }
        if (item === idToFind) { // Dækker non-string værdier eller eksakte matches
            hasMatch = true;
            return;
        }

        if (item !== null && typeof item === 'object') {
            if (visited.has(item)) return;
            visited.add(item);

            if (Array.isArray(item)) {
                for (const element of item) {
                    traverse(element);
                }
            } else {
                for (const key in item) {
                    traverse(item[key]);
                }
            }
        }
    }
    traverse(obj);
    return hasMatch;
}

function isSelfByIdOrName(script) {
    if (!script) return false;
    if (THIS_SCRIPT_ID && script.id === THIS_SCRIPT_ID) return true;
    if (THIS_SCRIPT_NAME && script.name === THIS_SCRIPT_NAME) return true;
    return false;
}

function isSelfByMarker(code) {
    return typeof code === 'string' && code.includes(SELF_MARKER);
}

async function findVariableUsage() {
    if (ACTION !== 'SEARCH' && ACTION !== 'REPLACE' && ACTION !== 'UNUSED') {
        console.error(`❌ Afbrudt: Ukendt ACTION "${ACTION}". Brug 'SEARCH', 'REPLACE' eller 'UNUSED'.`);
        return false;
    }
    if (FIND_MODE !== 'all' && FIND_MODE !== 'reference') {
        console.error(`❌ Afbrudt: Ukendt FIND_MODE "${FIND_MODE}". Brug 'all' eller 'reference'.`);
        return false;
    }

    // 1. Validering af input før vi overhovedet starter
    if (ACTION !== 'UNUSED' && (typeof variableToFind !== 'string' || variableToFind.trim() === '')) {
        console.error('❌ Afbrudt: "variableToFind" er tom. Angiv venligst, hvad der skal søges efter.');
        return false;
    }

    // Sikkerhedsliste mod at ødelægge Homeys JSON-struktur ved REPLACE
    const reservedWords = ['id', 'name', 'type', 'uri', 'args', 'token', 'droptokens', 'folder', 'true', 'false', 'null', 'undefined'];
    if (ACTION === 'REPLACE' && reservedWords.includes(variableToFind.toLowerCase())) {
        console.error(`❌ Afbrudt: Du forsøger at udskifte et system-reserveret ord ("${variableToFind}"). Dette vil korrumpere dine flows!`);
        return false;
    }

    // Valider kun det nye navn, hvis vi reelt ønsker at udskifte (REPLACE)
    if (ACTION === 'REPLACE') {
        if (typeof newVariableName !== 'string' || newVariableName.trim() === '') {
            console.error('❌ Afbrudt: "newVariableName" er tom eller ugyldig. Udfyld venligst et gyldigt nyt navn.');
            return false;
        }
        if (variableToFind.includes('"') || variableToFind.includes('\\') || newVariableName.includes('"') || newVariableName.includes('\\')) {
            console.error('❌ Afbrudt: Søge- eller erstatningsnavnet indeholder ulovlige tegn (" eller \\). Dette vil ødelægge Homeys JSON-struktur!');
            return false;
        }
        if (reservedWords.includes(newVariableName.toLowerCase())) {
            console.error(`❌ Afbrudt: Det nye navn ("${newVariableName}") er et system-reserveret ord. Dette vil korrumpere dine flows!`);
            return false;
        }
        if (variableToFind.trim().toLowerCase() === newVariableName.trim().toLowerCase()) {
            console.error('❌ Afbrudt: "variableToFind" og "newVariableName" er ens. Der er intet at omdøbe.');
            return false;
        }
        if (!dryRun) {
            console.log('⚠️ REPLACE kører med dryRun = false. Der skrives til Homey.');
        }
    }

    const scopeEnabled = SCOPE.standardFlows || SCOPE.advancedFlows || SCOPE.scripts || SCOPE.logicVars || SCOPE.tokens;
    if (!scopeEnabled) {
        console.error('❌ Afbrudt: SCOPE har ingen kilder slået til. Sæt mindst én til true.');
        return false;
    }

    if (!Homey || !Homey.flow || typeof Homey.flow.getFlows !== 'function') {
        console.error('❌ Afbrudt: Homey.flow.getFlows findes ikke. Scriptet kan ikke køre i dette miljø.');
        return false;
    }

    // Forbedret fejlhåndtering for API-kald.
    // Hvis et API-kald fejler (f.eks. pga. manglende permissions), logges fejlen,
    // og scriptet fortsætter med et tomt datasæt for den pågældende type.
    const apiCall = (promise, name) => {
        return withTimeout(promise, API_TIMEOUT_MS, name).catch(err => {
            console.error(`❌ Fejl ved hentning af '${name}': ${err.message}. Tjek om scriptet har de nødvendige permissions.`);
            return {}; // Returner tomt objekt for at undgå at stoppe hele scriptet
        });
    };

    // Trin 1: Hent den indledende liste over standard flows.
    // Dette returnerer ofte kun "lette" objekter uden de fulde detaljer.
    const initialFlowList = await apiCall(Homey.flow.getFlows(), 'Flows');

    async function fetchTokens() {
        const methods = [
            () => Homey.flowtoken && typeof Homey.flowtoken.getFlowTokens === 'function' && Homey.flowtoken.getFlowTokens(),
            () => Homey.flowToken && typeof Homey.flowToken.getFlowTokens === 'function' && Homey.flowToken.getFlowTokens(),
            () => Homey.flow && typeof Homey.flow.getFlowTokens === 'function' && Homey.flow.getFlowTokens(),
            () => Homey.flow && typeof Homey.flow.getTokens === 'function' && Homey.flow.getTokens()
        ];
        for (const method of methods) {
            try {
                const result = method();
                if (!result || typeof result.then !== 'function') continue;
                return await withTimeout(result, API_TIMEOUT_MS, 'Tokens');
            } catch (err) {
                // Prøv næste API-variant
            }
        }
        console.error("❌ Fejl ved hentning af 'Tokens': Ingen understøttet token-API fundet. Tjek om scriptet har de nødvendige permissions.");
        return {};
    }

    function mapScriptsById(raw) {
        const scriptsById = {};
        if (Array.isArray(raw)) {
            for (const script of raw) {
                if (script && script.id) scriptsById[script.id] = { ...script, id: script.id };
            }
            return scriptsById;
        }
        if (!raw || typeof raw !== 'object') return scriptsById;
        const nested = raw.scripts || raw.result || raw.data;
        if (nested && nested !== raw && typeof nested === 'object') {
            return mapScriptsById(nested);
        }
        for (const [key, script] of Object.entries(raw)) {
            if (!script || typeof script !== 'object') continue;
            const id = script.id || key;
            scriptsById[id] = { ...script, id };
        }
        return scriptsById;
    }

    async function appRequest(app, methodNew, methodOld, path, body) {
        if (app && typeof app[methodNew] === 'function') {
            return body === undefined
                ? app[methodNew]({ path })
                : app[methodNew]({ path, body });
        }
        if (app && typeof app[methodOld] === 'function') {
            return body === undefined
                ? app[methodOld](path.startsWith('/') ? path : `/${path}`)
                : app[methodOld](path.startsWith('/') ? path : `/${path}`, body);
        }
        return null;
    }

    let homeyScriptAppCache = null;
    async function getHomeyScriptApp() {
        if (homeyScriptAppCache) return homeyScriptAppCache;
        if (!Homey.apps || typeof Homey.apps.getApp !== 'function') return null;
        homeyScriptAppCache = await Homey.apps.getApp({ id: 'com.athom.homeyscript' });
        return homeyScriptAppCache;
    }

    async function fetchHomeyScripts() {
        const attempts = [];
        const errors = [];

        if (Homey.script && typeof Homey.script.getScripts === 'function') {
            attempts.push(() => Homey.script.getScripts());
        }

        attempts.push(async () => {
            const app = await getHomeyScriptApp();
            if (!app) throw new Error('Homey.apps.getApp er ikke tilgængelig');
            for (const path of ['script', '/script']) {
                const viaGet = await appRequest(app, 'get', 'apiGet', path);
                if (viaGet && typeof viaGet === 'object' && Object.keys(viaGet).length > 0) return viaGet;
            }
            if (typeof app.getScripts === 'function') return app.getScripts();
            throw new Error('HomeyScript-appen har ingen get/script-metode');
        });

        if (typeof Homey.api === 'function') {
            attempts.push(() => Homey.api('GET', '/api/app/com.athom.homeyscript/script'));
        }

        for (const attempt of attempts) {
            try {
                const raw = await withTimeout(attempt(), API_TIMEOUT_MS, 'Scripts');
                const mapped = mapScriptsById(raw);
                if (Object.keys(mapped).length > 0) return mapped;
                errors.push('tomt svar');
            } catch (err) {
                errors.push(err.message);
            }
        }
        if (errors.length) {
            console.error(`⚠️ Kunne ikke hente HomeyScripts (${errors.join(' | ')}).`);
        }
        return {};
    }

    function extractScriptCode(full, id, fallback) {
        const base = fallback && typeof fallback === 'object' ? fallback : {};
        if (typeof full === 'string' && full.trim()) {
            return { ...base, id, code: full };
        }
        if (!full || typeof full !== 'object') return { ...base, id };
        const nested = full.script && typeof full.script === 'object' ? full.script : null;
        const code = [full.code, nested && nested.code, full.source, full.value]
            .find(c => typeof c === 'string' && c.trim());
        return { ...base, ...full, ...(nested || {}), id, ...(code ? { code } : {}) };
    }

    function hasScriptCode(script) {
        return Boolean(script && typeof script.code === 'string' && script.code.trim());
    }

    async function fetchScriptCode(script) {
        if (hasScriptCode(script)) return script;
        const id = script && script.id;
        if (!id) return script;

        const tryMerge = (full) => extractScriptCode(full, id, script);

        try {
            if (Homey.script && typeof Homey.script.getScript === 'function') {
                const full = await withTimeout(Homey.script.getScript({ id }), API_TIMEOUT_MS, `getScript:${id}`);
                const merged = tryMerge(full);
                if (hasScriptCode(merged)) return merged;
            }
            const app = await getHomeyScriptApp();
            for (const path of [`script/${id}`, `/script/${id}`]) {
                const full = await appRequest(app, 'get', 'apiGet', path);
                const merged = tryMerge(full);
                if (hasScriptCode(merged)) return merged;
            }
        } catch (err) {
            console.error(`   -> ⚠️ Kunne ikke hente kode for script "${script.name || id}": ${err.message}`);
        }
        return script;
    }

    async function loadAllScriptCodes(scriptsById) {
        const listed = Object.values(scriptsById || {});
        let withCode = 0;
        const missing = [];
        for (let i = 0; i < listed.length; i++) {
            const current = listed[i];
            const full = await fetchScriptCode(current);
            if (full && full.id) scriptsById[full.id] = full;
            if (hasScriptCode(full)) withCode += 1;
            else missing.push(full && full.name ? full.name : (current.id || '?'));
            if (i + 1 < listed.length) {
                if (typeof wait === 'function') await wait(20);
            }
        }
        return { total: listed.length, withCode, missing };
    }

    async function updateHomeyScript(script, updatedCode) {
        if (typeof updatedCode !== 'string') {
            throw new Error('Mangler ny scriptkode til opdatering');
        }
        // HomeyScript PUT /script/:id accepterer kun name, code, version (api.js).
        // Vi sender kun code, så lastExecuted/id og andre GET-felter ikke skrives tilbage.
        const body = { code: updatedCode };

        if (Homey.script && typeof Homey.script.updateScript === 'function') {
            return Homey.script.updateScript({ id: script.id, script: body });
        }
        const app = await getHomeyScriptApp();
        const result = await appRequest(app, 'put', 'apiPut', `script/${script.id}`, body);
        if (result === null) throw new Error('Ingen updateScript/put-API fundet');
        return result;
    }

    function mapFoldersById(raw) {
        const foldersById = {};
        const nested = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw.folders || raw.result || raw.data || raw)
            : raw;
        const list = Array.isArray(nested)
            ? nested
            : (nested && typeof nested === 'object' ? Object.entries(nested).map(([key, folder]) => {
                if (!folder || typeof folder !== 'object') return null;
                return { ...folder, id: folder.id || key };
            }) : []);
        for (const folder of list) {
            if (!folder || typeof folder !== 'object') continue;
            const id = folder.id;
            if (!id) continue;
            foldersById[id] = { ...folder, id };
        }
        return foldersById;
    }

    async function fetchFlowFolders() {
        const attempts = [];
        if (Homey.flow && typeof Homey.flow.getFlowFolders === 'function') {
            attempts.push(() => Homey.flow.getFlowFolders());
        }
        if (Homey.flow && typeof Homey.flow.getFolders === 'function') {
            attempts.push(() => Homey.flow.getFolders());
        }
        if (Homey.flow && typeof Homey.flow.getAdvancedFlowFolders === 'function') {
            attempts.push(() => Homey.flow.getAdvancedFlowFolders());
        }
        if (Homey.folders && typeof Homey.folders.getFolders === 'function') {
            attempts.push(() => Homey.folders.getFolders());
        }

        const merged = {};
        for (const attempt of attempts) {
            try {
                const raw = await withTimeout(attempt(), API_TIMEOUT_MS, 'Flow Folders');
                Object.assign(merged, mapFoldersById(raw));
            } catch (err) {
                // Prøv næste mappe-API
            }
        }
        return merged;
    }

    // Trin 2: Opret en liste af promises for at hente de fulde detaljer for hvert standard flow parallelt.
    // apiCall() returnerer {} ved fejl (afviser ikke), så fallback skal tjekke resultatet — ikke .catch().
    const detailedFlowPromises = Object.keys(initialFlowList || {}).map(async (id) => {
        if (typeof Homey.flow.getFlow !== 'function') {
            return initialFlowList[id];
        }
        const detailed = await apiCall(Homey.flow.getFlow({ id }), `getFlow:${id}`);
        if (detailed && detailed.id) return detailed;
        console.error(`   -> ⚠️ Kunne ikke hente detaljer for flow ${id}. Bruger basis-info.`);
        return initialFlowList[id];
    });

    // Trin 3: Hent alle andre data parallelt med de detaljerede flows.
    const [detailedFlowResults, allAdvancedFlows, allScripts, allLogicVars, allTokens, mergedFolders] = await Promise.all([
        Promise.all(detailedFlowPromises), // Udfør alle detail-kald
        (Homey.flow && typeof Homey.flow.getAdvancedFlows === 'function')
            ? apiCall(Homey.flow.getAdvancedFlows(), 'Advanced Flows')
            : Promise.resolve({}),
        fetchHomeyScripts(),
        (Homey.logic && typeof Homey.logic.getVariables === 'function') ? apiCall(Homey.logic.getVariables(), 'Logic Variables') : Promise.resolve({}),
        fetchTokens(),
        fetchFlowFolders()
    ]);

    // Trin 4: Rekonstruer 'allFlows'-objektet fra de detaljerede resultater.
    const allFlows = detailedFlowResults.reduce((acc, flow) => {
        if (flow && flow.id) acc[flow.id] = flow;
        return acc;
    }, {});

    const scriptsById = allScripts && typeof allScripts === 'object' ? allScripts : {};
    const scriptCodeStats = await loadAllScriptCodes(scriptsById);
    const loadedScriptCount = Object.keys(scriptsById).length;
    if (loadedScriptCount === 0) {
        console.log('\nℹ️ HomeyScripts kunne ikke hentes via Homey.script eller HomeyScript-appens API. Script-søgning springes over (selv-ændring er ikke mulig).');
    } else {
        const extras = [];
        if (THIS_SCRIPT_ID) extras.push(`ID ${THIS_SCRIPT_ID}`);
        if (THIS_SCRIPT_NAME) extras.push(`navn "${THIS_SCRIPT_NAME}"`);
        console.log(`ℹ️ Selv-beskyttelse: genkender dette værktøj via fingerprint${extras.length ? ` (+ ${extras.join(', ')})` : ''}.`);
        console.log(`ℹ️ HomeyScripts: ${scriptCodeStats.withCode}/${scriptCodeStats.total} med kildekode.`);
        if (scriptCodeStats.missing.length) {
            console.log(`⚠️ Kunne ikke hente kode for: ${scriptCodeStats.missing.join(', ')}`);
        }
    }
    console.log(`ℹ️ Scope: ${describeScope()}.`);
    if (ACTION !== 'UNUSED' && isShortSearchTerm(variableToFind)) {
        console.log(`⚠️ "${variableToFind}" er kortere end ${MIN_FREE_TEXT_LENGTH} tegn. Fritekst tæller kun i anførselstegn ('${variableToFind}' / "${variableToFind}"). ID-referencer tæller stadig.`);
    }
    if (ACTION !== 'UNUSED' && FIND_MODE === 'reference') {
        console.log('ℹ️ FIND_MODE er reference: kun Logic-ID og navn i anførselstegn. Almindelig tekst i beskeder springes over.');
    }
    if (!Object.keys(mergedFolders || {}).length) {
        console.error('⚠️ Ingen flow-mapper kunne hentes. Mappenavne kan vises som UUID.');
    }

    function getFolderId(folderRef) {
        if (!folderRef) return '';
        if (typeof folderRef === 'string') return folderRef;
        if (typeof folderRef === 'object') return folderRef.id || folderRef.folder || '';
        return '';
    }

    function resolveFolderPath(folderId, seen) {
        if (!folderId || !mergedFolders[folderId]) return '';
        const visited = seen || new Set();
        if (visited.has(folderId)) {
            const f = mergedFolders[folderId];
            return f.title || f.name || '';
        }
        visited.add(folderId);
        const folder = mergedFolders[folderId];
        const name = folder.title || folder.name || '';
        const parentId = getFolderId(folder.folder || folder.parent || folder.parentId);
        if (parentId && mergedFolders[parentId]) {
            const parentPath = resolveFolderPath(parentId, visited);
            return parentPath ? `${parentPath} / ${name}` : name;
        }
        return name;
    }

    function getFolderName(folderRef) {
        const folderId = getFolderId(folderRef);
        if (!folderId) return 'Ingen mappe';
        return resolveFolderPath(folderId) || `Ukendt mappe ID: ${folderId}`;
    }

    function folderInScope(folderPath) {
        const needle = String(SCOPE.folder || '').trim().toLowerCase();
        if (!needle) return true;
        return String(folderPath || '').toLowerCase().includes(needle);
    }

    function safeStringify(obj) {
        try {
            return JSON.stringify(obj);
        } catch (err) {
            return '';
        }
    }

    function collectSelfScriptIds() {
        const ids = new Set();
        for (const listed of Object.values(scriptsById)) {
            if (isSelfByIdOrName(listed) || isSelfByMarker(listed && listed.code)) {
                ids.add(listed.id);
            }
        }
        return ids;
    }

    function buildFlowCorpus() {
        const parts = [];
        if (SCOPE.standardFlows) {
            for (const flow of Object.values(allFlows || {})) {
                if (!folderInScope(getFolderName(flow && flow.folder))) continue;
                parts.push(safeStringify(flow));
            }
        }
        if (SCOPE.advancedFlows) {
            for (const flow of Object.values(allAdvancedFlows || {})) {
                if (!folderInScope(getFolderName(flow && flow.folder))) continue;
                parts.push(safeStringify(flow));
            }
        }
        if (SCOPE.tokens) {
            for (const token of Object.values(allTokens || {})) {
                if (!token) continue;
                const uri = String(token.uri || token.ownerUri || '');
                if (uri.includes('homey:manager:logic')) continue;
                parts.push(safeStringify(token));
            }
        }
        return parts.join('\n');
    }

    function getScanableScripts() {
        if (!SCOPE.scripts) return [];
        const selfIds = collectSelfScriptIds();
        return Object.values(scriptsById).filter(script => {
            if (!script || selfIds.has(script.id)) return false;
            return hasScriptCode(script);
        });
    }

    async function fetchExtraUsageText() {
        const scanned = [];
        const missed = ['dashboards og favoritter', 'andre apps’ interne lager', 'stemmeassistent'];
        const parts = [];
        if (Homey.insights && typeof Homey.insights.getLogs === 'function') {
            try {
                const logs = await withTimeout(Homey.insights.getLogs(), API_TIMEOUT_MS, 'Insights');
                parts.push(typeof logs === 'string' ? logs : JSON.stringify(logs));
                scanned.push('Insights-lognavne');
            } catch (err) {
                missed.unshift(`Insights (${err.message})`);
            }
        } else {
            missed.unshift('Insights');
        }
        return { scanned, missed, text: parts.join('\n') };
    }

    if (ACTION === 'UNUSED') {
        console.log('\n🧹 Starter i [UNUSED] tilstand: finder Logic-variabler uden brug i flows/scripts...\n');
        const logicList = Object.values(allLogicVars || {}).filter(v => v && v.id);
        if (logicList.length === 0) {
            console.log('❌ Ingen Logic-variabler kunne hentes.');
            return false;
        }

        const flowCorpus = buildFlowCorpus();
        const extraUsage = await fetchExtraUsageText();
        const usageCorpus = `${flowCorpus}\n${extraUsage.text}`;
        const scriptsToScan = getScanableScripts();
        console.log(`ℹ️ Scanner ${scriptsToScan.length} HomeyScripts (dette værktøj er sprunget over).`);
        if (extraUsage.scanned.length) console.log(`ℹ️ Ekstra scannet: ${extraUsage.scanned.join(', ')}.`);
        console.log(`ℹ️ Ikke med i UNUSED, fordi Homey ikke udstiller det i script-API: ${extraUsage.missed.join(', ')}.`);

        const unused = [];
        const nameOnly = [];
        const scriptOnly = [];
        let usedCount = 0;

        for (const v of logicList) {
            const usedByIdInFlow = typeof v.id === 'string' && v.id && usageCorpus.includes(v.id);
            const usedByNameInFlow = v.name
                ? searchAndReplaceWithBoundaries(usageCorpus, v.name, '', false).hasMatch
                : false;

            const scriptHits = [];
            if (v.name || v.id) {
                for (const script of scriptsToScan) {
                    const code = script.code;
                    const idHit = v.id && code.includes(v.id);
                    const nameHit = v.name
                        ? searchAndReplaceWithBoundaries(code, v.name, '', false).hasMatch
                        : false;
                    if (idHit || nameHit) scriptHits.push(script.name || script.id);
                }
            }

            if (usedByIdInFlow) {
                usedCount += 1;
            } else if (scriptHits.length > 0) {
                scriptOnly.push({ v, scripts: scriptHits });
            } else if (usedByNameInFlow) {
                nameOnly.push(v);
            } else {
                unused.push(v);
            }
        }

        const sortByName = (a, b) => (a.name || '').localeCompare(b.name || '', 'da');
        unused.sort(sortByName);
        nameOnly.sort(sortByName);
        scriptOnly.sort((a, b) => sortByName(a.v, b.v));

        console.log(`✅ Logic-variabler: ${logicList.length} i alt | ${usedCount} med ID i flow | ${scriptOnly.length} kun i HomeyScript | ${nameOnly.length} kun som tekst i flow | ${unused.length} uden spor.`);

        if (unused.length > 0) {
            console.log(`\n📌 Ubrugte Logic-variabler (${unused.length}):`);
            unused.forEach(v => {
                const type = v.type ? ` | Type: ${v.type}` : '';
                console.log(`   - Navn: "${v.name || v.id}"${type}`);
            });
        } else {
            console.log('\n📌 Ingen helt ubrugte Logic-variabler fundet.');
        }

        if (scriptOnly.length > 0) {
            console.log(`\n📌 Kun brugt i HomeyScript (${scriptOnly.length}):`);
            scriptOnly.forEach(({ v, scripts }) => {
                const type = v.type ? ` | Type: ${v.type}` : '';
                console.log(`   - Navn: "${v.name || v.id}"${type} | Scripts: ${scripts.join(', ')}`);
            });
        }

        if (nameOnly.length > 0) {
            console.log(`\n📌 Kun tekst-navn i flow, ingen variabel-ID (${nameOnly.length}) — tjek manuelt:`);
            nameOnly.forEach(v => {
                const type = v.type ? ` | Type: ${v.type}` : '';
                console.log(`   - Navn: "${v.name || v.id}"${type}`);
            });
        }

        console.log('\nℹ️ Rapporten sletter ingenting. Et navn i en notifikation tæller som tekst, ikke som rigtig variabel-brug.');

        try {
            await tag('Antal_Ubrugte_Logic_Variabler', unused.length);
        } catch (err) {
            console.error(`⚠️ Kunne ikke opdatere system-tag 'Antal_Ubrugte_Logic_Variabler': ${err.message}`);
        }
        return unused.length > 0;
    }

    // Find ID'et for den logiske variabel, vi leder efter.
    // Dette er afgørende for at kunne finde den i standard flows, hvor den ofte kun er refereret via ID.
    let logicVarToSearch = null;
    for (const v of Object.values(allLogicVars || {})) {
        if (!v) continue;
        if ((v.name || '').toLowerCase() === variableToFind.toLowerCase()) {
            logicVarToSearch = v;
            break;
        }
    }

    let findings = [];
    let updateFailures = 0;
    
    console.log(`🔍 Starter i [${ACTION}] tilstand for: "${variableToFind}"${ACTION === 'REPLACE' ? ` → "${newVariableName}"` : ''}...\n`);

    if (ACTION === 'REPLACE' && !logicVarToSearch) {
        if (!REPLACE_FREE_TEXT) {
            console.error(`❌ Afbrudt: Ingen Logic-variabel hedder "${variableToFind}", og REPLACE_FREE_TEXT er false. Intet ID at omdøbe.`);
            return false;
        }
        console.error(`⚠️ Ingen Logic-variabel hedder "${variableToFind}". REPLACE_FREE_TEXT er true — kun fritekst bliver rettet, ikke et Logic-tag.`);
    }
    const folderFilterActive = Boolean(String(SCOPE.folder || '').trim());
    if (ACTION === 'REPLACE' && logicVarToSearch && !SCOPE.logicVars) {
        console.error('⚠️ SCOPE.logicVars er slået fra. Selve Logic-variablen bliver ikke omdøbt.');
    }
    if (ACTION === 'REPLACE' && folderFilterActive) {
        console.error('⚠️ Mappefilter er sat. Logic-variablen omdøbes IKKE (det ville ramme alle flows). HomeyScripts springes over. Flow-JSON skrives kun hvis WRITE_FLOW_JSON også er true.');
    }
    if (ACTION === 'REPLACE' && REPLACE_FREE_TEXT && !WRITE_FLOW_JSON) {
        console.log('ℹ️ WRITE_FLOW_JSON er false: fritekst i flows vises, men flow-JSON sendes ikke tilbage. Scripts kan stadig opdateres.');
    }
    if (ACTION === 'REPLACE' && REPLACE_FREE_TEXT && WRITE_FLOW_JSON) {
        console.log('⚠️ WRITE_FLOW_JSON er true: ændrede flows sendes tilbage. Ikke-kort-felter skal være uændrede, ellers skrives flowet ikke.');
    }
    if (ACTION === 'REPLACE' && REPLACE_FREE_TEXT) {
        console.log(folderFilterActive
            ? '⚠️ REPLACE_FREE_TEXT er true: ordet kan erstattes i kort-tekst i de flows, mappen matcher. Scripts og selve Logic-variablen springes over.'
            : '⚠️ REPLACE_FREE_TEXT er true: ordet kan også erstattes i beskeder, argumenter og scripts — ikke kun som variabel.');
    } else if (ACTION === 'REPLACE') {
        console.log('ℹ️ REPLACE er ID-baseret: kun Logic-variablen omdøbes. Fritekst i beskeder/scripts springes over.');
    }

    const performUpdate = ACTION === 'REPLACE';
    const applyTextReplace = performUpdate && !dryRun && REPLACE_FREE_TEXT;
    const replacementStr = newVariableName;

    let nameCollision = null;
    if (performUpdate) {
        const wanted = String(newVariableName || '').trim().toLowerCase();
        for (const v of Object.values(allLogicVars || {})) {
            if (!v || !v.name) continue;
            if (v.name.toLowerCase() !== wanted) continue;
            if (logicVarToSearch && v.id === logicVarToSearch.id) continue;
            nameCollision = v;
            break;
        }
        if (nameCollision) {
            console.error(`\n🛑 NAVNEKOLLISION: Logic-variablen "${nameCollision.name}" findes allerede. REPLACE kan ikke omdøbe "${variableToFind}" til "${newVariableName}".`);
            if (!dryRun) {
                console.error('Ingen ændringer er gemt.');
                return false;
            }
            console.error('Dry run fortsætter, så du kan se træffene — men skrivning er blokeret, indtil du vælger et ledigt navn.');
        }
    }

    // Hjælpefunktion til at afvikle opdateringer i batches for maksimal performance
    async function runInBatches(tasks, batchSize = 10) {
        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            await Promise.all(batch.map(task => task()));
            // Kort pause mellem batches, så Homey kan nå at trække vejret
            if (i + batchSize < tasks.length) {
                if (typeof wait === 'function') await wait(50);
                else if (typeof setTimeout === 'function') await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }

    // Generisk funktion til at behandle flows for at undgå kodeduplikering
    function processFlows({ items, itemTypeName, updateApi, updatePayloadKey, tasksArray }) {
        for (const item of Object.values(items || {})) {
            if (!item) continue;
            const folderName = getFolderName(item.folder);
            if (!folderInScope(folderName)) continue;

            let { hasMatch, hasReplaceableMatch } = deepSearchAndReplace(item, variableToFind, replacementStr, false);
            const cardScan = replaceInFlowCardRoots(item, itemTypeName, variableToFind, replacementStr, false);
            const writableInCardRoots = Boolean(cardScan.ok && cardScan.hasReplaceableMatch);

            if (!hasMatch && logicVarToSearch) {
                if (deepSearchForId(item, logicVarToSearch.id)) {
                    hasMatch = true;
                }
            }

            if (hasMatch) {
                const hits = collectFlowHits(item, variableToFind, logicVarToSearch && logicVarToSearch.id, logicVarToSearch && logicVarToSearch.name);
                if (!hits.length && logicVarToSearch) {
                    hits.push({
                        card: 'Ukendt kort/felt',
                        snippet: `Logic-variabel «${logicVarToSearch.name}» (ID fundet i flow-JSON, felt kunne ikke udpeges)`,
                        kind: 'id',
                        count: 1
                    });
                }
                const canWriteFlowJson = REPLACE_FREE_TEXT && WRITE_FLOW_JSON && writableInCardRoots;
                findings.push({ Type: itemTypeName, Navn: item.name, Mappe: folderName, Hits: hits, willWrite: canWriteFlowJson });

                if (performUpdate && REPLACE_FREE_TEXT && !WRITE_FLOW_JSON && writableInCardRoots) {
                    // Én samlet advarsel logges før skrivning.
                } else if (performUpdate && REPLACE_FREE_TEXT && WRITE_FLOW_JSON && hasReplaceableMatch && !writableInCardRoots) {
                    console.error(`⚠️ "${item.name}" (${itemTypeName}): fritekst ligger uden for kort-felter (${getFlowCardRootKeys(itemTypeName).join('/')}). Skrives ikke.`);
                }

                if (performUpdate && canWriteFlowJson && !nameCollision && !dryRun) {
                    tasksArray.push(async () => {
                        try {
                            const clone = cloneJson(item);
                            if (!clone || !clone.id) {
                                updateFailures += 1;
                                console.error(`   -> ❌ Kunne ikke JSON-klone ${itemTypeName.toLowerCase()} "${item.name}". Ikke skrevet.`);
                                return;
                            }
                            const beforeRest = stableWithoutCardRoots(clone, itemTypeName);
                            if (!getPresentFlowCardRoots(clone, itemTypeName).length) {
                                updateFailures += 1;
                                console.error(`   -> ❌ "${item.name}" mangler forventet ${itemTypeName}-struktur. Ikke skrevet.`);
                                return;
                            }
                            const replaced = replaceInFlowCardRoots(clone, itemTypeName, variableToFind, replacementStr, true);
                            if (!replaced.hasReplaceableMatch) {
                                console.error(`   -> ⚠️ Ingen skrivbar fritekst i kort-felter for "${item.name}". Springes over.`);
                                return;
                            }
                            if (stableWithoutCardRoots(clone, itemTypeName) !== beforeRest) {
                                updateFailures += 1;
                                console.error(`   -> ❌ "${item.name}": noget uden for kort-felterne ville ændre sig. Flowet er IKKE sendt tilbage.`);
                                return;
                            }
                            const payload = { id: item.id, [updatePayloadKey]: clone };
                            await withTimeout(updateApi(payload), API_TIMEOUT_MS, `updateApi:${item.name}`);
                            console.log(`   -> 🔄 Auto-opdaterede ${itemTypeName.toLowerCase()}: "${item.name}" (kun kort-felter, resten uændret)`);
                        } catch (err) {
                            updateFailures += 1;
                            console.error(`   -> ❌ Fejl ved opdatering (JSON/API) for ${itemTypeName.toLowerCase()} "${item.name}": ${err.message}`);
                        }
                    });
                }
            }
        }
    }

    // Gennemgå standard flows
    const flowTasks = [];
    if (SCOPE.standardFlows) {
        processFlows({ items: allFlows, itemTypeName: 'Standard Flow', updateApi: Homey.flow.updateFlow, updatePayloadKey: 'flow', tasksArray: flowTasks });
    }

    // Gennemgå Advanced Flows (Athom API-feltet hedder 'advancedflow', ikke 'advancedFlow')
    const advFlowTasks = [];
    if (SCOPE.advancedFlows) {
        processFlows({ items: allAdvancedFlows, itemTypeName: 'Advanced Flow', updateApi: Homey.flow.updateAdvancedFlow, updatePayloadKey: 'advancedflow', tasksArray: advFlowTasks });
    }

    // Gennemgå HomeyScripts
    const scriptTasks = [];
    const protectedSelf = [];
    const selfIds = collectSelfScriptIds();
    if (SCOPE.scripts) {
    for (const script of Object.values(scriptsById)) {
        if (selfIds.has(script.id)) {
            protectedSelf.push(script);
            continue;
        }
        if (!hasScriptCode(script)) continue;

        const { hasMatch, resultText: updatedCode } = searchAndReplaceWithBoundaries(script.code, variableToFind, replacementStr, applyTextReplace);
        if (hasMatch) {
            const hits = collectScriptHits(script.code, variableToFind);
            findings.push({
                Type: 'HomeyScript',
                Navn: script.name,
                Mappe: 'Scripts',
                Hits: hits,
                willWrite: hasMatch && REPLACE_FREE_TEXT && !folderFilterActive
            });

            if (performUpdate && REPLACE_FREE_TEXT && !folderFilterActive && !dryRun && !nameCollision) {
                scriptTasks.push(async () => {
                    try {
                        await withTimeout(updateHomeyScript(script, updatedCode), API_TIMEOUT_MS, `updateScript: ${script.name}`);
                        console.log(`   -> 🔄 Auto-opdaterede HomeyScript: "${script.name}"`);
                    } catch (err) {
                        updateFailures += 1;
                        console.error(`   -> ❌ Fejl ved opdatering af HomeyScript: ${err.message}`);
                    }
                });
            }
        }
    }
    if (loadedScriptCount > 0) {
        if (protectedSelf.length > 0) {
            const names = protectedSelf.map(s => `"${s.name || s.id}"`).join(', ');
            console.log(`ℹ️ Selv-beskyttelse aktiv: sprang ${protectedSelf.length} instans(er) over: ${names}.`);
        } else {
            console.log('⚠️ Fingerprint blev ikke fundet i nogen HomeyScripts. Slet ikke konstanten SELF_MARKER — ellers kan værktøjet rette i sig selv.');
        }
    }
    }

    // Gennemgå Homey Logic Variabler
    const logicVarTasks = [];
    if (SCOPE.logicVars) {
    for (const logicVar of Object.values(allLogicVars || {})) {
        if (!logicVar) continue;
        const name = logicVar.name || "";
        // For variabler tjekker vi det præcise navn (ignorerer dog store/små bogstaver)
        if (name.toLowerCase() === variableToFind.toLowerCase()) {
            const renameLogic = performUpdate && !folderFilterActive;
            findings.push({
                Type: 'Logic Variabel',
                Navn: name,
                Mappe: 'Homey Logic',
                Hits: [{ card: 'Logic', snippet: `variabel «${name}»`, kind: 'logic', count: 1 }],
                willWrite: renameLogic
            });

            if (renameLogic && !dryRun && !nameCollision) {
                logicVarTasks.push(async () => {
                    try {
                        await withTimeout(Homey.logic.updateVariable({ id: logicVar.id, variable: { name: newVariableName } }), API_TIMEOUT_MS, `updateVariable: ${name}`);
                        console.log(`   -> 🔄 Auto-omdøbte Logic variabel: "${name}" til "${newVariableName}"`);
                    } catch (err) {
                        updateFailures += 1;
                        console.error(`   -> ❌ Fejl ved omdøbning af Logic variabel: ${err.message}`);
                    }
                });
            }
        }
    }
    }
    
    // Gennemgå Indbyggede Tags (Tokens)
    // Bemærk: Homey tokens (tags) genereres ofte dynamisk af apps (runtime-only) og kan sjældent omdøbes via API.
    // Scriptet finder tekst-referencerne i dine flows, men kilde-tagget må rettes manuelt i den respektive app.
    if (SCOPE.tokens) {
    for (const token of Object.values(allTokens || {})) {
        if (!token) continue;
        const tokenName = token.title || token.name || '';
        if (tokenName.toLowerCase() === variableToFind.toLowerCase()) {
            // Spring over Logic variabler, da vi allerede har dækket dem ovenfor
            if (token.uri && token.uri.includes('homey:manager:logic')) continue;
            
            findings.push({
                Type: 'Indbygget Tag',
                Navn: tokenName,
                Mappe: token.uri || 'System',
                Hits: [{ card: 'Tag', snippet: `«${tokenName}» (${token.uri || 'ingen URI'})`, kind: 'token', count: 1 }],
                willWrite: false
            });
        }
    }
    }

    // Sikkerhedscheck FØR nogen skrivning. REPLACE_SAFETY_LIMIT skal stoppe ændringer, ikke rapportere bagefter.
    const writeCount = findings.filter(f => f.willWrite).length;
    const abortWrites = ACTION === 'REPLACE' && !dryRun && !nameCollision && writeCount > REPLACE_SAFETY_LIMIT;
    if (abortWrites) {
        console.error(`\n🛑 SIKKERHEDSSTOP: Du forsøger at ændre ${writeCount} steder, hvilket er over sikkerhedsgrænsen på ${REPLACE_SAFETY_LIMIT}.`);
        console.error('Dette kan skyldes en tastefejl. Hvis du er sikker, kan du øge "REPLACE_SAFETY_LIMIT" i toppen af scriptet.');
        console.error('Ingen ændringer er gemt.');
    } else if (ACTION === 'REPLACE' && !dryRun && !nameCollision) {
        if (flowTasks.length > 0) await runInBatches(flowTasks, 10);
        if (advFlowTasks.length > 0) await runInBatches(advFlowTasks, 10);
        if (scriptTasks.length > 0) await runInBatches(scriptTasks, 10);

        // Kør omdøbning af selve variablen til sidst, efter alle tekst-referencer er håndteret
        if (logicVarTasks.length > 0) {
            await runInBatches(logicVarTasks, 10);
        }
    }

    // Præsentation af resultater
    if (findings.length > 0) {
        console.log(`✅ Fundet ${findings.length} steder:`);
        
        // Gruppér resultaterne efter type
        const groupedFindings = findings.reduce((acc, curr) => {
            if (!acc[curr.Type]) acc[curr.Type] = [];
            acc[curr.Type].push(curr);
            return acc;
        }, {});

        // Udskriv grupperet
        for (const [type, items] of Object.entries(groupedFindings)) {
            console.log(`\n📌 ${type} (${items.length}):`);
            
            // Sorter items alfabetisk efter mappenavn, og derefter efter navn hvis mappen er ens
            items.sort((a, b) => (a.Mappe || '').localeCompare(b.Mappe || '', 'da') || (a.Navn || '').localeCompare(b.Navn || '', 'da'));
            
            items.forEach(f => {
                console.log(`   - Navn: "${f.Navn}" | Mappe: "${f.Mappe}"`);
                const hits = Array.isArray(f.Hits) ? f.Hits : [];
                const codeHits = hits.filter(h => h.kind !== 'kommentar');
                const commentHits = hits.filter(h => h.kind === 'kommentar');
                const shown = codeHits.slice(0, MAX_SNIPPETS_PER_ITEM);
                shown.forEach(h => {
                    const card = h.card ? `${h.card}: ` : '';
                    const times = h.count > 1 ? ` (×${h.count})` : '';
                    const role = (h.kind === 'tekst' || h.kind === 'kommentar') ? 'fritekst · ' : '';
                    let snippet = h.snippet;
                    if (performUpdate) {
                        if (h.kind === 'id' || h.kind === 'logic') {
                            const note = folderFilterActive && h.kind === 'logic'
                                ? ' (springes over: omdøbning er global, og mappefilter er sat)'
                                : ' (ID — selve Logic-variablen omdøbes, UUID i flowet ændres ikke)';
                            snippet = `${h.snippet}${note}`;
                        } else if (h.kind === 'token') {
                            snippet = `${h.snippet} (system-tag kan ikke omdøbes via API)`;
                        } else if (!REPLACE_FREE_TEXT || (folderFilterActive && f.Type === 'HomeyScript')) {
                            snippet = `${h.snippet} (fritekst — springes over)`;
                        } else {
                            snippet = previewReplaceSnippet(h.snippet);
                        }
                    }
                    console.log(`       • ${role}${card}${snippet}${times}`);
                });
                if (codeHits.length > MAX_SNIPPETS_PER_ITEM) {
                    console.log(`       • … +${codeHits.length - MAX_SNIPPETS_PER_ITEM} flere træf`);
                }
                if (commentHits.length > 0) {
                    const extra = performUpdate && REPLACE_FREE_TEXT
                        ? ' (ville også erstattes som tekst)'
                        : (performUpdate ? ' (fritekst i kommentarer springes over)' : '');
                    console.log(`       • +${commentHits.length} træf i kommentarer/dokumentation${extra}`);
                }
            });
        }
        
        if (abortWrites) {
            console.log('\n🛑 REPLACE blev afbrudt af sikkerhedsgrænsen. Ingen ændringer er gemt.');
        } else if (performUpdate && nameCollision) {
            console.log('\n🛑 REPLACE er blokeret pga. navnekollision. Intet er ændret.');
        } else if (performUpdate) {
            let textHits = 0;
            let idHits = 0;
            for (const f of findings) {
                for (const h of f.Hits || []) {
                    const n = h.count || 1;
                    if (h.kind === 'id' || h.kind === 'logic') idHits += n;
                    else if (h.kind !== 'kommentar' && h.kind !== 'token') textHits += n;
                }
            }
            console.log(`\n🧪 REPLACE-forhåndsvisning: "${variableToFind}" → "${newVariableName}" | ${REPLACE_FREE_TEXT ? 'ID + fritekst' : 'kun Logic-ID'} | ${writeCount} skrivninger | ${textHits} tekst-træf | ${idHits} kun ID-tag.`);
            if (dryRun) {
                console.log('⚠️ Dry run (intet er ændret). Sæt "const dryRun = false;" for at udføre handlingen!');
            } else if (updateFailures > 0) {
                console.error(`\n⚠️ REPLACE afsluttet med ${updateFailures} fejl. Tjek ❌-linjerne ovenfor. Nogle steder kan være opdateret, andre ikke.`);
            } else {
                console.log(`\n✅ ${ACTION}-handling fuldført.`);
            }
        } else if (ACTION === 'SEARCH') {
            console.log('\n🔎 Søgning fuldført. Ingen ændringer foretaget (ACTION er sat til SEARCH).');
        }
    } else {
        console.log('❌ Variablen blev ikke fundet i de valgte kilder (SCOPE).');
    }
    
    try {
        await tag('Antal_Variabler_Fundet', findings.length);
    } catch (err) {
        console.error(`⚠️ Kunne ikke opdatere system-tag 'Antal_Variabler_Fundet': ${err.message}`);
    }

    return findings.length > 0;
}

try {
    await findVariableUsage();
} catch (err) {
    console.error(`❌ Scriptet stoppede med en uventet fejl: ${err && err.message ? err.message : err}`);
    throw err;
}