/**
 * ==============================================================================
 * Homey Device Replacement & Swap Script
 * ==============================================================================
 * 
 * Beskrivelse:
 * Dette script automatiserer udskiftningen af en gammel enhed med en ny i hele 
 * dit Homey-system. Det gennemsøger og opdaterer Standard Flows, Advanced Flows 
 * og valgfrit HomeyScripts.
 * 
 * Hovedfunktioner:
 * - Erstatning: Erstatter alle referencer fra den gamle enhed til den nye.
 * - Swap (Bytte): Kan bytte om på to enheder, så de overtager hinandens plads (valgfrit).
 * - Dry-run: Test ændringerne sikkert i loggen uden at gemme noget (anbefales først).
 * - Tjek af Capabilities: Advarer hvis et kort, der faktisk bruger en af enhederne,
 *   har en kendt capability-reference, som den anden enhed mangler. Scanningen kan
 *   ikke garantere at fange alle Homeys repræsentationer.
 * - Gemning: Flows gemmes ikke, hvis enhederne har forskellig type, eller hvis et
 *   berørt kort bruger en capability, som den enhed det flyttes til, mangler.
 * - Avancerede indstillinger: Kopieres kun når driver og klasse er ens, og kun
 *   for indstillinger der findes på begge med samme type. Identitet og adgangskoder
 *   kopieres ikke. Ellers skrives der ingen indstillinger.
 * 
 * Vejledning:
 * 1. Indtast de præcise navne på dine enheder i 'oldDeviceName' og 'newDeviceName'.
 * 2. Behold 'dryRun = true' og kør scriptet for at se ændringerne i loggen.
 * 3. Ret 'dryRun = false' og kør scriptet igen for rent faktisk at gemme ændringerne.
 *
 * Rettigheder:
 * Læsning af flows kan virke uden skrivetilladelse. Gemning via updateFlow /
 * updateAdvancedFlow kræver homey.flow-scope. Uden det får du Missing Scopes,
 * selvom scriptet finder og ændrer kortene i hukommelsen.
 * Avancerede indstillinger kræver homey.device ved skrivning.
 * ==============================================================================
 */

// Disse navne bruges KUN til at finde enhedernes unikke ID'er. 
const oldDeviceName = "D1"; 
const newDeviceName = "D2";
const dryRun = true; // Sæt til false for at udføre ændringerne rigtigt
const swapDevices = false; // Sæt til true for at bytte om på enhederne (swap)
const updateScripts = false; // Sæt til false for at springe opdatering af Homey Scripts over
const copySettings = true; // Kopiér avancerede indstillinger, kun når enhederne understøtter hinanden

const PROTECTION_TOKEN = "###_SELF_PROTECTION_TOKEN_###"; // Forhindrer scriptet i at ændre sig selv

