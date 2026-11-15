// ------------------------------------------------------------------
//  🌬️ SMART FUGT-STYRING: DEN INTELLIGENTE VENTILATOR-VAGT
// ------------------------------------------------------------------
//
//  HVORFOR DETTE SCRIPT?
//  Relativ luftfugtighed (%) fortæller kun, hvor "mæt" luften er — ikke hvor
//  meget vand der faktisk er i den. Kold luft kan binde langt mindre vand end
//  varm luft. Derfor kan 90% ude ved 2°C indeholde ~5 g vand pr. m³, mens
//  60% inde ved 22°C indeholder ~12 g/m³. Åbner du vinduet på en "fugtig"
//  vinterdag, kommer der ofte tørrere luft ind. Omvendt kan en varm, våd
//  sommeraften (høj % og høj temperatur) gøre udeluften vådere end badet.
//
//  Scriptet omregner derfor både bad, hus og (hvis muligt) udeklima til
//  absolut luftfugtighed (g/m³) og sammenligner vandmængden — ikke procenten.
//
//  HVORNÅR STARTER VENTILATION?
//  1. Badet indeholder mindst thresholdAH g/m³ mere vand end husets baseline
//     (lært gennemsnit af de øvrige rum — ikke kælder, vejrstation eller ude).
//  2. OG den relative fugt i badet er over sæson-gulvet (skimmel/komfort),
//     så der ikke ventileres i et i forvejen tørt rum.
//  3. Scriptet returnerer true KUN ved overgangen til høj fugt (én gang pr.
//     episode). Mens det stadig er fugtigt, returneres false. Først når fugten
//     er aftaget (med lidt hysterese), kan en ny episode give true.
//
//  "ÅBN VINDUET" sendes én gang pr. fugt-episode, første gang det både er
//  fugtigt og giver mening: ikke om natten, tagvinduet er lukket, og
//  udeluften er tørrere (eller vejret mangler). Falder alarmen om natten,
//  kommer pushen når stilletiden er slut, hvis badet stadig er fugtigt.
//  Er udeluften vådere, kan flowet stadig køre (return = true én gang),
//  men push venter til ude er tørrere — eller udebliver, hvis fugten
//  aftager først.
//
//  FUNKTIONER:
//  1. 💧 Absolut luftfugtighed (Magnus-Tetens) — retfærdig sammenligning på tværs
//     af temperaturer. Mangler en sensor °C, bruges fallbackTempC.
//  2. 🏠 Hus-baseline: alle friske fugtsensorer undtagen bad, zone, excludedSensors.
//  3. 🧠 Læring: EMA i HomeyScript global (ikke Logic/Insights). Ét get/set
//     pr. kørsel. Store hop ignoreres. Åbne husvinduer: frys hvis ude er tørrere
//     eller vådere end den lærte hus-normal, eller hvis ude svinger undervejs.
//     Sammenlignes med baseline (ikke det aktuelle hus-snit), så lange åbne
//     perioder ikke lærer ude-klimaet når hus og ude er blevet ens. Mangler
//     frisk vejr, fortsætter læringen — medmindre huset samtidig er tørrere
//     end den lærte normal (så ligner det udluftning). Badeværelsesvindue
//     fryser ikke hus-EMA.
//     maxDropPerHour. Nøgle: baseline_abs_humidity.
//  4. 🌤️ Sæson-gulv: højere min-% om sommeren, lavere om vinteren.
//  5. 🌤️ Udeklima: Weather-sensor bruges til vinduesråd, ikke til hus-snit.
//  6. ⏳ Friskhed: forældede målinger (maxAgeHours) tæller ikke med.
//  7. 🌙 Stilletid: ingen push mellem silentStart og silentEnd.
//  8. 📱 Homey-tags til flows — opdateres kun når værdien faktisk ændrer sig.
//  9. 🆘 Fejlkoder (BF-xxx) på Homeys tidslinje + tagget Bad_Fugt_Fejl.
//     Slå koden op i afsnittet FEJLKODER i dette script.
//
//  TAGS (bevar RH-tags i eksisterende flows):
//  Bad_Fugt_Trigger      true kun ved ny fugt-episode (én-gangs-puls til flow)
//  Bad_Fugt_Diff         RH-forskel i %-point (bagudkompatibel)
//  Bad_Fugt_Absolut      RH i badet (%)
//  Bad_Fugt_AH           vand i badet (g/m³)     ← brug denne til ny logik
//  Bad_Fugt_AH_Ref       hus-baseline (g/m³)
//  Bad_Fugt_AH_Diff      forskel bad − hus (g/m³)
//  Bad_Fugt_Ude_AH       vand ude (g/m³), tom hvis ingen ude-sensor
//  Bad_Fugt_Ude_Tørre    true hvis det kan betale sig at åbne vinduet
//  Bad_Fugt_Ude_Status   "(8.1 vs bad 12.4 g/m³)" — tom hvis ingen ude-data
//  Bad_Fugt_Besked       push-tekst (tom = send ikke)
//  Bad_Fugt_Send_Push    true når der er en besked
//  Bad_Fugt_Fejl         én linje pr. fejl denne kørsel (tom = OK)
//
// ------------------------------------------------------------------
//  FEJLKODER — slå koden fra tidslinjen op her
//
//  Tidslinjen viser kun koden og én kort sætning. Herunder står hvad
//  koden betyder, hvorfor den kommer, hvad scriptet gør, og hvad du
//  kan tjekke. Søg efter koden (f.eks. BF-202).
// ------------------------------------------------------------------
//
//  === STOPPER SCRIPTET (returnerer false, ingen alarm) ===
//
//  BF-101  Finder ikke badeværelsessensoren
//          Scriptet kigger efter enheden i CONFIG.targetSensor. Navnet
//          skal være identisk med Homey (mellemrum, bindestreg, store
//          bogstaver). Uden den sensor kan fugt i badet ikke måles.
//          Tjek: Enheder → kopier navnet ind i targetSensor.
//
//  BF-102  Badeværelsessensoren måler ikke luftfugtighed
//          Enheden blev fundet, men har ikke measure_humidity. En ren
//          radiator uden fugt-sensor duer ikke. Vælg termostaten eller
//          en anden enhed i badet der viser relativ fugt (%).
//
//  BF-103  Fugten i badet er ikke opdateret
//          Sidste fugtmåling er ældre end CONFIG.maxAgeHours (standard
//          2 timer). Scriptet stoler ikke på tallet — batteri, z-wave/
//          zigbee eller appen kan være gået i stå. Tjek enheden i Homey
//          og at "sidst opdateret" er nylig.
//
//  BF-104  Ingen andre fugtsensorer i huset
//          Hus-normalen er et snit af alle friske fugtsensorer undtagen
//          bad, kælder og vejr. Filteret efterlod 0 enheder (forkert
//          excludedSensors, eller kun badet har fugt). Tilføj/ret
//          sensorer, eller fjern navne fra excludedSensors.
//
//  BF-105  Homey svarede ikke med enheder
//          getDevices/getZones fejlede (Homey optaget, app-fejl eller
//          midlertidigt API-problem). Ingen måling denne kørsel. Prøv
//          igen. Gentager det sig: genstart Homey.
//
//  BF-108  Alle husets fugtsensorer er for gamle
//          Der findes referencesensorer, men ingen har rapporteret inden
//          for maxAgeHours. Samme som BF-103, bare for de øvrige rum.
//          Tjek batterier og at stuen/soveværelse osv. stadig opdaterer.
//
//  BF-199  Uventet fejl
//          Noget scriptet ikke har en særlig kode for (syntaks, Homey-
//          ændring, sjælden API-fejl). Åbn HomeyScript-loggen for den
//          kørsel — den fulde fejltekst står der.
//
//  === ADVARSLER (scriptet kører videre) ===
//
//  BF-201  Vejrstationen blev ikke fundet
//          Ingen enhed matcher CONFIG.outdoorPatterns (typisk "Weather").
//          Uden ude-g/m³ kan scriptet ikke se om det kan betale sig at
//          åbne vinduet. Ved høj fugt anbefales vindue alligevel.
//          Hus-læring fortsætter, medmindre huset samtidig er blevet
//          tørrere end den lærte normal.
//          Tjek: hedder vejrstationen noget med Weather?
//
//  BF-202  Vejrdata er for gammelt
//          Hverken ude-fugt eller ude-temperatur er opdateret inden for
//          outdoorMaxAgeHours. (RH alene tæller ikke: den står ofte stille
//          i timevis ved tåge/regn, mens °C stadig opdateres.)
//          Samme følge som BF-201 indtil stationen rapporterer igen.
//          Tjek vejr-appen, internet og at integrationen kører.
//
//  BF-218  Et HomeyScript-tag kunne ikke opdateres
//          Typisk fordi tagget skifter type (tal ↔ tekst). Scriptet
//          fortsætter; den pågældende værdi kan være et kørsel bagud.
//
//  BF-203  resetLearning er stadig slået til
//          CONFIG.resetLearning skal kun være true i én kørsel for at
//          nulstille den lærte hus-normal. Står den ved true, overskrives
//          normalen med den aktuelle måling ved hver kørsel, så scriptet
//          ikke husker niveauet over tid. Sæt resetLearning: false bagefter.
//
//  BF-204  Den lærte hus-normal kunne ikke læses
//          Værdien i HomeyScript global["bad_fugt_ema"] er ødelagt eller
//          ikke gyldig JSON (app-opdatering, manuel redigering). Scriptet
//          starter baseline forfra, så alarm-tærsklen kan hoppe den
//          første tid. Sæt resetLearning true ét kørsel, derefter false.
//
//  BF-205  Kunne ikke skrive på Homeys tidslinje
//          Flow-kortet create_notification virkede ikke (Homey-version
//          eller rettigheder). Koden kan ikke stå på tidslinjen, for det
//          er den, der fejler. Den sættes i stedet på tagget Bad_Fugt_Fejl
//          og i HomeyScript-loggen.
//
//  BF-206  Badet mangler temperatur
//          Fugtsensoren har % men ingen °C. Absolut luftfugtighed (g/m³)
//          kræver begge dele, så scriptet bruger CONFIG.fallbackTempC
//          (standard 21°C). Er rummet koldere/varmere, kan alarmen ramme
//          lidt skævt. Brug en enhed med både temperatur og fugt.
//
//  BF-207  Zonen til badeværelset blev ikke fundet
//          CONFIG.bathroomName skal matche zonens navn i Homey (f.eks.
//          "Badeværelse"). Uden zone kan andre fugtsensorer i samme rum
//          komme med i hus-snittet, så badet sammenlignes med sig selv.
//          Ret bathroomName, eller omdøb zonen.
//
//  BF-211  Tagvinduet i badet blev ikke fundet
//          CONFIG.windowSensor matcher ingen enhed. Scriptet kan ikke se
//          om tagvinduet er åbent, så du kan få "åbn vinduet"-push selv
//          om det allerede står åbent. Ret navnet, eller sæt windowSensor
//          til "" hvis du ikke vil bruge den funktion.
//
//  BF-212  Badet sendte ingen gyldig fugtprocent
//          measure_humidity var tom eller ikke et tal (enheden i tvivl,
//          app-glitch). Ingen pålidelig måling denne kørsel. Tjek
//          enheden i Homey og vent på næste rapport.
//
//  BF-213  Kan ikke omregne badets luft til g/m³
//          Fugtmålingen er ugyldig, så Magnus-Tetens ikke kan regnes.
//          Mangler badet kun temperatur, bruges fallback og koden er
//          BF-206 i stedet. Uden g/m³ kan scriptet ikke sammenligne
//          badet med hus og ude. Tjek at sensoren rapporterer en %.
//
//  BF-214  Husets sensorer mangler temperatur
//          Referencesensorerne har fugt men ingen gyldig °C, så husets
//          g/m³ beregnes med fallbackTempC. Hus-normalen bliver et skøn.
//          Brug termostater/sensorer med temperatur, eller ret
//          fallbackTempC så den matcher husets typiske rumtemperatur.
//
//  BF-217  Tagvinduet kan ikke fortælle om det er åbent
//          Enheden findes, men har ikke alarm_contact (det er f.eks. en
//          pære eller termostat, ikke en kontakt-sensor). Push om at
//          åbne vinduet kan komme selv om det er åbent. Vælg den rigtige
//          dør/vindues-sensor i windowSensor.
//
// ------------------------------------------------------------------
//
// ------------------------------------------------------------------