async function main() {
    const devices = await Homey.devices.getDevices();
    
    // Hjælpefunktion til pauser (skåner Homey ved mange opdateringer)
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Hjælpefunktion til at sikre ID'er i Regex ikke ødelægger søgningen
    const escapeRegExp = (string) => {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Find enheder og tjek for dubletter for at undgå fejl
    const oldDevices = Object.values(devices).filter(d => d.name === oldDeviceName);
    const newDevices = Object.values(devices).filter(d => d.name === newDeviceName);

    if (oldDevices.length === 0) {
        return log(`❌ Fejl: Kunne ikke finde enheden med navnet "${oldDeviceName}".`);
    }
    if (newDevices.length === 0) {
        return log(`❌ Fejl: Kunne ikke finde enheden med navnet "${newDeviceName}".`);
    }
    if (oldDevices.length > 1) {
        const ids = oldDevices.map(d => d.id).join(', ');
        return log(`❌ Fejl: Fandt ${oldDevices.length} enheder med navnet "${oldDeviceName}". Vælg et unikt navn. Fundne ID'er: ${ids}`);
    }
    if (newDevices.length > 1) {
        const ids = newDevices.map(d => d.id).join(', ');
        return log(`❌ Fejl: Fandt ${newDevices.length} enheder med navnet "${newDeviceName}". Vælg et unikt navn. Fundne ID'er: ${ids}`);
    }

    const oldDevice = oldDevices[0];
    const newDevice = newDevices[0];

    if (oldDevice.id === newDevice.id) {
        return log(`❌ Fejl: Den gamle og den nye enhed er den samme enhed.`);
    }

    if (swapDevices) {
        log(`🔄 SWAP AKTIVERET: Bytter om på '${oldDevice.name}' og '${newDevice.name}' i alle flows...`);
    } else {
        log(`Erstatter '${oldDevice.name}' (${oldDevice.id}) med '${newDevice.name}' (${newDevice.id}) i alle flows...`);
    }
    
    // SIKKERHEDSTJEK: Sammenlign enhederne før start
    const classMismatch = oldDevice.class !== newDevice.class;
    if (classMismatch) {
        log(`\n⚠️  ADVARSEL: Enhederne er ikke af samme type! (${oldDevice.class} vs ${newDevice.class})`);
        log(`    Flows med den forskel gemmes ikke.`);
    }
    
    const oldCaps = Array.isArray(oldDevice.capabilities) ? oldDevice.capabilities : [];
    const newCaps = Array.isArray(newDevice.capabilities) ? newDevice.capabilities : [];

    const missingCaps = oldCaps.filter(c => !newCaps.includes(c));
    if (missingCaps.length > 0) {
        log(`⚠️  ADVARSEL: Den nye enhed mangler følgende funktioner: ${missingCaps.join(', ')}`);
        log(`    Flows der bruger disse funktioner vil sandsynligvis fejle!\n`);
    }

    const reverseMissingCaps = newCaps.filter(c => !oldCaps.includes(c));
    if (swapDevices && reverseMissingCaps.length > 0) {
        log(`⚠️  ADVARSEL (Swap): Den gamle enhed mangler funktioner som den nye enhed har: ${reverseMissingCaps.join(', ')}`);
    }

    const missingCapSet = new Set(missingCaps);
    const reverseMissingCapSet = new Set(swapDevices ? reverseMissingCaps : []);
    const capsToScan = [...missingCapSet, ...reverseMissingCapSet].sort((a, b) => b.length - a.length);

    // Finder mange kendte capability-referencer (cap, cap_true, cap.sub). Ikke en garanti for alle Homey-formater.
    const matchCapInString = (str, hits) => {
        if (!str || typeof str !== 'string' || capsToScan.length === 0) return;
        const candidates = str.includes(':') ? [str, str.split(':').pop()] : [str];
        for (const candidate of candidates) {
            for (const cap of capsToScan) {
                if (candidate === cap || candidate.startsWith(cap + '_') || candidate.startsWith(cap + '.')) {
                    hits.add(cap);
                    break;
                }
            }
        }
    };

    const collectCapHits = (value, hits, seen) => {
        if (!value || capsToScan.length === 0) return;
        if (typeof value === 'string') {
            matchCapInString(value, hits);
            return;
        }
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collectCapHits(item, hits, seen);
            return;
        }
        for (const key of Object.keys(value)) {
            if (key === 'title' || key === 'titleFormatted' || key === 'name') continue;
            matchCapInString(key, hits);
            collectCapHits(value[key], hits, seen);
        }
    };

    let count = 0;
    let skippedSaves = 0;
    let totalMatches = 0;
    const riskyFlows = [];
    const blockedFlows = new Set();

    const valueContainsId = (value, deviceId, seen) => {
        if (typeof value === 'string') return value.includes(deviceId);
        if (!value || typeof value !== 'object') return false;
        if (seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.some(item => valueContainsId(item, deviceId, seen));
        return Object.keys(value).some(key => valueContainsId(value[key], deviceId, seen));
    };

    const reportCapabilityRisk = (card, flowName, flowId) => {
        if (capsToScan.length === 0 || !card || typeof card !== 'object') return;
        const touchesOld = valueContainsId(card, oldDevice.id, new WeakSet());
        const touchesNew = swapDevices && valueContainsId(card, newDevice.id, new WeakSet());
        if (!touchesOld && !touchesNew) return;

        const relevant = new Set();
        if (touchesOld) {
            for (const cap of missingCapSet) relevant.add(cap);
        }
        if (touchesNew) {
            for (const cap of reverseMissingCapSet) relevant.add(cap);
        }
        if (relevant.size === 0) return;

        const hits = new Set();
        collectCapHits(card, hits, new WeakSet());
        for (const cap of hits) {
            if (!relevant.has(cap)) continue;
            let where;
            if (missingCapSet.has(cap) && reverseMissingCapSet.has(cap)) {
                where = 'mangler på begge enheder';
            } else if (missingCapSet.has(cap)) {
                where = `mangler på '${newDevice.name}'`;
            } else {
                where = `mangler på '${oldDevice.name}' ved swap`;
            }
            const msg = `Flow '${flowName}' bruger '${cap}' (${where})`;
            if (!riskyFlows.includes(msg)) riskyFlows.push(msg);
            blockedFlows.add(flowId);
        }
    };

    const nameChars = 'A-Za-z0-9_æøåÆØÅ';
    const replaceWholeName = (text, fromName, toName) => {
        if (!fromName || typeof text !== 'string' || !text.includes(fromName)) return text;
        const re = new RegExp(`(^|[^${nameChars}])${escapeRegExp(fromName)}(?![${nameChars}])`, 'g');
        return text.replace(re, (match, prefix) => prefix + toName);
    };
    const containsWholeName = (text, name) => replaceWholeName(text, name, '\u0000') !== text;
    const swapWholeNames = (text) => {
        const marker = '\u0000NAME\u0000';
        return replaceWholeName(replaceWholeName(text, oldDeviceName, marker), newDeviceName, oldDeviceName)
            .split(marker)
            .join(newDeviceName);
    };

    // Pre-kompiler RegExp for 'swap' så den ikke genereres tusindvis af gange i rekursionen
    const swapRegex = new RegExp(`${escapeRegExp(oldDevice.id)}|${escapeRegExp(newDevice.id)}`, 'g');

    // Hjælpefunktion til at søge og erstatte i flow-kort
    const processCards = (cards, flowName, flowId, section = 'Kort') => {
        let changed = false;
        if (!cards) return false;
        const list = Array.isArray(cards) ? cards : [cards];
        const idAlreadySwapped = new WeakSet();
        
        // Rekursiv funktion til at håndtere nested objekter og tekst-strenge
        const traverseAndReplace = (obj, path = '') => {
            let modified = false;
            if (!obj || typeof obj !== 'object') return false;

            for (const key of Object.keys(obj)) {
                if (key === 'id' && idAlreadySwapped.has(obj)) continue;
                const val = obj[key];
                const currentPath = path ? `${path}.${key}` : key;

                // 1. Direkte ID match
                if (val === oldDevice.id) {
                    log(`   🔹 [${flowName}] (${section}) -> Argument '${currentPath}':`);
                    log(`      -> Erstatter ID: ${oldDevice.name} => ${newDevice.name}`);
                    totalMatches++;
                    if (!dryRun) obj[key] = newDevice.id;
                    modified = true;
                } else if (swapDevices && val === newDevice.id) {
                    log(`   🔹 [${flowName}] (${section}) -> Argument '${currentPath}':`);
                    log(`      -> Bytter ID (Swap): ${newDevice.name} => ${oldDevice.name}`);
                    totalMatches++;
                    if (!dryRun) obj[key] = oldDevice.id;
                    modified = true;
                }
                // 2. Tekst-streng der indeholder ID'et (f.eks. HomeyScript argument eller JSON)
                else if (typeof val === 'string') {
                    if (swapDevices && (val.includes(oldDevice.id) || val.includes(newDevice.id))) {
                        log(`   🔹 [${flowName}] (${section}) -> Tekstfelt '${currentPath}':`);
                        log(`      -> Bytter ID'er i tekststreng`);
                        totalMatches++;
                        if (!dryRun) {
                            obj[key] = val.replace(swapRegex, (m) => m === oldDevice.id ? newDevice.id : oldDevice.id);
                        }
                        modified = true;
                    } else if (!swapDevices && val.includes(oldDevice.id)) {
                        log(`   🔹 [${flowName}] (${section}) -> Tekstfelt '${currentPath}':`);
                        log(`      -> Erstatter ID i tekststreng`);
                        totalMatches += val.split(oldDevice.id).length - 1;
                        if (!dryRun) obj[key] = val.split(oldDevice.id).join(newDevice.id);
                        modified = true;
                    }
                }
                // 3. Objekt/Array (Rekursion)
                else if (val && typeof val === 'object') {
                    if (!Array.isArray(val) && (val.id === oldDevice.id || (swapDevices && val.id === newDevice.id))) {
                        const toNew = val.id === oldDevice.id;
                        log(`   🔹 [${flowName}] (${section}) -> Objekt '${currentPath}':`);
                        log(`      -> Opdaterer enheds-objekt${toNew ? '' : ' (Swap)'}: ${toNew ? oldDevice.name : newDevice.name} => ${toNew ? newDevice.name : oldDevice.name}`);
                        totalMatches++;
                        idAlreadySwapped.add(val);
                        if (!dryRun) {
                            val.id = toNew ? newDevice.id : oldDevice.id;
                            if (val.name) val.name = toNew ? newDevice.name : oldDevice.name;
                        }
                        modified = true;
                    }

                    if (!Array.isArray(val) && typeof val.uri === 'string' && typeof val.title === 'string') {
                        const uriHasOld = val.uri.includes(oldDevice.id);
                        const uriHasNew = swapDevices && val.uri.includes(newDevice.id);
                        if (uriHasOld && uriHasNew && (containsWholeName(val.title, oldDeviceName) || containsWholeName(val.title, newDeviceName))) {
                            log(`   🔹 [${flowName}] (${section}) -> Tag/Token '${currentPath}':`);
                            log(`      -> Bytter hele enhedsnavne i titel`);
                            if (!dryRun) val.title = swapWholeNames(val.title);
                            modified = true;
                        } else if (uriHasOld && containsWholeName(val.title, oldDeviceName)) {
                            log(`   🔹 [${flowName}] (${section}) -> Tag/Token '${currentPath}':`);
                            log(`      -> Omdøber Tag-titel: '${oldDeviceName}' => '${newDeviceName}'`);
                            if (!dryRun) val.title = replaceWholeName(val.title, oldDeviceName, newDeviceName);
                            modified = true;
                        } else if (uriHasNew && containsWholeName(val.title, newDeviceName)) {
                            log(`   🔹 [${flowName}] (${section}) -> Tag/Token (Swap) '${currentPath}':`);
                            log(`      -> Omdøber Tag-titel: '${newDeviceName}' => '${oldDeviceName}'`);
                            if (!dryRun) val.title = replaceWholeName(val.title, newDeviceName, oldDeviceName);
                            modified = true;
                        }
                    }

                    if (traverseAndReplace(val, currentPath)) modified = true;
                }
            }
            return modified;
        };

        for (const card of list) {
            if (!card || typeof card !== 'object') continue;
            reportCapabilityRisk(card, flowName, flowId);
            if (traverseAndReplace(card)) changed = true;
        }
        return changed;
    };

    const saveBlockReason = (flowId) => {
        const capRisk = blockedFlows.has(flowId);
        if (classMismatch && capRisk) return 'enhederne er ikke samme type, og et kort bruger en capability den anden enhed mangler';
        if (classMismatch) return `enhederne er ikke samme type (${oldDevice.class} vs ${newDevice.class})`;
        if (capRisk) return 'et kort bruger en capability, som den enhed det flyttes til, mangler';
        return '';
    };

    // Hent og gennemgå alle standard flows
    const flows = await Homey.flow.getFlows();
    for (const flow of Object.values(flows)) {
        let flowModified = false;
        // Brug ?. for at undgå fejl hvis en sektion mangler
        if (processCards(flow.trigger, flow.name, flow.id, 'Trigger')) flowModified = true;
        if (processCards(flow.conditions, flow.name, flow.id, 'Betingelse')) flowModified = true;
        if (processCards(flow.actions, flow.name, flow.id, 'Handling')) flowModified = true;
        // VIGTIGT: Husk også "Ellers" (Else) sektionen!
        if (flow.actionsAny && processCards(flow.actionsAny, flow.name, flow.id, 'Ellers (Else)')) flowModified = true;

        if (flowModified) {
            const reason = saveBlockReason(flow.id);
            if (reason) {
                skippedSaves++;
                log(`   ⛔ ${dryRun ? 'Ville ikke gemme' : 'Gemmer ikke'} '${flow.name}': ${reason}`);
            } else {
                log(`Opdaterer flow: ${flow.name}`);
                count++;
                if (!dryRun) {
                    try {
                        // Korrekt API: updateFlow({ id, flow }). Kræver homey.flow-scope (skrivning).
                        await Homey.flow.updateFlow({ id: flow.id, flow: flow });
                    } catch (err) {
                        log(`   ❌ Fejl ved opdatering af flow '${flow.name}':`, err);
                        if (String(err).includes('Missing Scopes') || String(err.message || '').includes('scope')) {
                            log('   ℹ️  Gemning kræver homey.flow-scope. Læsning kan virke, mens skrivning afvises.');
                        }
                    }
                    await wait(50); // Lille pause for stabilitet
                }
            }
        }
    }

    // Hent og gennemgå alle Advanced Flows
    const advancedFlows = await Homey.flow.getAdvancedFlows();
    for (const flow of Object.values(advancedFlows)) {
        // Advanced Flows gemmer kort i et 'cards' objekt. Vi bruger Object.values for at få dem som en liste.
        if (flow.cards && processCards(Object.values(flow.cards), flow.name, flow.id, 'Advanced Flow')) {
            const reason = saveBlockReason(flow.id);
            if (reason) {
                skippedSaves++;
                log(`   ⛔ ${dryRun ? 'Ville ikke gemme' : 'Gemmer ikke'} '${flow.name}': ${reason}`);
            } else {
                log(`Opdaterer Advanced Flow: ${flow.name}`);
                count++;
                if (!dryRun) {
                    try {
                        await Homey.flow.updateAdvancedFlow({
                            id: flow.id,
                            advancedflow: flow
                        });
                    } catch (err) {
                        log(`   ❌ Fejl ved opdatering af Advanced Flow '${flow.name}':`, err);
                        if (String(err).includes('Missing Scopes') || String(err.message || '').includes('scope')) {
                            log('   ℹ️  Gemning kræver homey.flow-scope. Læsning kan virke, mens skrivning afvises.');
                        }
                    }
                    await wait(50); // Lille pause for stabilitet
                }
            }
        }
    }

    // Hent og gennemgå Homey Scripts
    if (updateScripts) {
        log('\n🔍 Tjekker Homey Scripts...');
        try {
            const scripts = await Homey.api('GET', '/app/com.athom.homeyscript/scripts');
            for (const scriptId of Object.keys(scripts)) {
                const script = scripts[scriptId];
                try {
                    if (!script.code) continue;

                    if (script.code.includes(PROTECTION_TOKEN)) {
                        log(`      🛡️  Springer script '${script.name}' over (det er dette script)`);
                        continue;
                    }

                    let code = script.code;
                    let scriptModified = false;
                    let matchCount = 0;

                    if (swapDevices) {
                        if (code.includes(oldDevice.id) || code.includes(newDevice.id)) {
                            swapRegex.lastIndex = 0;
                            const matches = code.match(swapRegex);
                            if (matches) {
                                matchCount = matches.length;
                                log(`   📜 [Script: ${script.name}] -> Fandt ${matchCount} ID-matches til Swap`);
                                if (!dryRun) {
                                    swapRegex.lastIndex = 0;
                                    code = code.replace(swapRegex, (m) => m === oldDevice.id ? newDevice.id : oldDevice.id);
                                }
                                scriptModified = true;
                            }
                        }
                    } else {
                        if (code.includes(oldDevice.id)) {
                            matchCount = code.split(oldDevice.id).length - 1;
                            log(`   📜 [Script: ${script.name}] -> Fandt ${matchCount} forekomster af gammelt ID`);
                            if (!dryRun) code = code.split(oldDevice.id).join(newDevice.id);
                            scriptModified = true;
                        }
                    }

                    if (scriptModified) {
                        totalMatches += matchCount;
                        if (!dryRun) await Homey.api('PUT', `/app/com.athom.homeyscript/script/${scriptId}`, { code: code });
                        log(`      ${dryRun ? 'ℹ️  (DryRun) Ville opdatere' : '✅ Opdaterede'} script '${script.name}'`);
                        if (!dryRun) await wait(50);
                    }
                } catch (err) {
                    log(`   ❌ Fejl ved script '${script && script.name ? script.name : scriptId}': ${err.message}`);
                }
            }
        } catch (err) { log(`❌ Kunne ikke behandle scripts (API fejl): ${err.message}`); }
    } else {
        log('\n⏭️  Springer Homey Scripts over (deaktiveret i indstillinger).');
    }
    
    const driverOf = (device) => {
        if (typeof device.driverUri === 'string' && device.driverUri) return device.driverUri;
        if (typeof device.driverId === 'string' && device.driverId) return device.driverId;
        return '';
    };

    const settingTitle = (field) => {
        if (typeof field.title === 'string' && field.title) return field.title;
        if (typeof field.label === 'string' && field.label) return field.label;
        if (field.label && typeof field.label === 'object') {
            return field.label.da || field.label.en || field.id;
        }
        return field.id;
    };

    const collectSettingFields = (node, fields, seen) => {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const item of node) collectSettingFields(item, fields, seen);
            return;
        }
        if (typeof node.id === 'string' && typeof node.type === 'string' && node.type !== 'group' && node.type !== 'label') {
            if (!fields.some(field => field.id === node.id)) fields.push(node);
        }
        if (node.children) collectSettingFields(node.children, fields, seen);
        for (const key of Object.keys(node)) {
            if (key === 'children' || key === 'label' || key === 'hint' || key === 'values' || key === 'units') continue;
            const child = node[key];
            if (child && typeof child === 'object') collectSettingFields(child, fields, seen);
        }
    };

    const loadSettingMap = async (deviceId) => {
        const schema = await Homey.devices.getDeviceSettingsObj({ id: deviceId });
        let stored = null;
        if (typeof Homey.devices.getDeviceSettings === 'function') {
            try {
                stored = await Homey.devices.getDeviceSettings({ id: deviceId });
            } catch (err) {
                stored = null;
            }
        }
        const fields = [];
        collectSettingFields(schema, fields, new Set());
        const map = new Map();
        for (const field of fields) {
            const hasStored = stored && Object.prototype.hasOwnProperty.call(stored, field.id);
            map.set(field.id, {
                id: field.id,
                type: field.type,
                value: hasStored ? stored[field.id] : field.value,
                title: settingTitle(field)
            });
        }
        return map;
    };

    const isIdentitySetting = (field) => {
        if (field.type === 'password') return true;
        return /(^|_)(mac|ieee|eui64|eui|ip|host|hostname|port|token|password|passwd|secret|serial|uuid|node_?id|home_?id|meter_?id|network_?key|install_?code|encryption_?key)($|_)|address|credential|zigbee|zwave/i
            .test(`${field.id} ${field.title}`);
    };

    const isCopyableValue = (value) => value === null || ['boolean', 'number', 'string'].includes(typeof value);

    async function copyCompatibleSettings() {
        log('\n⚙️  Avancerede indstillinger...');
        if (!copySettings) {
            log('⏭️  Springer avancerede indstillinger over (deaktiveret i indstillinger).');
            return;
        }

        const oldDriver = driverOf(oldDevice);
        const newDriver = driverOf(newDevice);
        if (!oldDriver || !newDriver || oldDriver !== newDriver) {
            log(`⏭️  Kopierer ikke indstillinger: enhederne har ikke samme driver ('${oldDriver || 'ukendt'}' vs '${newDriver || 'ukendt'}').`);
            return;
        }
        if (classMismatch) {
            log('⏭️  Kopierer ikke indstillinger: enhederne er ikke samme type.');
            return;
        }
        if (typeof Homey.devices.getDeviceSettingsObj !== 'function' || typeof Homey.devices.setDeviceSettings !== 'function') {
            log('⏭️  Kopierer ikke indstillinger: Homey Script kan ikke læse og skrive enhedsindstillinger her.');
            return;
        }

        let oldMap;
        let newMap;
        try {
            oldMap = await loadSettingMap(oldDevice.id);
            newMap = await loadSettingMap(newDevice.id);
        } catch (err) {
            log(`⏭️  Kopierer ikke indstillinger: kunne ikke læse dem (${err.message}).`);
            return;
        }

        log(`Samme driver og type. Sammenligner ${oldMap.size} og ${newMap.size} indstillinger.`);
        if (oldMap.size === 0 || newMap.size === 0) {
            log('⏭️  Kopierer ikke indstillinger: mindst én enhed har ingen læsbare indstillingsfelter.');
            return;
        }

        const writableTypes = new Set(['checkbox', 'text', 'number', 'dropdown', 'radio']);
        const toNew = {};
        const toOld = {};
        const skipped = [];

        for (const [id, source] of oldMap) {
            const target = newMap.get(id);
            if (!target) {
                skipped.push(`${source.title} (findes kun på '${oldDevice.name}')`);
                continue;
            }
            if (source.type !== target.type || !writableTypes.has(source.type)) {
                skipped.push(`${source.title} (typen passer ikke)`);
                continue;
            }
            if (isIdentitySetting(source)) {
                skipped.push(`${source.title} (identitet eller adgangskode)`);
                continue;
            }
            if (!isCopyableValue(source.value) || !isCopyableValue(target.value)) {
                skipped.push(`${source.title} (værdien kan ikke sammenlignes sikkert)`);
                continue;
            }
            if (source.value === target.value) continue;
            toNew[id] = source.value;
            if (swapDevices) toOld[id] = target.value;
            log(`   🔹 ${source.title}: '${oldDevice.name}' ${source.value} → '${newDevice.name}' ${target.value}`);
        }

        if (swapDevices) {
            for (const [id, target] of newMap) {
                if (!oldMap.has(id)) skipped.push(`${target.title} (findes kun på '${newDevice.name}')`);
            }
        }

        if (skipped.length > 0) {
            log('   Springer over:');
            skipped.forEach(line => log(`   - ${line}`));
        }

        const newKeys = Object.keys(toNew);
        if (newKeys.length === 0) {
            log('Ingen afvigende indstillinger at kopiere.');
            return;
        }

        if (dryRun) {
            log(`ℹ️  (DryRun) Ville ${swapDevices ? 'bytte' : 'kopiere'} ${newKeys.length} avancerede indstillinger.`);
            return;
        }

        try {
            await Homey.devices.setDeviceSettings({ id: newDevice.id, settings: toNew });
            if (swapDevices) {
                await Homey.devices.setDeviceSettings({ id: oldDevice.id, settings: toOld });
            }
            log(`✅ ${swapDevices ? 'Byttede' : 'Kopierede'} ${newKeys.length} avancerede indstillinger.`);
        } catch (err) {
            log(`❌ Kunne ikke gemme avancerede indstillinger: ${err.message}`);
            if (String(err).includes('Missing Scopes') || String(err.message || '').includes('scope')) {
                log('   ℹ️  Skrivning kræver homey.device-scope.');
            }
        }
    }

    await copyCompatibleSettings();

    log(`Færdig! ${count} flows ${dryRun ? "ville blive" : "blev"} opdateret (i alt ${totalMatches} udskiftninger).`);
    if (skippedSaves > 0) {
        log(`${skippedSaves} flows ${dryRun ? "ville ikke blive gemt" : "blev ikke gemt"}, fordi typen er forskellig eller et kort bruger en capability den anden enhed mangler.`);
    }
    
    if (riskyFlows.length > 0) {
        log("\n⚠️  Følgende flows har kendte capability-referencer, som den anden enhed mangler:");
        log("    (Ikke en komplet liste — Homey kan gemme capabilities på flere måder.)");
        riskyFlows.forEach(f => log(`   - ${f}`));
    }

    if (dryRun) log("Dette var en test (dryRun). Sæt dryRun = false i scriptet for at gemme ændringerne.");
}

main().catch(console.error);