// KONFIGURATION
const CONFIG = {
    targetSensor: "Badeværelse - Smart Radiator Thermostat",
    windowSensor: "Tagvindue Badeværelse", // (Valgfri) Navn på vinduessensor. Hvis åben, sendes ingen besked.
    bathroomName: "Badeværelse", // Navn der bruges til at ekskludere andre sensorer i samme rum
    // Sensor-navne (eller dele af navne) der IKKE skal tælle med i husets gennemsnit.
    excludedSensors: ["Weather", "Vaskekælder"], // Vejrstation og kælder tæller ikke med i husets snit
    outdoorPatterns: ["Weather"], // Finder ude-klima til vinduesråd (ingen "Udendørs"-enhed)
    useAbsoluteHumidity: true, // true = sammenlign g/m³ (anbefalet). false = gammel %-sammenligning
    thresholdAH: 2.0, // Hvor mange g/m³ højere skal badet være før trigger? (~2 g/m³ ≈ 10%-point ved 22°C)
    threshold: 10, // Fallback: hvor mange %-point højere skal badet være (kun hvis useAbsoluteHumidity = false)
    fallbackTempC: 21, // Bruges hvis en fugtsensor mangler temperatur
    createMsgTag: true, // Skal vi lave en tekst til push-beskeder? (Sæt false hvis du har ventilator)
    learningMode: true,  // Sæt til true for at huske og lære husets "normale" niveau over tid
    learningSpeed: 0.05, // Hvor hurtigt lærer den per time? (0.05 = langsomt/stabilt, 0.5 = hurtigt)
    resetLearning: false, // Sæt til true ÉN gang for at nulstille historikken
    freezeLearningOnOpenWindow: false, // true = frys også hus-EMA ved åbent badeværelsesvindue (normalt unødvendigt)
    freezeLearningOnAnyOpenWindow: true, // Frys hus-EMA ved åbne husvinduer hvis ude afviger fra hus-normal eller svinger
    freezeIfOutdoorDrierMargin: 0.5, // g/m³ under baseline: tør ude fryser læring
    openWindowLearnBandAH: 1.5, // g/m³ over baseline: vådere ude fryser (storm / sving opad)
    openWindowOutdoorSwingAH: 0.8, // g/m³ hop i ude siden sidste kørsel → frys mens vinduer er åbne
    windowPatterns: ["Vindue", "Window", "Tagvindue"], // Bruges til at finde åbne vinduer i huset
    learningResumeDelayHours: 1, // Bliv ved med at fryse så længe efter lukning (luften er stadig tør)
    maxDropPerHourAH: 0.4, // Baseline må højst falde så mange g/m³ pr. time (falske dyk)
    maxDropPerHour: 2, // Fallback: max fald i %-point pr. time
    maxJumpAH: 3.0, // Maksimalt spring i g/m³, før læringen pauser (outliers)
    maxJump: 15, // Fallback: maksimalt spring i %-point (kun hvis useAbsoluteHumidity = false)
    minHumidityWinter: 50, // Minimum RH % i badet fra Oktober til Marts (gulv uanset AH)
    minHumiditySummer: 65, // Minimum RH % i badet fra April til September
    alarmOnceUntilClear: true, // true = returnér kun true én gang pr. fugt-episode
    clearMarginAH: 0.5, // g/m³ under thresholdAH, før episoden er "aftaget"
    clearMarginRH: 3, // %-point under threshold, før episoden er aftaget (RH-mode)
    clearMarginMinHum: 5, // %-point under sæson-gulv, før episoden er aftaget
    maxAgeHours: 2, // Hvor mange timer gammelt må hus/bad-data maksimalt være?
    outdoorMaxAgeHours: 4, // Vejr: RH opdateres ofte ikke når den står stille — tjek også °C
    silentStart: 23, // Ingen beskeder fra dette klokkeslæt...
    silentEnd: 7,    // ... til dette klokkeslæt (bruges til at spærre push om natten)
    testMode: false, // Sæt til true for at tvinge en besked igennem (til test)
    debug: false,   // Sæt til false for at slippe for logs
    timelineFaultHours: 3 // Min. timer mellem samme fejlkode på Homeys tidslinje
};

// ------------------------------------------------------------------

function log(msg) { console.log(msg); }
const clamp = (num, min, max) => Math.min(Math.max(num, min), max);

const EMA_CACHE_KEY = "bad_fugt_ema";
const EMA_BASELINE_KEY = "baseline_abs_humidity";
const ALARM_LATCH_KEY = "bad_fugt_alarm_latched";
const PUSH_SENT_KEY = "bad_fugt_push_sent";

// Kort tekst til tidslinje/tag. Fuld forklaring står i FEJLKODER øverst i scriptet.
const ERROR_CODES = {
    "BF-101": { short: "Finder ikke badeværelsessensoren", throttleHours: 1 },
    "BF-102": { short: "Badeværelsessensoren måler ikke luftfugtighed", throttleHours: 1 },
    "BF-103": { short: "Fugten i badet er ikke opdateret", throttleHours: 1 },
    "BF-104": { short: "Ingen andre fugtsensorer i huset", throttleHours: 1 },
    "BF-105": { short: "Homey svarede ikke med enheder", throttleHours: 1 },
    "BF-108": { short: "Husets fugtsensorer er for gamle", throttleHours: 1 },
    "BF-199": { short: "Uventet fejl i fugt-scriptet", throttleHours: 1 },
    "BF-201": { short: "Vejrstationen blev ikke fundet", throttleHours: 3 },
    "BF-202": { short: "Vejrdata er for gammelt", throttleHours: 3 },
    "BF-203": { short: "resetLearning er stadig slået til", throttleHours: 6 },
    "BF-204": { short: "Den lærte hus-normal kunne ikke læses", throttleHours: 6 },
    "BF-205": { short: "Kunne ikke skrive på Homeys tidslinje", throttleHours: 6 },
    "BF-206": { short: "Badet mangler temperatur", throttleHours: 12 },
    "BF-207": { short: "Zonen til badeværelset blev ikke fundet", throttleHours: 12 },
    "BF-211": { short: "Tagvinduet i badet blev ikke fundet", throttleHours: 6 },
    "BF-212": { short: "Badet sendte ingen gyldig fugtprocent", throttleHours: 1 },
    "BF-213": { short: "Kan ikke omregne badets luft til g/m³", throttleHours: 1 },
    "BF-214": { short: "Husets sensorer mangler temperatur", throttleHours: 12 },
    "BF-217": { short: "Tagvinduet kan ikke fortælle om det er åbent", throttleHours: 12 },
    "BF-218": { short: "Et HomeyScript-tag kunne ikke opdateres", throttleHours: 6 }
};

let emaParseFailed = false;
let faultTagThisRun = "";
const faultsThisRun = [];

function codedError(code, detail) {
    const spec = ERROR_CODES[code] || ERROR_CODES["BF-199"];
    const err = new Error(detail ? `${code}: ${spec.short} (${detail})` : `${code}: ${spec.short}`);
    err.faultCode = code;
    return err;
}

function classifyFault(message) {
    const msg = String(message || "");
    if (/BF-\d{3}/.test(msg)) return msg.match(/BF-\d{3}/)[0];
    if (msg.includes("Kunne ikke finde enheden")) return "BF-101";
    if (msg.includes("understøtter ikke fugtmåling")) return "BF-102";
    if (msg.includes("for gammelt") && msg.includes("Tjek sensor")) return "BF-103";
    if (msg.includes("Ingen gyldige referencesensorer")) return "BF-104";
    if (/tag|token|type/i.test(msg)) return "BF-218";
    return "BF-199";
}

function loadEmaCache() {
    const raw = (typeof global !== "undefined" && global.get) ? global.get(EMA_CACHE_KEY) : null;
    if (!raw) return {};
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === "object") ? parsed : {};
        } catch (e) {
            emaParseFailed = true;
            return {};
        }
    }
    return (typeof raw === "object") ? { ...raw } : {};
}

function saveEmaCache(cache) {
    if (typeof global === "undefined" || !global.set) return;
    global.set(EMA_CACHE_KEY, cache);
    if (cache[EMA_BASELINE_KEY] != null) {
        global.set(EMA_BASELINE_KEY, cache[EMA_BASELINE_KEY]);
    }
}

async function updateTag(name, newValue) {
    if (newValue === "" || newValue === null || newValue === undefined) {
        const prev = (typeof global !== "undefined" && global.get) ? global.get(`tag_cache_${name}`) : undefined;
        if (typeof prev === "number" || typeof prev === "boolean") return;
    }
    const cacheKey = `tag_cache_${name}`;
    const currentValue = (typeof global !== "undefined" && global.get) ? global.get(cacheKey) : undefined;
    if (currentValue === newValue) return;
    try {
        await tag(name, newValue);
        if (typeof global !== "undefined" && global.set) global.set(cacheKey, newValue);
    } catch (e) {
        noteFault("BF-218", `${name}: ${e && e.message ? e.message : e}`);
    }
}

async function postTimeline(text) {
    const attempts = [
        { uri: "homey:manager:notifications", id: "homey:manager:notifications:create_notification" },
        { uri: "homey:flowcardaction:homey:manager:notifications:create_notification", id: "homey:manager:notifications:create_notification" },
        { uri: "homey:manager:notifications", id: "create_notification" }
    ];
    for (const spec of attempts) {
        try {
            await Homey.flow.runFlowCardAction({
                uri: spec.uri,
                id: spec.id,
                args: { text }
            });
            return true;
        } catch (e) { /* prøv næste variant */ }
    }
    log("   ⚠️ Kunne ikke skrive på Homeys tidslinje (create_notification).");
    return false;
}

function noteFault(code, extra) {
    const spec = ERROR_CODES[code] || ERROR_CODES["BF-199"];
    const usedCode = ERROR_CODES[code] ? code : "BF-199";
    if (faultsThisRun.some(f => f.code === usedCode)) return;
    const extraClean = extra ? String(extra).replace(/^["'\s]+|["'\s]+$/g, "").trim() : "";
    const line = extraClean
        ? `${usedCode}: ${spec.short} (${extraClean})`
        : `${usedCode}: ${spec.short}`;
    const throttleHours = Number.isFinite(Number(spec.throttleHours))
        ? Number(spec.throttleHours)
        : (Number(CONFIG.timelineFaultHours) || 3);
    faultsThisRun.push({ code: usedCode, line, throttleHours });
    log(`   ⚠️ ${line}`);
}

async function flushFaults() {
    faultTagThisRun = faultsThisRun.map(f => f.line).join("\n");
    try {
        await updateTag("Bad_Fugt_Fejl", faultTagThisRun);
    } catch (e) { /* tag er sekundært */ }
    if (!faultsThisRun.length) return false;

    const now = Date.now();
    const due = faultsThisRun.filter(f => {
        const throttleMs = Math.max(0, Number(f.throttleHours) || 0) * 3600000;
        const lastAt = Number((typeof global !== "undefined" && global.get) ? global.get(`bad_fugt_fault_${f.code}`) : 0) || 0;
        return !throttleMs || now - lastAt >= throttleMs;
    });
    if (!due.length) return false;

    const text = due.length === 1
        ? `⚠️ ${due[0].line}`
        : `⚠️ ${due.map(f => f.line).join(" · ")}`;
    const posted = await postTimeline(text);
    if (posted) {
        if (typeof global !== "undefined" && global.set) {
            due.forEach(f => global.set(`bad_fugt_fault_${f.code}`, now));
        }
        return true;
    }
    log("   ⚠️ BF-205: Kunne ikke skrive på Homeys tidslinje.");
    const timelineLine = `BF-205: ${ERROR_CODES["BF-205"].short}`;
    faultTagThisRun = faultTagThisRun ? `${faultTagThisRun}\n${timelineLine}` : timelineLine;
    try {
        await updateTag("Bad_Fugt_Fejl", faultTagThisRun);
    } catch (e) { /* tag er sekundært */ }
    return false;
}

// Absolut luftfugtighed (g/m³) via Magnus-Tetens.
// Kold luft kan binde mindre vand: 90% RH ved 2°C ≈ 5 g/m³, 60% RH ved 22°C ≈ 12 g/m³.
function absoluteHumidity(tempC, rhPercent) {
    const T = Number(tempC);
    const RH = Number(rhPercent);
    if (!Number.isFinite(T) || !Number.isFinite(RH)) return null;
    const es = 6.112 * Math.exp((17.67 * T) / (T + 243.5)); // hPa
    const e = es * (RH / 100);
    return (216.7 * e) / (T + 273.15);
}

const getTempC = (device) => {
    const cap = device.capabilitiesObj && device.capabilitiesObj.measure_temperature;
    if (!cap || cap.value === null || cap.value === undefined) return null;
    const t = Number(cap.value);
    return Number.isFinite(t) ? t : null;
};

const getRH = (device) => {
    const cap = device.capabilitiesObj && device.capabilitiesObj.measure_humidity;
    if (!cap || cap.value === null || cap.value === undefined) return null;
    const rh = Number(cap.value);
    return Number.isFinite(rh) ? rh : null;
};

const round1 = (v) => Math.round(Number(v) * 10) / 10;
const fmtAH = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "?" : round1(v).toFixed(1);

const readingFromDevice = (device) => {
    const rh = getRH(device);
    const measuredTemp = getTempC(device);
    const usedFallbackTemp = measuredTemp === null;
    const tempC = usedFallbackTemp ? CONFIG.fallbackTempC : measuredTemp;
    const ah = absoluteHumidity(tempC, rh);
    return { rh, tempC, measuredTemp, usedFallbackTemp, ah };
};

// 1. Hent enheder
log("🔍 Scanner Homey for enheder...");
let devices;
let zones;
try {
    [devices, zones] = await Promise.all([
        Homey.devices.getDevices(),
        Homey.zones.getZones()
    ]);
} catch (e) {
    noteFault("BF-105", e.message);
    await flushFaults();
    await Promise.all([
        updateTag("Bad_Fugt_Trigger", false),
        updateTag("Bad_Fugt_Send_Push", false),
        updateTag("Bad_Fugt_Besked", "")
    ]);
    return false;
}

// Helper: Find enhed og valider evner
const getSensor = (name) => {
    const device = Object.values(devices).find(d => d.name === name);
    if (!device) throw codedError("BF-101", `"${name}"`);
    if (!device.capabilitiesObj || !device.capabilitiesObj.measure_humidity) {
        throw codedError("BF-102", `"${name}"`);
    }
    return device;
};

try {
    // 2. Find og valider sensorer
    const bathDevice = getSensor(CONFIG.targetSensor);

    // Find Zone ID for at kunne ekskludere alt i samme rum
    const bathZone = Object.values(zones).find(z => z.name === CONFIG.bathroomName);
    const bathZoneId = bathZone ? bathZone.id : null;
    if (CONFIG.bathroomName && !bathZone) {
        noteFault("BF-207", `"${CONFIG.bathroomName}"`);
    }

    // 2b. Tjek vindues-sensorer (bad + øvrige i huset)
    let isWindowOpen = false;
    const openWindows = [];
    const isContactOpen = (device) => !!(device.capabilitiesObj?.alarm_contact?.value);
    const looksLikeWindow = (device) =>
        CONFIG.windowPatterns.some(pattern => device.name.includes(pattern));

    if (CONFIG.windowSensor) {
        const winDev = Object.values(devices).find(d => d.name === CONFIG.windowSensor);
        if (!winDev) {
            noteFault("BF-211", `"${CONFIG.windowSensor}"`);
        } else if (!winDev.capabilitiesObj || winDev.capabilitiesObj.alarm_contact === undefined) {
            noteFault("BF-217", `"${CONFIG.windowSensor}"`);
        } else if (isContactOpen(winDev)) {
            isWindowOpen = true;
            openWindows.push(winDev.name);
        }
    }
    if (CONFIG.freezeLearningOnAnyOpenWindow) {
        Object.values(devices).forEach(d => {
            if (CONFIG.windowSensor && d.name === CONFIG.windowSensor) return;
            if (looksLikeWindow(d) && isContactOpen(d) && !openWindows.includes(d.name)) {
                openWindows.push(d.name);
            }
        });
    }
    if (openWindows.length) {
        log(`   🪟 Åbne vinduer: ${openWindows.join(", ")}`);
    } else if (CONFIG.windowSensor) {
        log(`   🪟 Vindue status: LUKKET (${CONFIG.windowSensor})`);
    }

    // Hjælper: Tjek om data er opdateret for nylig
    const newestCapMs = (device, capIds) => {
        let newest = NaN;
        (capIds || ["measure_humidity"]).forEach((id) => {
            const t = Date.parse(device.capabilitiesObj?.[id]?.lastUpdated);
            if (!isNaN(t) && (isNaN(newest) || t > newest)) newest = t;
        });
        return newest;
    };

    const isFresh = (device, name, throwIfStale = false, staleHint = "Udelades fra gennemsnit", capIds, maxAgeHours) => {
        const lastUpdatedMs = newestCapMs(device, capIds);
        const maxAge = Number.isFinite(Number(maxAgeHours)) ? Number(maxAgeHours) : CONFIG.maxAgeHours;
        const ageHours = (Date.now() - lastUpdatedMs) / 3600000;

        if (isNaN(ageHours) || ageHours > maxAge) {
             const msg = `⏳ Data fra "${name}" er for gammelt (${isNaN(ageHours) ? '?' : ageHours.toFixed(1)} timer).`;
             if (throwIfStale) throw codedError("BF-103", `"${name}", ${isNaN(ageHours) ? "?" : ageHours.toFixed(1)} t`);
             log("   ⚠️  " + msg + (staleHint ? ` (${staleHint})` : ""));
             return false;
        }
        return true;
    };
    
    // 3. Find alle andre sensorer og beregn gennemsnit
    const others = Object.values(devices).filter(d => 
        d.name !== CONFIG.targetSensor &&
        !d.name.includes(CONFIG.bathroomName) &&
        (bathZoneId ? d.zone !== bathZoneId : true) &&
        // Tjek om enhedens navn indeholder en af de ekskluderede strenge
        !CONFIG.excludedSensors.some(pattern => d.name.includes(pattern)) &&
        d.capabilitiesObj && d.capabilitiesObj.measure_humidity
    );

    // Filtrer gamle data fra og beregn snit
    const validOthers = others.filter(d => isFresh(d, d.name, false));
    const otherReadings = validOthers.map(d => ({ device: d, ...readingFromDevice(d) }));
    
    if (CONFIG.debug) {
        log("📋 DEBUG - SENSOR OVERBLIK:");
        log(`   🎯 Målesensor (Target): ${CONFIG.targetSensor}`);
        log(`   ✅ Indgår i gennemsnit (${validOthers.length} stk):`);
        otherReadings.forEach(r => {
            const tempNote = r.usedFallbackTemp ? `temp fallback ${r.tempC}°C` : `${r.tempC}°C`;
            log(`      - ${r.device.name} (${r.rh}% / ${fmtAH(r.ah)} g/m³ @ ${tempNote})`);
        });

        const allHum = Object.values(devices).filter(d => d.capabilitiesObj && d.capabilitiesObj.measure_humidity);
        const excluded = allHum.filter(d => d.name !== CONFIG.targetSensor && !validOthers.includes(d));
        
        if (excluded.length > 0) {
            log(`   🚫 Ekskluderede sensorer:`);
            excluded.forEach(d => {
                let r = [];
                if (d.name.includes(CONFIG.bathroomName)) r.push(`Navn`);
                if (bathZoneId && d.zone === bathZoneId) r.push(`Zone`);
                if (CONFIG.excludedSensors.some(pattern => d.name.includes(pattern))) r.push("Manuelt");
                
                log(`      - ${d.name} (${r.length > 0 ? r.join(" + ") : "Data for gammelt"})`);
            });
        }
        log("---------------------------------------------------");
    }

    let avgRefHum;
    let avgRefAH;
    let isReferenceFaked = false;
    if (validOthers.length === 0) {
        // Hvis vi tester manuelt (args), så tillad at køre videre uden referencer (brug 50% som fake)
        if ((args && args[0]) || CONFIG.testMode) {
            log("⚠️ SIMULERING: Ingen reference-sensorer fundet, men fortsætter med '50%' som fake reference.");
            avgRefHum = 50;
            avgRefAH = absoluteHumidity(CONFIG.fallbackTempC, 50);
            isReferenceFaked = true;
        } else if (others.length === 0) {
            throw codedError("BF-104");
        } else {
            throw codedError("BF-108", `${others.length} sensor(er) for gamle`);
        }
    } else {
        avgRefHum = otherReadings.reduce((sum, r) => sum + r.rh, 0) / otherReadings.length;
        const ahValues = otherReadings.map(r => r.ah).filter(v => v !== null);
        if (!ahValues.length) {
            avgRefAH = absoluteHumidity(CONFIG.fallbackTempC, avgRefHum);
            noteFault("BF-214");
        } else {
            avgRefAH = ahValues.reduce((sum, v) => sum + v, 0) / ahValues.length;
        }
    }

    // Sikring: Sørg for at gennemsnittet er inden for et fornuftigt interval
    avgRefHum = clamp(avgRefHum, 0, 100);
    avgRefAH = clamp(avgRefAH, 0, 40);

    const useAH = CONFIG.useAbsoluteHumidity;
    let referenceType = `råt gennemsnit fra ${validOthers.length} sensorer`;

    // Udeklima tidligt: bruges både til hus-læring (frys) og til vinduesråd senere
    let outdoorAH = null;
    let outdoorInfo = null;
    let outdoorIssue = null; // "mangler" | "forældet"
    const outdoorCandidates = Object.values(devices).filter(d =>
        d.capabilitiesObj && d.capabilitiesObj.measure_humidity &&
        CONFIG.outdoorPatterns.some(pattern => d.name.includes(pattern))
    );
    const outdoorMaxAge = Number.isFinite(Number(CONFIG.outdoorMaxAgeHours))
        ? Number(CONFIG.outdoorMaxAgeHours)
        : Math.max(CONFIG.maxAgeHours, 4);
    const outdoorDev = outdoorCandidates.find(d => isFresh(
        d,
        d.name,
        false,
        "Udelades som ude-klima",
        ["measure_humidity", "measure_temperature"],
        outdoorMaxAge
    ));
    if (outdoorDev) {
        outdoorInfo = { device: outdoorDev, ...readingFromDevice(outdoorDev) };
        outdoorAH = outdoorInfo.ah;
        log(`   🌤️ Ude: ${outdoorInfo.rh}% @ ${outdoorInfo.tempC}°C = ${fmtAH(outdoorAH)} g/m³ (${outdoorDev.name})`);
    } else if (outdoorCandidates.length) {
        outdoorIssue = "forældet";
    } else {
        outdoorIssue = "mangler";
    }

    // Bestem sæson tidligt, så den kan bruges i lærings-modulet
    const month = new Date().getMonth() + 1;
    const isWinter = month >= 10 || month <= 3;

    // ------------------------------------------------------------------
    // 🧠 LEARNING MODE: EMA i HomeyScript global (ingen Logic/Insights-opslag)
    // Ny_EMA = (måling * α) + (gammel_EMA * (1-α)), α = 1-(1-learningSpeed)^dt
    // ------------------------------------------------------------------
    const isSimulated = !!(args && args[0]);

    if (CONFIG.learningMode && !isSimulated && !isReferenceFaked) {        
        const season = isWinter ? "Vinter" : "Sommer";
        const now = Date.now();
        const emaCache = loadEmaCache();
        if (emaParseFailed) noteFault("BF-204");
        const seasonState = (emaCache[season] && typeof emaCache[season] === "object")
            ? { ...emaCache[season] }
            : {};

        let learnedMetric = useAH ? avgRefAH : avgRefHum;
        const maxJump = useAH ? CONFIG.maxJumpAH : CONFIG.maxJump;
        const maxDropPerHour = useAH ? CONFIG.maxDropPerHourAH : CONFIG.maxDropPerHour;
        const clampMax = useAH ? 40 : 100;
        const unit = useAH ? "g/m³" : "%";
        const existingBaseline = Number(seasonState.baseline);
        const hasExistingBaseline = Number.isFinite(existingBaseline);

        const houseWindows = openWindows.filter(n => n !== CONFIG.windowSensor);
        const houseWindowsOpen = CONFIG.freezeLearningOnAnyOpenWindow && houseWindows.length > 0;
        const bathWindowBlocks = CONFIG.freezeLearningOnOpenWindow && isWindowOpen;
        const hasOutdoorForLearn = outdoorAH !== null && Number.isFinite(Number(outdoorAH));
        const houseAHNow = Number(avgRefAH);
        const baselineAH = hasExistingBaseline ? existingBaseline : houseAHNow;
        const drierMargin = Number.isFinite(Number(CONFIG.freezeIfOutdoorDrierMargin))
            ? Number(CONFIG.freezeIfOutdoorDrierMargin) : 0.5;
        const wetterBand = Number.isFinite(Number(CONFIG.openWindowLearnBandAH))
            ? Number(CONFIG.openWindowLearnBandAH) : 1.5;
        const swingMargin = Number.isFinite(Number(CONFIG.openWindowOutdoorSwingAH))
            ? Number(CONFIG.openWindowOutdoorSwingAH) : 0.8;
        const lastOutdoorAH = Number(emaCache.lastOutdoorAH);
        const outdoorSwung = hasOutdoorForLearn && Number.isFinite(lastOutdoorAH)
            && Math.abs(outdoorAH - lastOutdoorAH) > swingMargin;
        const outdoorDrierThanBaseline = hasOutdoorForLearn && Number.isFinite(baselineAH)
            && outdoorAH < baselineAH - drierMargin;
        const outdoorWetterThanBaseline = hasOutdoorForLearn && Number.isFinite(baselineAH)
            && outdoorAH > baselineAH + wetterBand;

        let freezeReason = null;
        if (bathWindowBlocks) {
            freezeReason = `åbent badeværelsesvindue (${CONFIG.windowSensor})`;
        } else if (houseWindowsOpen && !hasOutdoorForLearn) {
            const weatherWhy = outdoorIssue === "forældet" ? "vejrdata er for gammelt" : "vejrstationen mangler";
            const houseNow = useAH ? houseAHNow : Number(avgRefHum);
            const dropMargin = useAH ? drierMargin : 2;
            const houseDropped = hasExistingBaseline && Number.isFinite(houseNow)
                && houseNow < existingBaseline - dropMargin;
            if (!hasExistingBaseline) {
                freezeReason = `åbne husvinduer uden frisk vejr (ingen baseline endnu): ${houseWindows.join(", ")}`;
            } else if (houseDropped) {
                freezeReason = `åbne husvinduer, ${weatherWhy}, og huset er tørrere end normalen (${fmtAH(houseNow)} vs baseline ${fmtAH(existingBaseline)} ${unit}): ${houseWindows.join(", ")}`;
            } else {
                log(`   🧠 Læring fortsætter: husvinduer åbne, men ${weatherWhy}. Hus (${fmtAH(houseNow)} ${unit}) er ikke under normalen (${fmtAH(existingBaseline)} ${unit}).`);
                emaCache.freezeUntil = 0;
            }
        } else if (houseWindowsOpen && outdoorSwung) {
            freezeReason = `åbne husvinduer og ude svinger (${fmtAH(lastOutdoorAH)} → ${fmtAH(outdoorAH)} g/m³): ${houseWindows.join(", ")}`;
        } else if (houseWindowsOpen && outdoorDrierThanBaseline) {
            freezeReason = `åbne husvinduer og tørrere ude end hus-normal (${fmtAH(outdoorAH)} vs baseline ${fmtAH(baselineAH)} g/m³): ${houseWindows.join(", ")}`;
        } else if (houseWindowsOpen && outdoorWetterThanBaseline) {
            freezeReason = `åbne husvinduer og vådere ude end hus-normal (${fmtAH(outdoorAH)} vs baseline ${fmtAH(baselineAH)} g/m³): ${houseWindows.join(", ")}`;
        } else if (houseWindowsOpen) {
            log(`   🧠 Læring fortsætter: husvinduer åbne, ude (${fmtAH(outdoorAH)} g/m³) ligger tæt på hus-normal (${fmtAH(baselineAH)} g/m³).`);
            emaCache.freezeUntil = 0;
        }

        if (hasOutdoorForLearn) emaCache.lastOutdoorAH = outdoorAH;

        const delayMs = (CONFIG.learningResumeDelayHours || 0) * 3600000;
        if (freezeReason && delayMs > 0) {
            emaCache.freezeUntil = now + delayMs;
        }
        const freezeUntil = Number(emaCache.freezeUntil) || 0;
        if (!freezeReason && freezeUntil > now) {
            const leftMin = Math.ceil((freezeUntil - now) / 60000);
            freezeReason = `nedkøling efter udluftning (~${leftMin} min tilbage)`;
        }

        if (CONFIG.resetLearning) {
            const warningMsg = "ADVARSEL: 'resetLearning' er sat til TRUE! Al læring er deaktiveret.";
            log(`🚨 ${warningMsg}`);
            noteFault("BF-203");
            await updateTag("Bad_Fugt_Advarsel", warningMsg);
            if (freezeReason) {
                log("   🧠 Nulstilling sprunget over: huset er under udluftning — vent til luften er normal igen.");
            } else {
                seasonState.baseline = learnedMetric;
                seasonState.lastRun = now;
                emaCache.freezeUntil = 0;
            }
        }

        const hasBaseline = Number.isFinite(Number(seasonState.baseline));

        const persist = (baseline, extraLog) => {
            seasonState.baseline = baseline;
            seasonState.lastRun = now;
            emaCache[season] = seasonState;
            if (useAH) emaCache[EMA_BASELINE_KEY] = baseline;
            saveEmaCache(emaCache);
            if (useAH) avgRefAH = baseline;
            else avgRefHum = baseline;
            if (extraLog) log(extraLog);
        };

        const persistFreezeClockOnly = () => {
            saveEmaCache(emaCache);
        };

        if (freezeReason && !hasBaseline) {
            persistFreezeClockOnly();
            referenceType = `råt gennemsnit (læring venter på lukkede vinduer)`;
            log(`   🧠 Læring venter: ${freezeReason}. Gemmer ikke ${learnedMetric.toFixed(1)}${unit} som baseline (udluftet hus).`);
        } else if (!hasBaseline) {
            log(`   🆕 Starter EMA-cache (${season}) i global["${EMA_CACHE_KEY}"]`);
            persist(learnedMetric);
            referenceType = `lært baseline (${season})`;
        } else {
            const lastRun = Number(seasonState.lastRun) || 0;
            const dtHours = lastRun ? (now - lastRun) / 3600000 : 1.0;
            const cappedDtHours = Math.min(Math.max(dtHours, 0), 24);
            const effectiveSpeed = 1 - Math.pow(1 - CONFIG.learningSpeed, cappedDtHours);
            const currentLearned = Number(seasonState.baseline);

            if (freezeReason) {
                persist(currentLearned);
                referenceType = `lært baseline (frosset: ${freezeReason})`;
                log(`   🧠 Læring FROSSET: ${freezeReason}. Baseline forbliver ${currentLearned.toFixed(1)}${unit} (måling var ${learnedMetric.toFixed(1)}${unit}).`);
            } else {
                const jump = Math.abs(learnedMetric - currentLearned);
                if (jump > maxJump) {
                    persist(currentLearned);
                    referenceType = "lært baseline (outlier ignoreret)";
                    log(`   🧠 Læring PAUSET (Outlier): Måling (${learnedMetric.toFixed(1)}${unit}) afviger for meget fra baseline (${currentLearned.toFixed(1)}${unit}). Spring på ${jump.toFixed(1)}${unit} er over grænsen på ${maxJump}${unit}.`);
                } else {
                    let newLearned = clamp((learnedMetric * effectiveSpeed) + (currentLearned * (1 - effectiveSpeed)), 0, clampMax);
                    const drop = currentLearned - newLearned;
                    const maxDropThisTick = maxDropPerHour * cappedDtHours;
                    if (drop > maxDropThisTick) {
                        newLearned = clamp(currentLearned - maxDropThisTick, 0, clampMax);
                        log(`   🧠 Dyk begrænset: EMA ville falde ${drop.toFixed(2)}${unit}, loft er ${maxDropThisTick.toFixed(2)}${unit} (${maxDropPerHour}${unit}/t).`);
                    }
                    persist(newLearned);
                    log(`   🧠 Læring (${season}): Justerer baseline fra ${currentLearned.toFixed(1)}${unit} til ${newLearned.toFixed(1)}${unit} (dt: ${dtHours.toFixed(2)}h, α: ${effectiveSpeed.toFixed(3)})`);
                    referenceType = `lært baseline (${season})`;
                }
            }
        }
    }
    // ------------------------------------------------------------------

    // 3b. Bestem fugtighed: Bruger input-feltet fra Flowet (hvis udfyldt) ellers sensoren
    let bathHum;
    const bathReading = readingFromDevice(bathDevice);
    if (args && args[0]) {
        bathHum = parseFloat(args[0]);
        log(`🧪 SIMULERING: Bruger test-værdi fra Flow: ${bathHum}% (Ignorerer fysisk sensor)`);
    } else {
        // Tjek target (Badet SKAL være opdateret) - Tjekkes kun hvis vi ikke simulerer
        isFresh(bathDevice, CONFIG.targetSensor, true);
        if (bathReading.rh === null) throw codedError("BF-212", `"${CONFIG.targetSensor}"`);
        bathHum = bathReading.rh;
    }

    const bathAH = absoluteHumidity(bathReading.tempC, bathHum);
    if (bathAH === null) throw codedError("BF-213");
    if (bathReading.usedFallbackTemp) {
        log(`   ℹ️ Badet mangler temperatur — bruger fallback ${CONFIG.fallbackTempC}°C til g/m³.`);
        noteFault("BF-206", `${CONFIG.fallbackTempC}°C`);
    }

    // 4. Beregn differencen (afrundet til 1 decimal)
    const refHumFixed = round1(avgRefHum);
    const refAHFixed = round1(avgRefAH);
    const bathAHFixed = round1(bathAH);
    const diffRH = round1(bathHum - refHumFixed);
    const diffAH = round1(bathAH - avgRefAH);
    
    const currentMinHum = isWinter ? CONFIG.minHumidityWinter : CONFIG.minHumiditySummer;

    const moistureExcess = useAH ? (diffAH >= CONFIG.thresholdAH) : (diffRH >= CONFIG.threshold);
    const wet = moistureExcess && (bathHum >= currentMinHum);
    const clearAH = CONFIG.thresholdAH - (Number(CONFIG.clearMarginAH) || 0);
    const clearRH = CONFIG.threshold - (Number(CONFIG.clearMarginRH) || 0);
    const clearMin = currentMinHum - (Number(CONFIG.clearMarginMinHum) || 0);
    const stillWet = (useAH ? (diffAH >= clearAH) : (diffRH >= clearRH)) && (bathHum >= clearMin);

    let trigger = wet;
    let episodeOpen = wet;
    if (CONFIG.alarmOnceUntilClear && !CONFIG.testMode && !isSimulated) {
        const wasLatched = !!(typeof global !== "undefined" && global.get && global.get(ALARM_LATCH_KEY));
        if (wet && !wasLatched) {
            trigger = true;
            episodeOpen = true;
            if (typeof global !== "undefined" && global.set) global.set(ALARM_LATCH_KEY, true);
            log("   🔔 Ny fugt-episode — returnerer true én gang.");
        } else if (wasLatched && stillWet) {
            trigger = false;
            episodeOpen = true;
            log("   🔕 Fugt-episode allerede udløst — venter på at fugten aftager.");
        } else if (wasLatched && !stillWet) {
            trigger = false;
            episodeOpen = false;
            if (typeof global !== "undefined" && global.set) {
                global.set(ALARM_LATCH_KEY, false);
                global.set(PUSH_SENT_KEY, false);
            }
            log("   ✅ Fugt aftaget — klar til en ny episode.");
        } else {
            trigger = false;
            episodeOpen = false;
        }
    }

    const hasOutdoorAH = outdoorAH !== null && Number.isFinite(Number(outdoorAH));
    // Uden ude-data: anbefal alligevel vindue (tag true), men marker fejlen på tidslinjen.
    const outdoorIsDrier = !hasOutdoorAH || (bathAH > outdoorAH + 0.5);
    const outdoorStatus = hasOutdoorAH
        ? `(${fmtAH(outdoorAH)} vs bad ${fmtAH(bathAHFixed)} g/m³)`
        : "";
    
    const requiredHum = round1(refHumFixed + CONFIG.threshold);
    const requiredAH = round1(refAHFixed + CONFIG.thresholdAH);

    log(`📊 STATUS RAPPORT:`);
    log(`   🚿 Bad:       ${bathHum}% / ${fmtAH(bathAHFixed)} g/m³ @ ${bathReading.tempC}°C ${bathHum < currentMinHum ? `(Under ${isWinter ? 'vinter' : 'sommer'}grænse på ${currentMinHum}%)` : ''}`);
    log(`   🏠 Snit (Ref):${refHumFixed}% / ${fmtAH(refAHFixed)} g/m³ (${referenceType})`);
    if (useAH) {
        log(`   📈 Forskel:   ${diffAH} g/m³ (Krav: ≥${CONFIG.thresholdAH} g/m³) -> Bad skal være over ${requiredAH} g/m³ for at starte.`);
        log(`   📉 RH-diff:   ${diffRH}%-point (kun til flows/tags)`);
    } else {
        log(`   📈 Forskel:   ${diffRH}% (Krav: >${CONFIG.threshold}%) -> Bad skal være over ${requiredHum}% for at starte.`);
    }
    if (hasOutdoorAH && !outdoorIsDrier && outdoorInfo) {
        log(`   🚫 Udeluft er ikke tørrere (${fmtAH(outdoorAH)} vs bad ${fmtAH(bathAHFixed)} g/m³) — åbn ikke vinduet.`);
    } else if (outdoorIssue) {
        log(`   ⚠️ Weather ${outdoorIssue === "forældet" ? "er for gammelt" : "blev ikke fundet"} — anbefaler alligevel at åbne vinduet, hvis badet er for fugtigt.`);
    }
    log(`   🏁 Resultat:  ${wet ? (trigger ? '🔥 ALARM (Ny episode)' : '🔕 Fugtigt (allerede udløst)') : '💤 STANDBY (Ikke fugtigt nok)'}`);

    if (outdoorIssue === "forældet") {
        noteFault("BF-202");
    } else if (outdoorIssue === "mangler") {
        noteFault("BF-201");
    }
    await flushFaults();

    // 5. Opret avancerede Tags til brug i Flows
    // Bad_Fugt_Diff / Bad_Fugt_Absolut forbliver RH, så eksisterende flows ikke knækker.
    await Promise.all([
        updateTag("Bad_Fugt_Diff", diffRH),
        updateTag("Bad_Fugt_Absolut", bathHum),
        updateTag("Bad_Fugt_Trigger", trigger),
        updateTag("Bad_Fugt_AH", bathAHFixed),
        updateTag("Bad_Fugt_AH_Ref", refAHFixed),
        updateTag("Bad_Fugt_AH_Diff", diffAH),
        ...(hasOutdoorAH ? [updateTag("Bad_Fugt_Ude_AH", round1(outdoorAH))] : []),
        updateTag("Bad_Fugt_Ude_Tørre", outdoorIsDrier),
        updateTag("Bad_Fugt_Ude_Status", outdoorStatus)
    ]);

    // 6. (Valgfrit) Opret tekst til Push-besked
    if (CONFIG.createMsgTag) {
        let message = "";
        
        // Tjek om vi er i "stille tid"
        const hour = new Date().getHours();
        const isSilent = (CONFIG.silentStart > CONFIG.silentEnd) 
            ? (hour >= CONFIG.silentStart || hour < CONFIG.silentEnd)
            : (hour >= CONFIG.silentStart && hour < CONFIG.silentEnd);

        const ahSummary = `Bad ${fmtAH(bathAHFixed)} g/m³ vs hus ${fmtAH(refAHFixed)} g/m³`;

        // Prioritering: 1. TestMode | 2. Manuel Flow-Test (Input) | 3. Rigtig Alarm
        if (CONFIG.testMode) {
            message = useAH
                ? `🧪 TEST: ${ahSummary}, diff ${diffAH} g/m³ (RH ${bathHum}% / ${refHumFixed}%)`
                : `🧪 TEST: Bad ${bathHum}%, Ref ${refHumFixed}%, Diff ${diffRH}%`;
        } else if (args && args[0]) {
            // Hvis vi tester manuelt via Flow (indtastet tal), vil vi altid have svar
            if (wet) {
                 message = useAH
                    ? `🧪 TEST-ALARM: ${fmtAH(bathAHFixed)} g/m³ er for højt! (Ville starte ved >${requiredAH} g/m³)`
                    : `🧪 TEST-ALARM: ${bathHum}% er for højt! (Ville starte ved >${requiredHum}%)`;
            } else {
                 message = useAH
                    ? `✅ TEST-OK: ${fmtAH(bathAHFixed)} g/m³ er fint. (Ville starte ved >${requiredAH} g/m³)`
                    : `✅ TEST-OK: ${bathHum}% er fint. (Ville starte ved >${requiredHum}%)`;
            }
        } else if (episodeOpen) {
            const pushAlreadySent = CONFIG.alarmOnceUntilClear
                && !!(typeof global !== "undefined" && global.get && global.get(PUSH_SENT_KEY));
            if (pushAlreadySent) {
                log("   🔕 Push for denne fugt-episode er allerede sendt.");
            } else if (isSilent) {
                log(`   🔕 Venter med push til efter kl. ${CONFIG.silentEnd}:00 (stille ${CONFIG.silentStart}:00-${CONFIG.silentEnd}:00).`);
            } else if (isWindowOpen) {
                log("   🔕 Venter med push — tagvinduet i badet er allerede åbent.");
            } else if (hasOutdoorAH && !outdoorIsDrier) {
                log("   🔕 Venter med push — udeluften er ikke tørrere end badet.");
            } else {
                const outdoorRH = (hasOutdoorAH && outdoorInfo && Number.isFinite(Number(outdoorInfo.rh)))
                    ? round1(outdoorInfo.rh)
                    : null;
                const lines = [
                    "🪟 Åbn vinduet i badeværelset — det er for fugtigt.",
                    `🚿 Bad: ${round1(bathHum)}% relativ fugt`,
                    `🏠 Hus: ${refHumFixed}% relativ fugt`
                ];
                if (outdoorRH !== null) {
                    const bathWater = Number(bathAH);
                    const udeWater = Number(outdoorAH);
                    const lessPct = (Number.isFinite(bathWater) && bathWater > 0 && Number.isFinite(udeWater))
                        ? Math.max(0, Math.round((1 - udeWater / bathWater) * 100))
                        : null;
                    let benefit;
                    if (lessPct === null) {
                        benefit = "💨 luften ude er tørrere";
                    } else if (lessPct >= 40) {
                        benefit = `✅ stor gevinst: ca. ${lessPct}% mindre vand i luften end i badet`;
                    } else if (lessPct >= 20) {
                        benefit = `👍 tydelig gevinst: ca. ${lessPct}% mindre vand i luften end i badet`;
                    } else if (lessPct >= 8) {
                        benefit = `➖ lille gevinst: ca. ${lessPct}% mindre vand i luften end i badet`;
                    } else {
                        benefit = "⚠️ kun en lille forskel — luften ude er næsten lige så fugtig";
                    }
                    lines.push(`🌤️ Ude: ${outdoorRH}% relativ fugt (${benefit})`);
                } else if (outdoorIssue === "forældet") {
                    lines.push("🌤️ Ude: ikke tjekket (vejrdata er for gammelt).");
                } else if (outdoorIssue === "mangler") {
                    lines.push("🌤️ Ude: ikke tjekket (ingen vejrstation).");
                }
                message = lines.join("\n");
                if (CONFIG.alarmOnceUntilClear && typeof global !== "undefined" && global.set) {
                    global.set(PUSH_SENT_KEY, true);
                }
            }
        }
        
        // Opdater altid beskeden (tøm den hvis ingen alarm), så vi ikke sender gammel tekst ved en fejl
        // Nyt tag: Fortæller flowet at der skal sendes en besked nu (bruges i "OG..." feltet)
        await Promise.all([
            updateTag("Bad_Fugt_Besked", message),
            updateTag("Bad_Fugt_Send_Push", !!message)
        ]);
    }

    if (CONFIG.testMode) {
        log("🧪 TEST-MODE: Returnerer 'True' uanset fugtniveau.");
        return true;
    }

    log(`🔄 AFSLUTTER: Scriptet returnerer '${trigger}' til flowet.`);
    return trigger;

} catch (err) {
    const code = err.faultCode || classifyFault(err && err.message);
    console.error(err && err.message);
    noteFault(code, code === "BF-199" || code === "BF-218" ? (err && err.message) : undefined);
    await flushFaults();
    await Promise.all([
        updateTag("Bad_Fugt_Trigger", false),
        updateTag("Bad_Fugt_Send_Push", false),
        updateTag("Bad_Fugt_Besked", "")
    ]);
    return false;
} finally {
    // Ryd advarsels-tagget hvis resetLearning ikke (længere) er aktiv.
    if (!CONFIG.resetLearning) {
        await updateTag("Bad_Fugt_Advarsel", "");
    }
}
