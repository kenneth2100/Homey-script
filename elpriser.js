/**
 * Elpris til HomeyScript (DK1/DK2, 15-min day-ahead, pris som på elregningen).
 *
 * Flow-argument: "AntalTimer,Timespan" (fx 4,24). Uden argument: 2,16.
 * Tags: se «TAG-OVERSIGT» under TAGS_ALLE (kun læsning — Homey kører den ikke).
 * AFINSTALLER = true: sletter alle Elpris-tags og stopper (sæt tilbage til false).
 * Virtuel enhed: sæt elprisDeviceName. Findes på navn; capabilities matches på TITLEN
 * og huskes på id. Mangler et felt på enheden, udgives det som tag i stedet.
 * Mangler hele enheden: alle dashboard-felter som tags.
 * Skriver kun ændrede værdier. Manglende caps ignoreres.
 * Hvert kvarter: Pris nu, Status, Tendens, under snit, vs. typisk, rang, 1T/3T/6T,
 * kør/start nu, periode, ventetid, besparelse, typisk pris, systemstatus.
 * Ved timeskift: 8T, i dag, i morgen klar, graf.
 *
 * Opret enheden med navnet "Elpris ⚡". Capability-type og titel i Homey:
 *
 * ⚡ Pris
 *   number  (kr)   Pris nu                      Samlet kWh-pris inkl. moms.
 *   string         Status                       Typisk pris eller rang i dag (STATUS_VS_PERIODE).
 *   string         Tendens                      📉/➡️/📈 — 1T kontra 4T, plus de to snit.
 *   boolean        Under dagens snit            Pris nu < dagens gennemsnit. Ja/nej (onoff) eller tekst.
 *   number  (%)    Afvigelse fra typisk (%)     (pris nu / typisk − 1) × 100. Gammel titel: Afvigelse vs typisk.
 *   number         Rang i dag                   1 = billigste kvarter. Gammel titel: Pris nu rang i dag.
 *
 * 📊 Fremad
 *   number  (kr)   Gns. næste 1T                Gammel titel: Gns. pris næste 1T. Fra kvarters START.
 *   number  (kr)   Gns. næste 3T
 *   number  (kr)   Gns. næste 6T
 *   number  (kr)   Gns. næste 8T                Gammel titel: Gn. snt. pris næste 8T.
 *   number  (kr)   Billigste næste 8T           Gammel titel: Billigste pris næste 8T.
 *   string         Billigste næste 8T tidspunkt Gammel titel: Billigste time næste 8T.
 *   number  (kr)   Dyreste næste 8T
 *   string         Dyreste næste 8T tidspunkt
 *
 * ▶️ Optimering
 *   boolean        Kør nu
 *   boolean        Start nu
 *   string         Anbefalet periode            Fx 15:00–17:00.
 *   number  (t)    Ventetid                     Timer til anbefalet start.
 *   number  (kr)   Besparelse                   kr/kWh vs. bedste periodesnit. Gammel titel: Besparelse kr/kWh.
 *   number  (kr)   Besparelse eksempel          Ved BESPARELSE_EKSEMPEL_KW i periodens længde.
 *
 * 📅 Dag
 *   number  (kr)   Billigste i dag              Gammel titel: Billigste pris i dag.
 *   string         Billigste i dag tidspunkt    Gammel titel: Billigste time i dag.
 *   number  (kr)   Dyreste i dag
 *   string         Dyreste i dag tidspunkt
 *   boolean        I morgen klar                Komplet i-morgen-døgn. Ja/nej eller tekst.
 *
 * 🧠 Læring
 *   number  (kr)   Typisk pris                  EWMA-baseline. Gammel titel: Typisk niveau.
 *                  Afvigelse fra typisk (%) ligger under Pris (samme felt).
 *
 * 🎨 Grafik / intern — kun på enheden, aldrig som tags
 *   string         Graf farver i dag
 *   string         Graf URL                     GRAF_URL = false slår fra. QuickChart ved timeskift.
 *   string         Graf i morgen URL            Når i morgen er ude.
 *
 * 🟢 System
 *   string         Systemstatus                 API, tarif, data, i morgen, sidste kørsel.
 *
 * Øvrige tal (2T/4T/5T/7T, uge, i morgen-priser, timeprofil, …) er kun HomeyScript-tags.
 *
 * Insights på «Pris nu» er kun historik af skrevne værdier, ikke en day-ahead-graf.
 * Når-kort i Flow: enhedens værdi er ændret (Pris nu, Status, Under dagens snit, …).
 *
 * Konfiguration: ét afsnit «KONFIGURATION» lige under denne kommentar. Resten er programkode.
 */

//==============================================================================
// KONFIGURATION — rediger her
//==============================================================================

// --- Elområde og netselskab --------------------------------------------------
const PriceArea = "DK1"; // DK1 vest for Storebælt, DK2 øst.
const NETSELSKAB_VALG = "N1"; // Katalog-navn (N1, Radius, Cerius, …) eller 13-cifret GLN.
const AUTO_FETCH_TARIFF = true; // Hent nettarif fra Datahub. false = kun manuelle satser.
const AUTO_FETCH_ENERGINET = true; // Hent Energinets system- og transmissionstarif.

// --- Pris på regningen -------------------------------------------------------
const ELSKAB_TILLAEG_INKL_MOMS = 0.035; // Elselskabets spottillæg, kr/kWh inkl. moms.
const ENERGINET_TARIF_INKL_MOMS = 0.1425; // Fallback hvis Energinet-API fejler, kr/kWh inkl. moms.
const IGNORER_NETTARIF_OG_ELAFGIFT = false; // true = kun spot + tillæg (uden net og elafgift).
const ELAFGIFT_INKL_MOMS_PR_AAR = { // Statens elafgift inkl. moms, kr/kWh. Ukendt år → seneste kendte.
  2023: 0.01,
  2024: 0.95125,
  2025: 0.95125,
  2026: 0.01,
  2027: 0.01,
  2028: 0.01
};
const Pris_Lavlast = 0.01; // Manuel nettarif lavlast, kr/kWh eks. moms (hvis API mangler).
const Pris_Hojlast = 0.01 + 0.48; // Manuel nettarif højlast.
const Pris_Spids   = 0.01 + 1.44; // Manuel nettarif spidslast.

// --- Anbefalet periode -------------------------------------------------------
const BilligPrisMinForskelPct = 5; // Periode skal være mindst så mange % billigere end at starte nu.
const BilligPrisMinForskel = 20; // Bundgrænse i øre/kWh, hvis %-kravet bliver for lille.
const MaksimalVentetidTimer = "auto"; // 0 = ingen grænse. Tal = fast loft i timer. "auto" = besparelse vs. ventetid.
const VENT_AUTO_MIN_ORE = 12; // Auto: under dette er perioden kun marginalt billigere.
const VENT_AUTO_ORE_PR_TIME = 8; // Auto: øre/kWh pr. times ventetid.
const VENT_AUTO_MAX_TIMER = 12; // Auto: hard loft i timer (0 = kun søgevinduet).
const VENT_MIN_KR_PR_KW = 0.15; // Under dette: start nu (for lille gevinst pr. kW).
const VENT_MIN_TOTAL_KR = 2.00; // «Vent kun hvis forbrug > X kW», X = dette / spar kr/kW.
const VENT_ALLTID_UNDER_KW = 1.00; // Hvis X er ≤ 1 kW, sig bare «Vent».
const BESPARELSE_EKSEMPEL_KW = 3; // «Ved X kW → … kr» i besparelsespotentiale.

// --- Status og tendens -------------------------------------------------------
// STATUS_VS_PERIODE false = kun rang i dag (billigste 25 % = Billig, også på en dyr dag).
// true = ift. indlærte billig/dyr-bånd (percentiler over afsluttede døgn).
// Indtil TIMEPROFIL_MIN_DAGE: fald tilbage til typisk kWh-pris ± STATUS_* nedenfor.
const STATUS_VS_PERIODE = true;
const STATUS_LAERING = 0.15; // Hvor meget en ny dag rykker typisk pris (0.15 ≈ en uge).
const TIMEPROFIL_MIN_DAGE = 3; // Timeprofil «normalt …» først efter så mange afsluttede døgn.
const STATUS_BILLIG_PCT = 12; // Under typisk med mindst 12 % → 🟢 Billig
const STATUS_MEGET_BILLIG_PCT = 25; // Under med mindst 25 % → 🟢 Meget billig
const STATUS_DYR_PCT = 15; // Over typisk med mindst 15 % → 🟠 Dyr
const STATUS_MEGET_DYR_PCT = 35; // Over med mindst 35 % → 🔴 Meget dyr
const STATUS_BILLIG_KR = 0.20; // …eller mindst 0,20 kr under → 🟢 Billig
const STATUS_MEGET_BILLIG_KR = 0.50; // …eller mindst 0,50 kr under → 🟢 Meget billig
const STATUS_DYR_KR = 0.30; // …eller mindst 0,30 kr over → 🟠 Dyr
const STATUS_MEGET_DYR_KR = 0.70; // …eller mindst 0,70 kr over → 🔴 Meget dyr
const TENDENS_KORT_T = 1; // Tendens: næste T timer kontra TENDENS_LANG_T.
const TENDENS_LANG_T = 4;
const TENDENS_PCT = 8; // mindst 8 % forskel → faldende/stigende
const TENDENS_KR = 0.08; // …eller mindst 0,08 kr
const SMERTETAERSKEL_KR = 1.00; // «Under smertetærskel» = pris nu ≤ denne grænse (kr/kWh).

// --- Homey -------------------------------------------------------------------
const elprisDeviceName = "Elpris ⚡"; // Virtuel enhed. Tom = kun tags.
const elprisDeviceCapIds = { // Valgfrit: tving capability-id. Tom = find på titel, husk id.
  // prisNu: "measure_123"
};
const ELPRIS_ALARM_NAVN = "Elpris billigste start"; // Homey-ur til anbefalet start.
const TIDSZONE = "Europe/Copenhagen"; // Klokkeslæt på tags. "Auto" = Homeys tidszone.
const GRAF_URL = true; // Hent QuickChart-URL til Graf URL / i morgen.

// --- Log og vedligehold ------------------------------------------------------
const LOG_LEVEL = "INFO"; // INFO = kompakt kørsel. DEBUG = dump. TRACE = dyb spor + skriv alle enhedsfelter.
const AFINSTALLER = false; // true = slet alle Elpris-tags og stop. Sæt tilbage til false bagefter.

//==============================================================================
// PROGRAM — interne konstanter og hjælpere. Rør kun hvis du ved hvorfor.
//==============================================================================

const ENERGINET_GLN = "5790000432752"; // Energinets Datahub-GLN.
const NETSELSKAB_KATALOG = {
  "N1": "5790001089030",
  "Radius": "5790000705689",
  "Cerius": "5790000705184",
  "Konstant": "5790000704842",
  "TREFOR": "5790000392261",
  "DINEL": "5790000610099",
  "Nord Energi": "5790000610877",
  "RAH": "5790000681075",
  "Vores Elnet": "5790001095277",
  "Netselskabet Elværk": "5790000682102",
  "Elektrus": "5790000706419",
  "Hurup": "5790001100520",
  "L-Net": "5790001090166"
};
function netselskabGln(valg) {
  const s = String(valg || "").trim();
  if (/^\d{13}$/.test(s)) return s;
  const want = s.toLowerCase().replace(/\s+/g, " ");
  for (const navn of Object.keys(NETSELSKAB_KATALOG)) {
    if (navn.toLowerCase() === want) return NETSELSKAB_KATALOG[navn];
  }
  return s;
}
function netselskabValgErGyldigt(valg) {
  const s = String(valg || "").trim();
  if (/^\d{13}$/.test(s)) return true;
  const want = s.toLowerCase().replace(/\s+/g, " ");
  for (const navn of Object.keys(NETSELSKAB_KATALOG)) {
    if (navn.toLowerCase() === want) return true;
  }
  return false;
}
const NETSELSKAB_VALG_OK = netselskabValgErGyldigt(NETSELSKAB_VALG);
const NETSELSKAB = netselskabGln(NETSELSKAB_VALG);

function elafgiftInklForAar(year) {
  const y = Number(year);
  if (ELAFGIFT_INKL_MOMS_PR_AAR[y] != null) return ELAFGIFT_INKL_MOMS_PR_AAR[y];
  const years = Object.keys(ELAFGIFT_INKL_MOMS_PR_AAR).map(Number).sort((a, b) => a - b);
  if (!years.length) return 0.01;
  if (y < years[0]) return ELAFGIFT_INKL_MOMS_PR_AAR[years[0]];
  return ELAFGIFT_INKL_MOMS_PR_AAR[years[years.length - 1]];
}

const LOG_NIVEAUER = { INFO: 1, DEBUG: 2, TRACE: 3 };
const LOG_NIVEAU = LOG_NIVEAUER[String(LOG_LEVEL).trim().toUpperCase()] || 1;
function isDebug() { return LOG_NIVEAU >= 2; }
function isTrace() { return LOG_NIVEAU >= 3; }
function emitLog(msg) {
  if (typeof log === "function") log(msg);
  else if (typeof console !== "undefined" && console.log) console.log(msg);
}
function logTrace(msg) { if (isTrace()) emitLog("TRACE  " + msg); }

const TAGS_KUN_ENHED = [ // Foretrækkes på enheden. Mangler feltet, udgives det som tag.
  "Elpris graf farver i dag",
  "Elpris graf URL",
  "Elpris graf i morgen URL"
];

const TAGS_ALLE = (function () { // Aktive tags til AFINSTALLER. Grupper = TAG-OVERSIGT.
  const kl = prefix => [prefix, prefix + " (kl)", prefix + " (min)"];
  const gnsT = [];
  for (let h = 1; h <= 7; h++) gnsT.push("Elpris gns. næste " + h + "T (kr)");
  return [].concat(
    [
      "Elpris pris nu (kr)",
      "Elpris prisændring (kr)",
      "Elpris prisændring (%)",
      "Elpris under dagens snit",
      "Elpris under smertetærskel",
      "Elpris kvarter (kl)",
      "Elpris kvarter (min)",
      "Elpris spot eks. moms (kr)",
      "Elpris nettarif eks. moms (kr)",
      "Elpris Energinet eks. moms (kr)",
      "Elpris elafgift eks. moms (kr)",
      "Elpris tillæg eks. moms (kr)",
      "Elpris moms (kr)",
      "Elpris status",
      "Elpris rang i dag",
      "Elpris procent i dag (%)",
      "Elpris antal kvarter i dag",
      "Elpris typisk niveau (kr)",
      "Elpris vs typisk (%)",
      "Elpris tendens",
      "Elpris typisk vs nu"
    ],
    gnsT,
    [
      "Elpris gn. snt. næste 8T (kr)",
      "Elpris billigste næste 8T (kr)",
      "Elpris dyreste næste 8T (kr)"
    ],
    kl("Elpris billigste næste 8T"),
    kl("Elpris dyreste næste 8T"),
    [
      "Elpris periode fundet",
      "Elpris periode start (kl)",
      "Elpris periode start (min)",
      "Elpris periode start",
      "Elpris periode slut (kl)",
      "Elpris periode slut (min)",
      "Elpris periode slut",
      "Elpris start nu",
      "Elpris kør nu",
      "Elpris anbefalet periode",
      "Elpris ventetid (t)",
      "Elpris periode længde (t)",
      "Elpris fundet periode snit (kr)",
      "Elpris søgt frem (t)",
      "Elpris periode billigste (kl)",
      "Elpris periode billigste (min)",
      "Elpris periode billigste (kr)",
      "Elpris periode dyreste (kl)",
      "Elpris periode dyreste (min)",
      "Elpris periode dyreste (kr)",
      "Elpris anbefalet er absolut",
      "Elpris søgevindue snit (kr)",
      "Elpris snit hvis start nu (kr)",
      "Elpris max ventetid (t)",
      "Elpris vente beslutning",
      "Elpris vente råd",
      "Elpris vent min forbrug (kW)",
      "Elpris besparelse (kr/kWh)",
      "Elpris besparelse ved vente (%)",
      "Elpris besparelse eksempel (kr)",
      "Elpris besparelsespotentiale",
      "Elpris absolut fundet",
      "Elpris absolut start (kl)",
      "Elpris absolut start (min)",
      "Elpris absolut snit (kr)",
      "Elpris absolut ventetid (t)",
      "Elpris absolut besparelse (kr/kW)",
      "Elpris i billig zone",
      "Elpris zone fundet",
      "Elpris zone start (kl)",
      "Elpris zone start (min)",
      "Elpris zone slut (kl)",
      "Elpris zone slut (min)",
      "Elpris zone længde (t)",
      "Elpris zone snit (kr)",
      "Elpris billig til (kl)",
      "Elpris billig til (min)",
      "Elpris næste billige (kl)",
      "Elpris næste billige (min)",
      "Elpris næste billige (kr)",
      "Elpris allerbilligste (kl)",
      "Elpris allerbilligste (min)",
      "Elpris allerbilligste (kr)",
      "Elpris gennemsnit i dag (kr)",
      "Elpris billigste i dag (kr)",
      "Elpris dyreste i dag (kr)",
      "Elpris gennemsnit i morgen (kr)",
      "Elpris billigste i morgen (kr)",
      "Elpris dyreste i morgen (kr)",
      "Elpris i morgen klar",
      "Elpris gn. snt. sidste uge (kr)",
      "Elpris gn. snt. denne uge (kr)",
      "Elpris uges kvarter"
    ],
    kl("Elpris billigste i dag"),
    kl("Elpris dyreste i dag"),
    kl("Elpris billigste i morgen"),
    kl("Elpris dyreste i morgen"),
    [
      "Elpris typisk timeprofil",
      "Elpris timeprofil",
      "Elpris timeprofil rang",
      "Elpris timeprofil døgn",
      "Elpris timeprofil dage",
      "Elpris læring datagrundlag",
      "Elpris læring modenhed (%)",
      "Elpris opdateret",
      "Elpris fejl",
      "Elpris fejlkode",
      "Elpris systemstatus",
      "Elpris systemstatus detalje",
      "Elpris sidste kørsel (ms)",
      "Elpris API (ms)",
      "Elpris beregning (ms)",
      "Elpris tags ændret",
      "Elpris tags uændret",
      "Elpris datakvalitet OK",
      "Elpris datakvalitet optimering OK",
      "Elpris datakvalitet",
      "Elpris ændring",
      "Elpris har ændring",
      "Elpris speak",
      "Elpris speak periode"
    ],
    TAGS_KUN_ENHED
  );
})();

//---------------------------- TAG-OVERSIGT (kun kommentar) -------------------------------//
// Homey kører ikke dette afsnit. Huskeliste til Flow og enheden «Elpris ⚡».
// Findes feltet på enheden, er det ikke også et tag. Mangler det, oprettes det som tag.
// (kl)/(min) = tal til Flow (−1 = ingen). Byg selv klokkeslæt.
//
// ⚡ PRIS
// Elpris pris nu (kr)               Samlet kWh-pris inkl. moms.
// Elpris prisændring (kr)           Nu minus forrige kørsel. 0,23 = +23 øre. 0 = første kørsel.
// Elpris prisændring (%)            Samme skift i procent. 18,4 = +18,4 %.
// Elpris under dagens snit          true hvis pris nu < dagens gennemsnit.
// Elpris under smertetærskel        true hvis pris nu ≤ SMERTETAERSKEL_KR.
// Elpris kvarter (kl)/(min)         Start på det kvarter, «pris nu» gælder for.
// Elpris spot/nettarif/Energinet/elafgift/tillæg eks. moms (kr)  Enkeltdele.
// Elpris moms (kr)
//
// 📊 STATUS
// Elpris status                     🟢 Billig … 🔴 Meget dyr (indlærte bånd, ellers typisk/rang).
// Elpris rang i dag                 1 = billigste kvarter i dag.
// Elpris procent i dag (%)          rang/antal×100. < 20 = blandt billigste 20 % i dag.
// Elpris antal kvarter i dag        96 (92/100 ved sommertid).
// Elpris typisk niveau (kr)         Lært normal kWh-pris (EWMA).
// Elpris vs typisk (%)              Nu vs. typisk. −32 = 32 % under.
// Elpris tendens                    📉/➡️/📈 — 1T kontra 4T.
// Elpris typisk vs nu               Samme tal som tekst (valgfrit).
//
// 🕐 NÆSTE TIMER
// Elpris gns. næste 1T … 7T (kr)    Snit fra indeværende kvarters start.
// Elpris gn. snt. næste 8T (kr)
// Elpris billigste næste 8T (kr) + (kl)/(min)
// Elpris dyreste næste 8T (kr) + (kl)/(min)
//
// 🟢 ANBEFALET PERIODE
// Elpris periode fundet
// Elpris anbefalet periode          Fx 15:00–17:00 (enhed).
// Elpris periode start (kl)/(min)
// Elpris periode slut (kl)/(min)
// Elpris start nu / kør nu
// Elpris ventetid (t)
// Elpris periode længde (t)         ArgsAntalTimer.
// Elpris fundet periode snit (kr)
// Elpris periode start/slut         Tekst-klokkeslæt (samme som kl/min).
// Elpris søgt frem (t)              ArgsTimespan.
// Elpris periode billigste/dyreste  (kl)/(min)/(kr) i den anbefalede periode.
// Elpris anbefalet er absolut
// Elpris søgevindue snit (kr)
// Elpris snit hvis start nu (kr)
// Elpris max ventetid (t)
//
// 💰 VENT / BESPAR
// Elpris vente beslutning           Start nu / Vent / Vent kun hvis forbruget > X kW.
// Elpris vente råd                  Kort sætning (auto-forklaring eller «Vent … t»).
// Elpris vent min forbrug (kW)      X i «vent kun hvis». 0 = start nu eller bare vent.
// Elpris besparelse (kr/kWh)        Pris nu minus bedste periodesnit.
// Elpris besparelse ved vente (%)   Gevinst vs. start nu, hele kørslen.
// Elpris besparelse eksempel (kr)   Ved BESPARELSE_EKSEMPEL_KW i periodens længde.
// Elpris besparelsespotentiale      Samlet tekst til mennesker.
//
// 🥇 ABSOLUT
// Elpris absolut fundet
// Elpris absolut start (kl)/(min)
// Elpris absolut snit (kr)
// Elpris absolut ventetid (t)
// Elpris absolut besparelse (kr/kW)
//
// 🔵 ZONE
// Elpris i billig zone
// Elpris zone fundet
// Elpris zone start (kl)/(min)
// Elpris zone slut (kl)/(min)
// Elpris zone længde (t)
// Elpris zone snit (kr)
//
// 🔮 NÆSTE BILLIGE
// Elpris billig til (kl)/(min)      Hvornår «billig nu» slutter (over dagens snit).
// Elpris næste billige (kl)/(min)/(kr)
// Elpris allerbilligste (kl)/(min)/(kr)
//
// 📅 DAG / I MORGEN / UGE
// Elpris gennemsnit / billigste / dyreste i dag (kr) + (kl)/(min)
// Elpris gennemsnit / billigste / dyreste i morgen (kr) + (kl)/(min)
// Elpris i morgen klar
// Elpris gn. snt. sidste uge (kr) / denne uge (kr)
// Elpris uges kvarter
//
// 🧠 LÆRING
// Elpris typisk timeprofil          Fx «18:00 er normalt blandt dagens dyre timer.»
// Elpris timeprofil                 «normalt midt i døgnet (hverken billig eller dyr)» / billige / dyre timer — eller «lærer».
// Elpris timeprofil rang            1–24 (1 = plejer at være billigst).
// Elpris timeprofil døgn            00:00–06:00 blandt dagens billige timer · …
// Elpris timeprofil dage            Afsluttede døgn brugt til denne time.
// Elpris læring datagrundlag        Fx «2 af 3 døgn · mangler 1» eller «3 afsluttede døgn (nok til mønster)».
// Elpris læring modenhed (%)        0–100. 100 = mindst TIMEPROFIL_MIN_DAGE afsluttede døgn. 67 = 2 af 3.
//
// 🛠 DRIFT
// Elpris opdateret
// Elpris fejl / fejlkode
// Elpris systemstatus               🟢 OK / 🟡 Advarsel / 🔴 Fejl
// Elpris systemstatus detalje       API/tarif/data med ms, i morgen, siden sidst, Homey, kørsel, tags.
// Elpris sidste kørsel (ms)         Hele scriptet denne kørsel (API + beregning + Homey).
// Elpris API (ms)                   Energidataservice / Datahub.
// Elpris beregning (ms)             Indeks, fold, læring, grafforberedelse.
// Elpris tags ændret                Antal tags skrevet (værdi ændret).
// Elpris tags uændret               Tags i denne kørsel der allerede havde samme værdi.
// Elpris datakvalitet OK
// Elpris datakvalitet optimering OK
// Elpris datakvalitet
// Elpris ændring / har ændring      Menneske-tekst / bool (prisændring kr/% er til Flow).
// Elpris speak / speak periode
// Graf farver / Graf URL / Graf i morgen URL  — kun på enheden.
//
//-----------------------------------------------------------------------------------------//

//---------------------------- FEJLKATALOG ---------------------------------------//
// Tidslinjen:  Elpris ⚡ A-101: <kort>
// Slå koden op her. niveau: stop = kørslen afbrydes, fallback = fortsætter med reserve.
//
// ⚡ A DayAhead          🔌 B Net/Energinet       🧩 C Datakvalitet
// 📅 D Historik/uge      🏠 E Homey-miljø         ⚙️ F Flow-argument
//
// A-101 tomt svar          A-102 HTTP/timeout/429     A-103 for få kvarter
// A-104 API slutter før nu A-105 kan ikke læses       A-106 mangler nu-kvarter
// A-107 ugyldigt område    A-108 i morgen udeblev
// B-201 net-API            B-202 ingen aktiv nettarif B-203 Energinet-API
// B-204 mangler sys/trans  B-205 ukendt net-GLN       B-206 tom Energinet-liste
// B-207 ukendt netselskab
// C-301 huller i data
// D-401 historiske tariffer D-402 historiske elpriser
// E-501 ingen fetch         E-503 Homey-ur            E-504 virtuel enhed
// F-601 ugyldigt argument   F-602 ugyldig indstilling
//
const FEJLGRUPPER = {
  A: { symbol: "⚡", navn: "DayAhead" },
  B: { symbol: "🔌", navn: "Net/Energinet" },
  C: { symbol: "🧩", navn: "Datakvalitet" },
  D: { symbol: "📅", navn: "Historik/uge" },
  E: { symbol: "🏠", navn: "Homey-miljø" },
  F: { symbol: "⚙️", navn: "Flow-argument" }
};
const FEJLKATALOG = {
  "A-101": {
    niveau: "stop",
    kort: "Ingen elpriser fra Energidataservice.",
    lang: "DayAheadPrices returnerede 0 kvarter. Scriptet stopper. Tjek PriceArea (DK1/DK2), om markedet har publiceret (i morgen typisk efter kl. 13), og om Homey har internet."
  },
  "A-102": {
    niveau: "stop",
    kort: "Elpris-API svarede ikke (net, timeout eller 429).",
    lang: "HTTP-fejl, timeout eller for mange kald (429) mod DayAheadPrices. Scriptet stopper og prøver næste kørsel. Ved 429: kør flowet sjældnere, typisk ét kvarter."
  },
  "A-103": {
    niveau: "stop",
    kort: "For få fremtidige kvarter til den ønskede periode.",
    lang: "Der er færre kvarter foran os end AntalTimer i flow-argumentet. Sker ofte sent på dagen, før i morgen er publiceret, eller ved huller i API. Scriptet stopper."
  },
  "A-104": {
    niveau: "stop",
    kort: "Sidste elpris-kvarter ligger før nu.",
    lang: "API'et har ingen priser fra indeværende kvarter og frem. Scriptet stopper, så flows ikke kører på tomt søgevindue. Tjek ur og om DayAhead er ude."
  },
  "A-105": {
    niveau: "stop",
    kort: "Elpris-rækkerne kunne ikke læses som kvarter.",
    lang: "TimeUTC/TimeDK eller SpotPriceDKK mangler eller er ugyldig, så 15-minutters slots ikke kan bygges. Scriptet stopper. Tjek API-format og PriceArea."
  },
  "A-106": {
    niveau: "stop",
    kort: "Mangler elpris for det kvarter, klokken er i nu.",
    lang: "Listen er læst, men indeværende kvarter findes ikke. Kan være hul i data eller forkert Homey-ur. Scriptet stopper."
  },
  "A-107": {
    niveau: "stop",
    kort: "Ugyldigt elspot-område.",
    lang: "PriceArea skal være DK1 (vest) eller DK2 (øst). Scriptet stopper, så der ikke hentes priser for et tomt eller forkert område."
  },
  "A-108": {
    niveau: "fallback",
    kort: "Elpriser for i morgen er ikke kommet.",
    lang: "Efter kl. 14 dansk tid mangler et komplet i-morgen-døgn stadig. Day-ahead er normalt ude omkring kl. 13. Scriptet kører videre med i dag. Tjek Energidataservice og «I morgen klar»."
  },
  "B-201": {
    niveau: "fallback",
    kort: "Nettarif-API fejlede. Bruger fallback.",
    lang: "DatahubPricelist for NETSELSKAB (GLN) svarede ikke. Prisen bruger de manuelle Pris_Lavlast / Pris_Hojlast / Pris_Spids indtil API virker. Tjek net og GLN."
  },
  "B-202": {
    niveau: "fallback",
    kort: "Ingen aktiv husholdnings-nettarif. Bruger fallback.",
    lang: "GLN findes i Datahub, men ingen gyldig D03-tarif for C-kunder i dag (fx CD). Tjek NETSELSKAB og at tariffen ikke er udløbet. Manuelle satser bruges."
  },
  "B-203": {
    niveau: "fallback",
    kort: "Energinet-API fejlede. Bruger fallback.",
    lang: "Datahub for ENERGINET_GLN svarede ikke. Scriptet bruger ENERGINET_TARIF_INKL_MOMS indtil API virker."
  },
  "B-204": {
    niveau: "fallback",
    kort: "Mangler Energinet system- eller transmissionstarif. Bruger fallback.",
    lang: "Datahub har rækker, men ikke både «Systemtarif» og «Transmissions nettarif» med gyldig periode for i dag. Manuel ENERGINET_TARIF_INKL_MOMS bruges."
  },
  "B-205": {
    niveau: "fallback",
    kort: "Ingen nettariffer for dette GLN. Bruger fallback.",
    lang: "Datahub returnerede ingen D03-rækker for NETSELSKAB. Tjek at det 13-cifrede GLN er rigtigt (N1 Silkeborg = 5790001089030). Manuelle satser bruges."
  },
  "B-206": {
    niveau: "fallback",
    kort: "Ingen Energinet-tariffer i Datahub. Bruger fallback.",
    lang: "Datahub returnerede ingen D03-rækker for ENERGINET_GLN (5790000432752). Manuel ENERGINET_TARIF_INKL_MOMS bruges."
  },
  "B-207": {
    niveau: "fallback",
    kort: "Ukendt netselskab. Bruger fallback.",
    lang: "NETSELSKAB_VALG matcher ikke kataloget og er ikke et 13-cifret GLN. Nettarif hentes ikke fra Datahub; de manuelle Pris_Lavlast / Pris_Hojlast / Pris_Spids bruges. Ret navnet eller indsæt GLN."
  },
  "C-301": {
    niveau: "fallback",
    kort: "Huller i elpris-data. Optimering er slået fra.",
    lang: "Der mangler kvarter eller er spring i rækkefølgen. Anbefalet og absolut periode beregnes ikke, før døgnet hænger sammen. Pris nu og tags kan stadig opdateres."
  },
  "D-401": {
    niveau: "fallback",
    kort: "Historiske tariffer til uge-snit fejlede.",
    lang: "Ekstra Datahub-kald til historiske net/Energinet-perioder fejlede (timeout, 429 eller HTTP). Uge-snittet bruger sidste kendte tarif-timeline eller nutidens tariffer. Pris nu er upåvirket. Scriptet prøver igen senere, ikke hvert kvarter."
  },
  "D-402": {
    niveau: "fallback",
    kort: "Historiske elpriser til uge-snit fejlede.",
    lang: "DayAhead til uge-snit kunne ikke hentes (timeout, 429 eller HTTP). Scriptet bruger kvarter fra den almindelige pris-hentning, når de dækker ugen, ellers sidste kendte snit og prøver API igen senere. Pris nu og periodesøgning er upåvirket."
  },
  "E-501": {
    niveau: "stop",
    kort: "Ingen fetch i dette Homey-miljø.",
    lang: "Hverken Homey.fetch eller global fetch findes. Scriptet kan ikke kalde API'er. Kør det som HomeyScript, ikke i et miljø uden netværk."
  },
  "E-503": {
    niveau: "fallback",
    kort: "Homey-uret kunne ikke opdateres.",
    lang: "createAlarm, updateAlarm eller getAlarm fejlede. Elpris-beregningen kører videre. Tjek at ELPRIS_ALARM_NAVN findes, og at Homey.alarms er tilgængelig."
  },
  "E-504": {
    niveau: "fallback",
    kort: "Kunne ikke skrive til den virtuelle enhed.",
    lang: "Et felt der FINDES på Elpris-enheden kunne ikke opdateres (fx Device Capabilities afviste værdien). Manglende capabilities er ikke en fejl — de udgives som tags. Priser og resten af enheden kører videre."
  },
  "F-601": {
    niveau: "stop",
    kort: "Ugyldigt flow-argument.",
    lang: "Argumentet skal være AntalTimer,Timespan (fx 4,24). To tal, komma imellem, AntalTimer ≤ Timespan, Timespan max 24, begge > 0. Uden argument bruges 2,16."
  },
  "F-602": {
    niveau: "stop",
    kort: "Ugyldig indstilling i toppen af scriptet.",
    lang: "En bruger-indstilling er tom, har forkert type eller er ulogisk (fx negativ tarif eller TIDSZONE der ikke er Europe/Copenhagen/Auto). Scriptet stopper. Se detaljen i loggen og ret konstanten."
  }
};

//-------------------------- SLUT KONSTANTER ----------------------------------------------//

return await (async () => {

  // Hent state fra HomeyScripts permanente hukommelse
  let state = {};
  if (typeof global !== 'undefined' && typeof global.get === 'function') {
    state = global.get('__elprisState') || {};
  } else {
    state = globalThis.__elprisState || {};
  }

  const lastTagsSnapshot = Object.keys((state.lastTags && typeof state.lastTags === "object") ? state.lastTags : {});

  // Cache-lag (Homey-skånsom):
  //   settingsCache  — parset konfig, indtil signature (args + konstanter) skifter
  //   priceCache     — day-ahead, indtil den er forældet eller i morgen mangler
  //   tariffCache    — net/Energinet, indtil gyldighed udløber
  //   weekAvg        — uge-snit fra allerede hentede day-ahead (sidste ISO-uge med i pris-kaldet)
  //   priceNorm / hourProfile — læring, kun når et nyt døgn er komplet
  //   lastTags / enhed — kun skriv når værdien er ændret
  //   log            — INFO kompakt blok; DEBUG dump; TRACE spor af cache/API/søgning
  //   quarterIndex   — ét gennemløb: dage, huller, pris nu, søgevindue; fold kun udsnit
  // Ikke cache: klokkeslæt, pris nu, periodesøgning, i-morgen-status, dynamiske tags.

  // Tvinger en engangs-nulstilling af cachen for at rydde op i gamle 'Time Travel' data
  let cacheWasReset = false;
  if (state.cacheVersion !== 12) {
    state.priceCache = {};
    state.tariffCache = {};
    state.weekAvg = {};
    if (!AFINSTALLER) state.lastTags = {};
    state.chartUrls = {};
    state.cacheVersion = 12;
    cacheWasReset = true;
  } else {
    state.priceCache ??= {};
    state.tariffCache ??= {};
    state.weekAvg ??= {};
    state.priceNorm ??= {};
    state.hourProfile ??= {};
    state.lastTags ??= {};
    state.chartUrls ??= {};
    state.grafIDag ??= {};
    state.grafIMorgen ??= {};
    state.settingsCache ??= null;
  }

  let cacheStateDirty = false;
  const currentRunErrors = [];
  const healthCtx = {
    prevRunAt: Number(state.lastRunAt) || 0,
    hadPrices: false,
    dataQuality: null,
    iMorgenKlar: null,
    gridApi: null,
    energinetApi: null,
    clockHour: null
  };

  function persistCacheState() {
    if (typeof global !== 'undefined' && typeof global.set === 'function') {
      global.set('__elprisState', state);
    } else {
      globalThis.__elprisState = state;
    }
  }

  // Marker state som ændret. Homey global.set kaldes én gang via flushCacheState.
  function saveCacheState() {
    cacheStateDirty = true;
  }

  if (AFINSTALLER) {
    const names = {};
    const add = k => {
      if (k) names[k] = true;
    };
    for (let i = 0; i < TAGS_ALLE.length; i++) add(TAGS_ALLE[i]);
    for (let i = 0; i < lastTagsSnapshot.length; i++) add(lastTagsSnapshot[i]);
    const last = state.lastTags || {};
    const lastKeys = Object.keys(last);
    for (let i = 0; i < lastKeys.length; i++) add(lastKeys[i]);
    const keys = Object.keys(names);
    let ok = 0;
    for (let i = 0; i < keys.length; i++) {
      try {
        if (typeof tag !== "undefined") await tag(keys[i], null);
        ok++;
      } catch (_) {}
    }
    if (typeof global !== "undefined" && typeof global.set === "function") {
      global.set("__elprisState", {});
    } else {
      globalThis.__elprisState = {};
    }
    log(
      "Afinstallering færdig: " +
        ok +
        " HomeyScript-tags fjernet. Sæt AFINSTALLER = false. Den virtuelle enhed slettes ikke."
    );
    return true;
  }

  function flushCacheState() {
    if (!cacheStateDirty) return;
    persistCacheState();
    cacheStateDirty = false;
  }

  function fejlGruppe(kode) {
    const letter = String(kode || "").charAt(0);
    return FEJLGRUPPER[letter] || { symbol: "⚠️", navn: "Ukendt" };
  }

  function fejlKodeLabel(kode) {
    return fejlGruppe(kode).symbol + " " + kode;
  }

  function katalogKort(kode) {
    const e = FEJLKATALOG[kode];
    return e && e.kort ? e.kort : "Ukendt fejlkode — tilføj den i FEJLKATALOG.";
  }

  function reportFejl(kode, detalje) {
    if (currentRunErrors.indexOf(kode) < 0) currentRunErrors.push(kode);
    log(`${fejlKodeLabel(kode)}  ${katalogKort(kode)}` + (detalje ? ` (${detalje})` : ""));
  }

  async function sendTimeline(text) {
    try {
      if (typeof Homey !== "undefined" && Homey.flow && Homey.flow.runFlowCardAction) {
        await Homey.flow.runFlowCardAction({
          uri: "homey:manager:notifications",
          id: "homey:manager:notifications:create_notification",
          args: { text }
        });
      }
    } catch (err) {
      logTrace("Kunne ikke sende tidslinje: " + err.message);
    }
  }

  async function flushTimelineErrors() {
    const prev = state.timelineErrorCodes || {};
    const next = {};
    for (let i = 0; i < currentRunErrors.length; i++) next[currentRunErrors[i]] = true;
    const nye = currentRunErrors.filter(kode => !prev[kode]);
    state.timelineErrorCodes = next;
    state.apiErrorActive = currentRunErrors.length > 0;
    saveCacheState();
    if (!nye.length) {
      if (Object.keys(prev).length && !currentRunErrors.length) {
        logTrace("🟢 Fejltilstand nulstillet (ingen tidslinje).");
      }
      return;
    }
    const text = "Elpris " + nye.map(kode => `${fejlKodeLabel(kode)}: ${katalogKort(kode)}`).join(" · ");
    await sendTimeline(text);
    log("🔔 Tidslinje: " + text);
  }

  async function finishRun(value) {
    await flushTimelineErrors();
    await updateErrorTags();
    flushCacheState();
    return value;
  }

  if (cacheWasReset) saveCacheState();

  // 🧹 Skraldemand: Rydder op i gamle pris-cacher, så hukommelsen ikke løber løbsk
  function cleanUpCache() {
    const now = Date.now();
    const maxAge = 72 * 60 * 60 * 1000; // Behold day-ahead over en længere strømafbrydelse
    let cleaned = false;

    for (const key of Object.keys(state.priceCache)) {
      const entry = state.priceCache[key];
      if (!entry.cachedAt || (now - entry.cachedAt > maxAge)) {
        delete state.priceCache[key];
        cleaned = true;
      }
    }

    if (cleaned) {
      saveCacheState();
      logTrace("🧹 Skraldemand har ryddet op i forældede data i cachen.");
    }
  }
  cleanUpCache();

  // Sikker wrapper til logning
  if (typeof log === 'undefined') {
    // eslint-disable-next-line no-var
    var log = function (msg) { console.log(msg); };
  }

  // Sikker fetch (Homey.fetch hvis findes, ellers global fetch)
  const safeFetch =
    (typeof Homey !== 'undefined' && Homey.fetch) ? Homey.fetch :
    (typeof fetch !== 'undefined') ? fetch :
    null;

  if (typeof safeFetch !== 'function') {
    reportFejl("E-501");
    return await finishRun(false);
  }

  let FetchedGridTariff = null;
  let FetchedEnerginetTariff = null;
  const missingTariffKeysLogged = {};

  // -------------- ARGUMENTS / INDSTILLINGER -------------
  // Kun parset config. Tid, elpris, API og dynamiske beregninger caches ikke her.
  const scriptArgs = (typeof args !== 'undefined') ? args : null;
  const settingsSig = settingsSignature(rawScriptArgsKey(scriptArgs));
  let ArgsAntalTimer;
  let ArgsTimespan;
  let priceAreaNorm;
  let waitLimit;
  let settingsCacheHit = false;
  try {
    if (settingsCacheValid(settingsSig)) {
      settingsCacheHit = true;
      const v = state.settingsCache.values;
      ArgsAntalTimer = v.ArgsAntalTimer;
      ArgsTimespan = v.ArgsTimespan;
      priceAreaNorm = v.priceAreaNorm;
      waitLimit = v.waitLimit;
    } else {
      const v = buildSettingsValues(scriptArgs);
      ArgsAntalTimer = v.ArgsAntalTimer;
      ArgsTimespan = v.ArgsTimespan;
      priceAreaNorm = v.priceAreaNorm;
      waitLimit = v.waitLimit;
      state.settingsCache = { signature: settingsSig, values: v };
      saveCacheState();
    }
    logTrace(
      settingsCacheHit
        ? `Settings-cache hit · ${ArgsAntalTimer},${ArgsTimespan} t · ${priceAreaNorm}`
        : `Settings-cache miss · parser ${ArgsAntalTimer},${ArgsTimespan} t · ${priceAreaNorm}`
    );
  } catch (e) {
    const kode = e && e.elprisKode;
    if (kode === "F-602" || kode === "A-107") reportFejl(kode, e.message);
    else reportFejl("F-601", e && e.message);
    return await finishRun(false);
  }

  if (!NETSELSKAB_VALG_OK) {
    reportFejl("B-207", String(NETSELSKAB_VALG || "").trim() || "(tom)");
  }

  // Dansk tid
  const DatoNuStartpoint = getDKTime();
  healthCtx.clockHour = copenhagenParts(DatoNuStartpoint).hour;

  const needGridFetch = AUTO_FETCH_TARIFF && NETSELSKAB_VALG_OK && !isLiveGridCacheValid(DatoNuStartpoint);
  const needEnerginetFetch = AUTO_FETCH_ENERGINET && !isLiveEnerginetCacheValid(DatoNuStartpoint);

  const tStart = Date.now();
  const withMs = async (p) => {
    const t0 = Date.now();
    const value = await p;
    return { value, ms: Date.now() - t0 };
  };
  const [elTimed, gridTimed, enTimed] = await Promise.all([
    withMs(fetchPricesFromApi(priceAreaNorm)),
    withMs(needGridFetch ? fetchGridTariffFromApi(NETSELSKAB) : Promise.resolve(undefined)),
    withMs(needEnerginetFetch ? fetchEnerginetTariffFromApi() : Promise.resolve(undefined))
  ]);
  const tAfterApi = Date.now();
  const Elpriser = elTimed.value;
  const gridFetchResult = gridTimed.value;
  const energinetFetchResult = enTimed.value;
  healthCtx.msPrices = elTimed.ms;
  healthCtx.msGrid = gridTimed.ms;
  healthCtx.msEnerginet = enTimed.ms;
  healthCtx.gridCached = !needGridFetch;
  healthCtx.energinetCached = !needEnerginetFetch;

  const records = (Elpriser && Array.isArray(Elpriser.records)) ? Elpriser.records : [];
  if (records.length === 0) {
    log("ℹ️ Afbryder scriptet pænt, da der ikke er nogle elpriser at regne på for dags dato.");
    if (currentRunErrors.length === 0) reportFejl("A-101");
    return await finishRun(false);
  }

  const durationSlots = ArgsAntalTimer * 4;
  let timespanSlots = ArgsTimespan * 4;

  // ----- FORBEREDE SØGEVINDUE OG VALIDERE DATA -----
  const TimeNuStartpoint = floorToQuarter(DatoNuStartpoint);
  const TimeNuMs = TimeNuStartpoint.getTime();
  const DatoNuMs = DatoNuStartpoint.getTime();
  const minutesIntoSlot = copenhagenParts(DatoNuStartpoint).minute % 15;
  const remainingInSlot = 15 - minutesIntoSlot || 15;

  // Inkluder indeværende kvarter, så "start nu" kan vinde.
  // Spring kun til næste kvarter hvis der er under 2 minutter tilbage at handle i.
  const SearchStartpoint = new Date(TimeNuStartpoint.getTime());
  if (remainingInSlot <= 2) {
    SearchStartpoint.setTime(SearchStartpoint.getTime() + 15 * 60 * 1000);
  }
  const SearchStartMs = SearchStartpoint.getTime();

  const lastRec = records[records.length - 1];
  const lastApiDate = slotInstantFromRecord(lastRec) || toDKDate(lastRec.HourDK);
  if (SearchStartpoint > lastApiDate) {
    log(`⚠️ API mangler fremtidige data. Sidste tilgængelige kvarter: ${formatClock(lastApiDate)}. Afbryder lydløst for at undgå flow-crash.`);
    reportFejl("A-104", formatClock(lastApiDate));
    return await finishRun(false);
  }

  if (AUTO_FETCH_TARIFF) {
    if (!needGridFetch && state.tariffCache.grid) {
      FetchedGridTariff = state.tariffCache.grid;
      logTrace(`Bruger cached lokal nettarif (${formatValidityWindow(state.tariffCache.gridMeta)})`);
    } else if (gridFetchResult && gridFetchResult.tariff) {
      FetchedGridTariff = gridFetchResult.tariff;
      state.tariffCache.grid = FetchedGridTariff;
      state.tariffCache.gridMeta = gridFetchResult.meta;
      state.tariffCache.gln = NETSELSKAB;
      saveCacheState();
    } else if (state.tariffCache && state.tariffCache.grid) {
      FetchedGridTariff = state.tariffCache.grid;
      log("ℹ️ Net-API fejlede — bruger sidst gemte nettarif (fx efter strømafbrydelse).");
    } else {
      log("⚠️ Advarsel: Kunne ikke hente lokal nettarif fra API. Falder tilbage til manuelle satser.");
    }
  } else {
    logTrace("ℹ️ AUTO_FETCH_TARIFF er slået fra. Bruger manuelle nettariffer.");
  }

  if (AUTO_FETCH_ENERGINET) {
    if (!needEnerginetFetch && typeof state.tariffCache.energinet === "number") {
      FetchedEnerginetTariff = state.tariffCache.energinet;
      logTrace(`Bruger cached Energinet tarif (${formatValidityWindow(state.tariffCache.energinetMeta)})`);
    } else if (energinetFetchResult && typeof energinetFetchResult.inkl === "number") {
      FetchedEnerginetTariff = energinetFetchResult.inkl;
      state.tariffCache.energinet = FetchedEnerginetTariff;
      state.tariffCache.energinetMeta = energinetFetchResult.meta;
      saveCacheState();
    } else if (state.tariffCache && typeof state.tariffCache.energinet === "number") {
      FetchedEnerginetTariff = state.tariffCache.energinet;
      log("ℹ️ Energinet-API fejlede — bruger sidst gemte tarif (fx efter strømafbrydelse).");
    } else {
      log(`⚠️ Advarsel: Energinet API returnerede ikke en tarif. Falder tilbage til manuel sats på ${ENERGINET_TARIF_INKL_MOMS} kr.`);
    }
  } else {
    logTrace(`ℹ️ AUTO_FETCH_ENERGINET er slået fra. Bruger manuel Energinet tarif: ${ENERGINET_TARIF_INKL_MOMS} kr.`);
  }
  healthCtx.gridApi = Boolean(FetchedGridTariff);
  healthCtx.energinetApi = typeof FetchedEnerginetTariff === "number";

  // ----- FORBERED DATA -----
  // Ét kvarter = én prisstruktur (buildQuarter): day/hour/minute/timestampMs caches,
  // så senere løkker ikke kalder copenhagenParts igen. Derefter ét indeks.
  const processedRecords = records.map(r => {
    const instant = slotInstantFromRecord(r);
    return buildQuarter(
      r.SpotPriceDKK / 1000,
      instant || toDKDate(r.HourDK),
      FetchedGridTariff,
      FetchedEnerginetTariff
    );
  }).filter(q => isValidDate(q.timestamp));
  processedRecords.sort((a, b) => a.timestampMs - b.timestampMs);
  logTrace(`Kvarter bygget: ${processedRecords.length} (fra ${records.length} API-rækker)`);

  if (!processedRecords.length) {
    reportFejl("A-105");
    return await finishRun(false);
  }

  const idagStr = copenhagenDayKey(DatoNuStartpoint);
  const quarterIndex = buildQuarterIndex(processedRecords);

  const futureSlots = processedRecords.length - quarterIndex.searchFrom;
  if (futureSlots < durationSlots) {
    const errorDetails = `FutureSlots:${futureSlots}, Records:${processedRecords.length}`;
    reportFejl("A-103", errorDetails);
    log(`⚠️ For få fremtidige kvarter (${errorDetails}). Afbryder lydløst.`);
    return await finishRun(false);
  }

  if (futureSlots < timespanSlots) {
    log(`ℹ️ API har kun ${futureSlots} kvarter (${(futureSlots / 4).toFixed(1)} t). Reducerer søgevinduet fra ${ArgsTimespan} t til ${(futureSlots / 4).toFixed(1)} t.`);
    timespanSlots = futureSlots;
    ArgsTimespan = Number((futureSlots / 4).toFixed(2)); // kun denne kørsel — ikke settingsCache
    fillTimespanStats(quarterIndex, processedRecords, timespanSlots);
  }

  const dataQuality = analyzeQuarterQuality(DatoNuStartpoint);
  healthCtx.hadPrices = true;
  healthCtx.dataQuality = dataQuality;
  if (dataQuality.issues.length) {
    log(`⚠️ Datakvalitet: ${dataQuality.issues.join(" · ")}`);
  }
  if (!dataQuality.safeForOptimization) {
    reportFejl("C-301", dataQuality.issues.join(" · "));
  }

  const folded = foldQuarterStats(processedRecords);
  if (!folded.ok) {
    log("⚠️ Kunne ikke finde pris for nuværende kvarter i dataene. Afbryder lydløst.");
    reportFejl("A-106");
    return await finishRun(false);
  }

  const dagStat = folded.dagStat;
  const timespanStat = folded.timespanStat;
  const PrisLigeNu = folded.PrisLigeNu;
  const prisNu = folded.prisNu;
  const BilligPrisMinForskelOre = folded.BilligPrisMinForskelOre;
  const speakData = folded.speakData;
  const naesteZoneFromFold = folded.naesteZone;
  const rangIDagFolded = folded.rangIDag;

  const DagensGennemsnitKontraNu =
    Number(((PrisLigeNu - dagStat.gennemsnit) * 100).toFixed(0));
  const TimespanGennemsnitKontraNu =
    Number(((PrisLigeNu - timespanStat.gennemsnit) * 100).toFixed(0));

  // ---- Speak: dagen ----
  let Speak_GenerelRapport = `Strømmen koster lige nu ${formatSpeechPrice(PrisLigeNu)}, og er `;
  if (DagensGennemsnitKontraNu < 0) {
    Speak_GenerelRapport += `${formatOreAmount(DagensGennemsnitKontraNu)} billigere end dagens gennemsnit på ${formatSpeechPrice(dagStat.gennemsnit)}. `;
  } else if (DagensGennemsnitKontraNu > 0) {
    Speak_GenerelRapport += `${formatOreAmount(DagensGennemsnitKontraNu)} dyrere end dagens gennemsnit på ${formatSpeechPrice(dagStat.gennemsnit)}. `;
  } else {
    Speak_GenerelRapport += `præcis magen til dagens gennemsnit på ${formatSpeechPrice(dagStat.gennemsnit)}. `;
  }
  Speak_GenerelRapport += `Dagens priser varierer fra ${formatSpeechPrice(dagStat.billigstKR)} til ${formatSpeechPrice(dagStat.dyrestKR)}. `;

  if (DagensGennemsnitKontraNu < 0) {
    if (speakData.billigTilKL != null) {
      Speak_GenerelRapport += `Strømmen er billig til kl. ${formatClockHM(speakData.billigTilKL, speakData.billigTilMIN)}.`;
    } else {
      Speak_GenerelRapport += `Strømmen bliver ikke dyr de næste ${(futureSlots / 4).toFixed(0)} timer.`;
    }
  } else {
    if (speakData.naesteBilligKL != null) {
      Speak_GenerelRapport += `Strømmen bliver billigere end gennemsnittet kl. ${formatClockHM(speakData.naesteBilligKL, speakData.naesteBilligMIN)}`;
      if (speakData.allerBilligstKL != null &&
          (speakData.allerBilligstKL !== speakData.naesteBilligKL ||
           speakData.allerBilligstMIN !== speakData.naesteBilligMIN)) {
        Speak_GenerelRapport += `, men er allerbilligst kl. ${formatClockHM(speakData.allerBilligstKL, speakData.allerBilligstMIN)}, hvor den koster ${formatSpeechPrice(speakData.allerBilligstKR)}.`;
      } else {
        Speak_GenerelRapport += `.`;
      }
    } else {
      Speak_GenerelRapport += `Strømmen bliver ikke billig i løbet af de næste ${ArgsTimespan} timer.`;
    }
  }

  // ---- Speak: perioden ----
  const runNow = runCostPerKw(DatoNuStartpoint, ArgsAntalTimer);
  maybeSnapAnbefaletForAutoWait(timespanStat, runNow);
  const fandtPeriode = isWindowFound(timespanStat.anbefalet);
  const fandtAbsolut = isWindowFound(timespanStat.absolut);
  if (!fandtPeriode) timespanStat.anbefalet = emptyWindowResult(true);
  if (!fandtAbsolut) timespanStat.absolut = emptyWindowResult(true);

  const anbefalet = derivePeriodStats(timespanStat.anbefalet, fandtPeriode, runNow);
  const absolut = derivePeriodStats(timespanStat.absolut, fandtAbsolut, runNow);
  const startErNu = anbefalet.startErNu;
  const korselNu = anbefalet.korselNu;
  const snitFraNuKR = runNow.avg;
  const besparelseVedOptimalKR = anbefalet.besparelse;
  const ventetidTilOptimalTimer = anbefalet.ventetid;
  const besparelseVedOptimalPct = anbefalet.pct;
  const besparelsePrVentetimeKR = anbefalet.prVentetime;
  const periodeSlut = anbefalet.slut;
  const autoVent = autoVentForklaring(runNow, absolut, fandtAbsolut, startErNu || korselNu);
  const venteRaad = besparelseVenteRaad({
    found: fandtPeriode,
    startErNu,
    korselNu,
    ventetid: ventetidTilOptimalTimer,
    sparKrKw: besparelseVedOptimalKR,
    autoTekst: autoVent.lang
  });
  const sparePotentiale = besparelsesPotentiale({
    found: fandtPeriode,
    startErNu,
    korselNu,
    prisNu: PrisLigeNu,
    bedstSnit: anbefalet.snit,
    sparKrKw: besparelseVedOptimalKR,
    ventetid: ventetidTilOptimalTimer
  });
  const naesteZone = naesteZoneFromFold;
  const zoneSlut = zoneEndParts(naesteZone);
  const iBilligZone = Boolean(
    naesteZone &&
    TimeNuMs >= naesteZone.start.timestampMs &&
    TimeNuMs < naesteZone.last.timestampMs + 15 * 60 * 1000
  );
  const anbefaletErAbsolut = Boolean(
    fandtPeriode && fandtAbsolut &&
    timespanStat.anbefalet.startDato &&
    timespanStat.absolut.startDato &&
    timespanStat.anbefalet.startDato.getTime() === timespanStat.absolut.startDato.getTime()
  );

  let Speak_FundneTimerRapport;
  if (!fandtPeriode) {
    Speak_FundneTimerRapport =
      `Jeg har undersøgt de næste ${ArgsTimespan} timer, men kunne ikke finde ${ArgsAntalTimer} sammenhængende timer med priser. ` +
      `Strømmen koster lige nu ${formatSpeechPrice(PrisLigeNu)}.`;
  } else {
    const startTekst = startErNu
      ? "Tiden skal starte nu"
      : `Tiden starter kl. ${formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN)}`;
    Speak_FundneTimerRapport =
      `Jeg har undersøgt de næste ${ArgsTimespan} timer og fundet en anbefalet periode på ${ArgsAntalTimer} timer. ` +
      `${startTekst} og har en pris mellem ${formatSpeechPrice(timespanStat.anbefalet.billigstKR)} og ${formatSpeechPrice(timespanStat.anbefalet.dyrestKR)}. ` +
      `Strømmen koster lige nu ${formatSpeechPrice(PrisLigeNu)}, og er `;

    if (TimespanGennemsnitKontraNu < 0) {
      Speak_FundneTimerRapport += `${formatOreAmount(TimespanGennemsnitKontraNu)} billigere end periodens gennemsnit på ${formatSpeechPrice(timespanStat.gennemsnit)}.`;
    } else if (TimespanGennemsnitKontraNu > 0) {
      Speak_FundneTimerRapport += `${formatOreAmount(TimespanGennemsnitKontraNu)} dyrere end periodens gennemsnit på ${formatSpeechPrice(timespanStat.gennemsnit)}.`;
    } else {
      Speak_FundneTimerRapport += `præcis magen til periodens gennemsnit på ${formatSpeechPrice(timespanStat.gennemsnit)}.`;
    }
  }

  logTrace("Speak: " + Speak_GenerelRapport);
  logTrace("Speak periode: " + Speak_FundneTimerRapport);

  // ---- TAGS ----
  const iMorgenParts = copenhagenParts(DatoNuStartpoint);
  const iMorgenDate = new Date(Date.UTC(iMorgenParts.year, iMorgenParts.month - 1, iMorgenParts.day + 1, 12, 0, 0));
  const morgenStat = statsForDateString(copenhagenDayKey(iMorgenDate));
  const iMorgenKlar = isCompleteLocalDay(processedRecords, iMorgenDate);
  healthCtx.iMorgenKlar = Boolean(iMorgenKlar);
  const nuDele = copenhagenParts(DatoNuStartpoint);
  if (!iMorgenKlar && nuDele.hour >= 14) {
    reportFejl("A-108");
  }
  const rangIDag = rangIDagFolded;
  const grafFarverIDag = colorBarsForDay(idagStr, TimeNuStartpoint);
  const iMorgenDayKey = copenhagenDayKey(iMorgenDate);
  let grafIDagUrl = "-";
  let grafIMorgenUrl = "-";
  if (GRAF_URL) {
    const charts = await Promise.all([
      chartUrlForToday(idagStr, nuDele.hour, TimeNuStartpoint),
      iMorgenKlar
        ? chartUrlForTomorrow(iMorgenDayKey)
        : Promise.resolve("-")
    ]);
    grafIDagUrl = charts[0];
    grafIMorgenUrl = charts[1];
  }

  let weekAvgs = { lastWeekAvg: 0, thisWeekAvg: 0, thisWeekCount: 0 };
  try {
    weekAvgs = await getWeekAverages();
  } catch (e) {
    reportFejl("D-402", e && e.message);
    weekAvgs = { lastWeekAvg: 0, thisWeekAvg: 0, thisWeekCount: 0 };
  }
  const statusNorm = learnPriceNorm(weekAvgs);
  const hourProfil = learnHourProfile();
  const vsTypisk = vsTypiskFraBaseline(PrisLigeNu, statusNorm.baseline);
  const statusRangIDag = prisStatusFraRang(rangIDag);
  const statusPeriode = prisStatusFraPeriode(PrisLigeNu, statusNorm.baseline, statusNorm.bands);
  const statusNu = STATUS_VS_PERIODE && statusPeriode ? statusPeriode : statusRangIDag;
  const tAfterCalc = Date.now();

  const netKildeNu = FetchedGridTariff ? "API" : "fallback";
  const enKildeNu = (typeof FetchedEnerginetTariff === "number") ? "API" : "fallback";
  const currentProfile = {
    lastPriceNow: roundPrice(PrisLigeNu),
    lastStatus: statusNu,
    lastOptimalPeriod: {
      found: Boolean(fandtPeriode),
      startKL: Number(timespanStat.anbefalet.startKL ?? -1),
      startMIN: Number(timespanStat.anbefalet.startMIN || 0),
      startTekst: fandtPeriode
        ? formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN)
        : "-",
      startNu: Boolean(startErNu),
      length: Number(ArgsAntalTimer)
    },
    lastDay: {
      date: fmtYmd(DatoNuStartpoint),
      gennemsnit: roundPrice(dagStat.gennemsnit),
      billigstKR: roundPrice(dagStat.billigstKR),
      billigstTekst: formatClockHM(dagStat.billigstKL, dagStat.billigstMIN),
      dyrestKR: roundPrice(dagStat.dyrestKR),
      dyrestTekst: formatClockHM(dagStat.dyrestKL, dagStat.dyrestMIN)
    },
    lastTomorrowReady: Boolean(iMorgenKlar),
    lastTariffSource: `${netKildeNu}/${enKildeNu}`
  };
  const prevProfile = {
    lastPriceNow: state.lastPriceNow,
    lastStatus: state.lastStatus,
    lastOptimalPeriod: state.lastOptimalPeriod,
    lastDay: state.lastDay,
    lastTomorrowReady: state.lastTomorrowReady,
    lastTariffSource: state.lastTariffSource
  };
  const profileChanges = collectProfileChanges(prevProfile, currentProfile);
  const aendringTekst = profileChanges.map(c => c.text).join(" ");
  let prisAendringKr = 0;
  let prisAendringPct = 0;
  const prevPris = prevProfile.lastPriceNow;
  if (typeof prevPris === "number" && Number.isFinite(prevPris)) {
    prisAendringKr = roundPrice(PrisLigeNu - prevPris);
    if (prevPris > 0) {
      prisAendringPct = Number((((PrisLigeNu / prevPris) - 1) * 100).toFixed(1));
    } else if (PrisLigeNu > 0) {
      prisAendringPct = 100;
    }
  }

  const nuSlot = copenhagenParts(TimeNuStartpoint);
  const tagsHot = {
    "Elpris kvarter (kl)": Number(nuSlot.hour),
    "Elpris kvarter (min)": Number(nuSlot.minute),
    "Elpris spot eks. moms (kr)": roundPrice(prisNu && prisNu.spot),
    "Elpris nettarif eks. moms (kr)": roundPrice(prisNu && prisNu.nettarif),
    "Elpris Energinet eks. moms (kr)": roundPrice(prisNu && prisNu.energinet),
    "Elpris elafgift eks. moms (kr)": roundPrice(prisNu && prisNu.elafgift),
    "Elpris tillæg eks. moms (kr)": roundPrice(prisNu && prisNu.tillaeg),
    "Elpris moms (kr)": roundPrice(prisNu && prisNu.moms),
    "Elpris under smertetærskel": Boolean(PrisLigeNu <= SMERTETAERSKEL_KR),
    "Elpris prisændring (kr)": prisAendringKr,
    "Elpris prisændring (%)": prisAendringPct,
    "Elpris datakvalitet OK": Boolean(dataQuality.ok),
    "Elpris datakvalitet optimering OK": Boolean(dataQuality.safeForOptimization),
    "Elpris datakvalitet": dataQuality.ok ? "OK" : dataQuality.issues.join("; "),
    "Elpris periode fundet": Boolean(fandtPeriode),
    "Elpris periode start (kl)": Number(timespanStat.anbefalet.startKL ?? -1),
    "Elpris periode start (min)": Number(timespanStat.anbefalet.startKL < 0 ? -1 : timespanStat.anbefalet.startMIN),
    "Elpris periode start": fandtPeriode
      ? formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN)
      : "-",
    "Elpris periode slut (kl)": Number(periodeSlut.h),
    "Elpris periode slut (min)": Number(periodeSlut.m),
    "Elpris periode slut": fandtPeriode ? formatClockHM(periodeSlut.h, periodeSlut.m) : "-",
    "Elpris absolut fundet": Boolean(fandtAbsolut),
    "Elpris absolut start (kl)": Number(timespanStat.absolut.startKL ?? -1),
    "Elpris absolut start (min)": Number(timespanStat.absolut.startKL < 0 ? -1 : timespanStat.absolut.startMIN),
    "Elpris i billig zone": Boolean(iBilligZone),
    "Elpris zone fundet": Boolean(naesteZone),
    "Elpris zone start (kl)": Number(naesteZone ? naesteZone.start.hour : -1),
    "Elpris zone start (min)": Number(naesteZone ? naesteZone.start.minute : -1),
    "Elpris zone slut (kl)": Number(zoneSlut.h),
    "Elpris zone slut (min)": Number(zoneSlut.m)
  };
  const tagsCold = {
    "Elpris ændring": aendringTekst,
    "Elpris har ændring": Boolean(profileChanges.length),
    "Elpris billig til (kl)": Number(speakData.billigTilKL ?? -1),
    "Elpris billig til (min)": Number(speakData.billigTilKL == null ? -1 : speakData.billigTilMIN),
    "Elpris næste billige (kl)": Number(speakData.naesteBilligKL ?? -1),
    "Elpris næste billige (min)": Number(speakData.naesteBilligKL == null ? -1 : speakData.naesteBilligMIN),
    "Elpris næste billige (kr)": roundPrice(speakData.naesteBilligKR),
    "Elpris allerbilligste (kl)": Number(speakData.allerBilligstKL ?? -1),
    "Elpris allerbilligste (min)": Number(speakData.allerBilligstKL == null ? -1 : speakData.allerBilligstMIN),
    "Elpris allerbilligste (kr)": roundPrice(speakData.allerBilligstKR),
    "Elpris søgt frem (t)": Number(ArgsTimespan),
    "Elpris periode længde (t)": Number(ArgsAntalTimer),
    "Elpris periode billigste (kl)": Number(timespanStat.anbefalet.billigstKL ?? -1),
    "Elpris periode billigste (min)": Number(timespanStat.anbefalet.billigstKL < 0 ? -1 : timespanStat.anbefalet.billigstMIN),
    "Elpris periode billigste (kr)": roundPrice(timespanStat.anbefalet.billigstKR),
    "Elpris periode dyreste (kl)": Number(timespanStat.anbefalet.dyrestKL ?? -1),
    "Elpris periode dyreste (min)": Number(timespanStat.anbefalet.dyrestKL < 0 ? -1 : timespanStat.anbefalet.dyrestMIN),
    "Elpris periode dyreste (kr)": roundPrice(timespanStat.anbefalet.dyrestKR),
    "Elpris fundet periode snit (kr)": roundPrice(anbefalet.snit),
    "Elpris anbefalet er absolut": Boolean(anbefaletErAbsolut),
    "Elpris søgevindue snit (kr)": roundPrice(timespanStat.gennemsnit),
    "Elpris snit hvis start nu (kr)": roundPrice(snitFraNuKR),
    "Elpris besparelse ved vente (%)": Number(besparelseVedOptimalPct),
    "Elpris max ventetid (t)": Number(waitLimit.capHours) || 0,
    "Elpris absolut snit (kr)": roundPrice(absolut.snit),
    "Elpris absolut ventetid (t)": Number(absolut.ventetid),
    "Elpris absolut besparelse (kr/kW)": roundPrice(absolut.besparelse),
    "Elpris zone længde (t)": naesteZone ? Number((naesteZone.slots / 4).toFixed(2)) : 0,
    "Elpris zone snit (kr)": naesteZone ? roundPrice(naesteZone.sum / naesteZone.slots) : 0,
    "Elpris speak": Speak_GenerelRapport,
    "Elpris speak periode": Speak_FundneTimerRapport
  };

  const naeste8 = statsForUpcomingHours(8);
  const tendensGnsKort = roundPrice(priceHoursAhead(TENDENS_KORT_T));
  const tendensGnsLang = roundPrice(priceHoursAhead(TENDENS_LANG_T));
  const tendensNu = prisTendensTekst(tendensGnsKort, tendensGnsLang);
  const systemstatus = buildSystemStatus(healthCtx);
  const dashboardFields = dashboardFieldSpecs({
    naeste8,
    morgenStat,
    weekAvgs,
    rangIDag,
    statusNu,
    vsTypisk,
    hourProfil,
    tendensNu,
    systemstatus,
    venteRaad,
    sparePotentiale,
    prisAendringKr,
    prisAendringPct,
    iMorgenKlar,
    grafFarverIDag,
    grafIDagUrl,
    grafIMorgenUrl
  });

  let elprisDevice = null;
  try {
    elprisDevice = await findElprisVirtualDevice();
  } catch (_) {
    elprisDevice = null;
  }

  if (elprisDevice) {
    elprisDevice = await refreshElprisDeviceIfCapsMissing(elprisDevice, dashboardFields);
  }

  const deviceCapMap = elprisDevice ? mapAllDeviceCaps(elprisDevice, dashboardFields) : {};
  const onDevice = {};
  if (elprisDevice) {
    for (let i = 0; i < dashboardFields.length; i++) {
      const field = dashboardFields[i];
      if (field.skipDevice) continue;
      onDevice[field.key] = Boolean(deviceCapMap[field.key]);
    }
  }

  const hourKey = `${idagStr}|${nuSlot.hour}`;
  const lastRunSlot = Number(state.lastRunSlotMs) || 0;
  const gapMs = lastRunSlot ? TimeNuMs - lastRunSlot : 24 * 60 * 60 * 1000;
  const writeCold =
    state.lastTagHourKey !== hourKey ||
    state.lastRunDay !== idagStr ||
    gapMs > 75 * 60 * 1000;

  let deviceWriteMissing = [];
  try {
    deviceWriteMissing = await updateElprisVirtualDevice(elprisDevice, dashboardFields, writeCold, deviceCapMap);
  } catch (e) {
    logTrace("Virtuel enhed: " + (e && e.message ? e.message : e));
  }
  if (!Array.isArray(deviceWriteMissing)) deviceWriteMissing = [];
  for (let i = 0; i < deviceWriteMissing.length; i++) {
    onDevice[deviceWriteMissing[i]] = false;
  }

  const tagFallback = [];
  for (let i = 0; i < dashboardFields.length; i++) {
    const field = dashboardFields[i];
    if (onDevice[field.key] || !field.tags) continue;
    Object.assign(tagsHot, field.tags);
    if (!field.skipDevice) tagFallback.push(field.titles[0]);
  }
  if (elprisDevice && tagFallback.length) {
    const fallbackKey = tagFallback.join("|");
    if (state.lastTagFallback !== fallbackKey) {
      log("Mangler på enheden → tags: " + tagFallback.join(", "));
      state.lastTagFallback = fallbackKey;
      saveCacheState();
    }
  }
  await removeDashboardTagsOnDevice(dashboardFields, onDevice);

  maybeMarkIMorgenKlar(iMorgenKlar, iMorgenDate);

  const displayTimezone = await resolveDisplayTimezone();
  const tagWrite = await updateHomeyTags(tagsHot, tagsCold, displayTimezone, writeCold);
  const tagsWritten = Number(tagWrite && tagWrite.written) || 0;
  const tagsUnchanged = Number(tagWrite && tagWrite.unchanged) || 0;

  let alarmSyncNote = "";
  try {
    alarmSyncNote = await syncOptimalHomeyAlarm({
      name: String(ELPRIS_ALARM_NAVN || "").trim(),
      found: Boolean(fandtPeriode),
      startDato: timespanStat.anbefalet.startDato,
      startKL: timespanStat.anbefalet.startKL,
      startMIN: timespanStat.anbefalet.startMIN,
      enable: Boolean(fandtPeriode && !korselNu && timespanStat.anbefalet.startDato)
    });
  } catch (e) {
    alarmSyncNote = "kunne ikke synkroniseres (" + (e && e.message ? e.message : e) + ")";
    const likelyOutage = !healthCtx.prevRunAt || (Date.now() - healthCtx.prevRunAt > 75 * 60 * 1000);
    if (!likelyOutage) reportFejl("E-503", e && e.message);
    logTrace("Advarsel: Homey-ur: " + alarmSyncNote);
  }

  const tAfterHomey = Date.now();
  healthCtx.msApi = Math.max(0, tAfterApi - tStart);
  healthCtx.msCalc = Math.max(0, tAfterCalc - tAfterApi);
  healthCtx.msHomey = Math.max(0, tAfterHomey - tAfterCalc);
  healthCtx.msTotal = Math.max(0, tAfterHomey - tStart);
  healthCtx.tagsChanged = tagsWritten;
  healthCtx.tagsUnchanged = tagsUnchanged;

  logRunSummary();

  savePriceProfile(currentProfile);

  state.lastRunDay = idagStr;
  state.lastRunSlotMs = TimeNuMs;
  state.lastRunAt = Date.now();
  saveCacheState();

  return await finishRun(true);

  // -------------------- FUNKTIONER --------------------

  function maybeMarkIMorgenKlar(klar, morgenDate) {
    if (!klar) return;
    const key = fmtYmd(morgenDate);
    if (state.iMorgenKlarNotified === key) return;
    state.iMorgenKlarNotified = key;
    saveCacheState();
    logTrace("✅ Elpriser for i morgen er klar.");
  }

  function collectProfileChanges(prev, curr) {
    const changes = [];
    if (!prev || typeof prev.lastPriceNow !== "number") return changes;

    const minJump = BilligPrisMinForskelOre / 100;
    const delta = roundPrice(curr.lastPriceNow - prev.lastPriceNow);
    if (Math.abs(delta) >= minJump) {
      const verb = delta > 0 ? "steget" : "faldet";
      changes.push({
        kind: "price",
        text: `Prisen er ${verb} fra ${fmtKr(prev.lastPriceNow)} → ${fmtKr(curr.lastPriceNow)} kr.`
      });
    }

    const po = prev.lastOptimalPeriod || {};
    const co = curr.lastOptimalPeriod || {};
    const oldTekst = po.found ? po.startTekst : "";
    const newTekst = co.found ? co.startTekst : "";
    if (po.found && co.found && oldTekst !== newTekst && !(po.startNu && co.startNu)) {
      changes.push({
        kind: "period",
        text: `Den billigste periode er flyttet fra ${oldTekst} til ${newTekst}.`
      });
    } else if (po.found && !co.found) {
      changes.push({
        kind: "period",
        text: `Ingen billigste periode fundet (var kl. ${oldTekst}).`
      });
    } else if (!po.found && co.found) {
      changes.push({
        kind: "period",
        text: `Billigste periode er nu kl. ${newTekst}.`
      });
    }

    if (prev.lastTariffSource && prev.lastTariffSource !== curr.lastTariffSource) {
      changes.push({
        kind: "tariff",
        text: `Tarif-kilde skiftet: ${prev.lastTariffSource} → ${curr.lastTariffSource}.`
      });
    }

    if (prev.lastStatus && prev.lastStatus !== curr.lastStatus) {
      changes.push({
        kind: "status",
        text: `Status: ${prev.lastStatus} → ${curr.lastStatus}.`
      });
    }

    return changes;
  }

  function savePriceProfile(profile) {
    state.lastPriceNow = profile.lastPriceNow;
    state.lastStatus = profile.lastStatus;
    state.lastOptimalPeriod = profile.lastOptimalPeriod;
    state.lastDay = profile.lastDay;
    state.lastTomorrowReady = profile.lastTomorrowReady;
    state.lastTariffSource = profile.lastTariffSource;
    saveCacheState();
  }

  function noonFromDayKey(dayKey) {
    const m = String(dayKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  }

  function dayPricePercentiles(recs) {
    const xs = [];
    for (let i = 0; i < (recs || []).length; i++) {
      const v = Number(recs[i].total);
      if (Number.isFinite(v)) xs.push(v);
    }
    if (xs.length < 20) return null;
    xs.sort((a, b) => a - b);
    const at = (p) => {
      const i = Math.min(xs.length - 1, Math.max(0, Math.round((p / 100) * (xs.length - 1))));
      return xs[i];
    };
    return {
      p10: roundPrice(at(10)),
      p25: roundPrice(at(25)),
      p75: roundPrice(at(75)),
      p90: roundPrice(at(90))
    };
  }

  function mixPriceBands(oldBands, newBands, a) {
    if (!newBands) return oldBands || null;
    if (!oldBands) {
      return {
        p10: newBands.p10,
        p25: newBands.p25,
        p75: newBands.p75,
        p90: newBands.p90
      };
    }
    return {
      p10: roundPrice((1 - a) * oldBands.p10 + a * newBands.p10),
      p25: roundPrice((1 - a) * oldBands.p25 + a * newBands.p25),
      p75: roundPrice((1 - a) * oldBands.p75 + a * newBands.p75),
      p90: roundPrice((1 - a) * oldBands.p90 + a * newBands.p90)
    };
  }

  function learnPriceNorm(weekAvgs) {
    const norm = state.priceNorm || (state.priceNorm = { days: {}, ewma: 0 });
    if (!norm.days || typeof norm.days !== "object") norm.days = {};
    if (!norm.bandDays || typeof norm.bandDays !== "object") norm.bandDays = {};

    const byDay = {};
    const dayKeys = Object.keys(quarterIndex.dayStats);
    for (let i = 0; i < dayKeys.length; i++) {
      const key = dayKeys[i];
      if (!key || key >= idagStr) continue;
      if (!quarterIndex.completeDays[key]) continue;
      const ds = quarterIndex.dayStats[key];
      if (!ds || !ds.n) continue;
      byDay[key] = { sum: ds.sum, n: ds.n };
    }

    let dirty = false;
    const newAvgs = [];
    const keys = Object.keys(byDay).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const avg = roundPrice(byDay[key].sum / byDay[key].n);
      if (norm.days[key] == null) newAvgs.push(avg);
      if (norm.days[key] !== avg) {
        norm.days[key] = avg;
        dirty = true;
      }
    }

    const kept = Object.keys(norm.days).sort();
    while (kept.length > 28) {
      delete norm.days[kept.shift()];
      dirty = true;
    }

    const weekLast = weekAvgs && weekAvgs.lastWeekAvg > 0 ? roundPrice(weekAvgs.lastWeekAvg) : 0;
    const weekNow = weekAvgs && weekAvgs.thisWeekAvg > 0 ? roundPrice(weekAvgs.thisWeekAvg) : 0;
    const todayAvg = dagStat && dagStat.gennemsnit > 0 ? roundPrice(dagStat.gennemsnit) : 0;
    let kilde = "lært";

    if (!(norm.ewma > 0)) {
      if (weekLast) {
        norm.ewma = weekLast;
        kilde = "sidste uge";
      } else if (Object.keys(norm.days).length) {
        let s = 0;
        const dkeys = Object.keys(norm.days);
        for (let i = 0; i < dkeys.length; i++) s += norm.days[dkeys[i]];
        norm.ewma = roundPrice(s / dkeys.length);
      } else if (weekNow) {
        norm.ewma = weekNow;
        kilde = "denne uge";
      } else if (todayAvg) {
        norm.ewma = todayAvg;
        kilde = "i dag";
      }
      if (norm.ewma > 0) dirty = true;
    }

    if (norm.ewma > 0 && newAvgs.length) {
      let e = norm.ewma;
      const a = STATUS_LAERING;
      for (let i = 0; i < newAvgs.length; i++) e = (1 - a) * e + a * newAvgs[i];
      norm.ewma = roundPrice(e);
      kilde = "lært";
      dirty = true;
    }

    const bandKeys = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!quarterIndex.completeDays[key] || norm.bandDays[key]) continue;
      const recs = quarterIndex.byDay && quarterIndex.byDay[key];
      if (!recs || recs.length < 20) continue;
      bandKeys.push(key);
    }
    if (bandKeys.length) {
      const a = STATUS_LAERING;
      let bands = (norm.p25 > 0 && norm.p75 > 0)
        ? { p10: norm.p10, p25: norm.p25, p75: norm.p75, p90: norm.p90 }
        : null;
      if (!bands) {
        const all = [];
        for (let i = 0; i < bandKeys.length; i++) {
          const recs = quarterIndex.byDay[bandKeys[i]];
          for (let j = 0; j < recs.length; j++) {
            const v = Number(recs[j].total);
            if (Number.isFinite(v)) all.push(v);
          }
        }
        const seeded = dayPricePercentiles(all.map(total => ({ total })));
        if (seeded) bands = seeded;
      } else {
        for (let i = 0; i < bandKeys.length; i++) {
          bands = mixPriceBands(bands, dayPricePercentiles(quarterIndex.byDay[bandKeys[i]]), a);
        }
      }
      if (bands) {
        norm.p10 = bands.p10;
        norm.p25 = bands.p25;
        norm.p75 = bands.p75;
        norm.p90 = bands.p90;
        for (let i = 0; i < bandKeys.length; i++) norm.bandDays[bandKeys[i]] = true;
        dirty = true;
      }
    }

    if (dirty) {
      state.priceNorm = norm;
      saveCacheState();
    }

    const baseline = norm.ewma > 0 ? roundPrice(norm.ewma) : (weekLast || weekNow || todayAvg || 0);
    if (!(norm.ewma > 0) && weekLast) kilde = "sidste uge";
    else if (!(norm.ewma > 0) && weekNow) kilde = "denne uge";
    else if (!(norm.ewma > 0) && todayAvg) kilde = "i dag";

    const bandN = Object.keys(norm.bandDays).length;
    const bandsKlar = bandN >= TIMEPROFIL_MIN_DAGE && norm.p25 > 0 && norm.p75 > norm.p25;
    return {
      baseline,
      days: Object.keys(norm.days).length,
      kilde,
      bandN,
      bandsKlar,
      bands: bandsKlar
        ? { p10: norm.p10, p25: norm.p25, p75: norm.p75, p90: norm.p90, n: bandN }
        : null
    };
  }

  function fmtProfilHour(hour) {
    const n = ((Number(hour) % 24) + 24) % 24;
    return String(n).padStart(2, "0") + ":00";
  }

  function laeringModenhedPct(dage) {
    const n = Number(dage) || 0;
    const krav = Number(TIMEPROFIL_MIN_DAGE) || 1;
    if (n <= 0) return 0;
    return Math.min(100, Math.round((n / krav) * 100));
  }

  function laeringDatagrundlag(dage, klar) {
    const n = Number(dage) || 0;
    const krav = Number(TIMEPROFIL_MIN_DAGE) || 1;
    if (klar) return n + " afsluttede døgn (nok til mønster)";
    if (n <= 0) return "0 af " + krav + " døgn · lærer stadig";
    return n + " af " + krav + " døgn · mangler " + (krav - n);
  }

  function timeprofilKlasse(rank) {
    const r = Number(rank);
    if (!(r > 0)) return "";
    if (r <= 6) return "billigt";
    if (r >= 19) return "dyrt";
    return "moderat";
  }

  function timeprofilKlasseTekst(klasse) {
    if (klasse === "billigt") return "blandt dagens billige timer";
    if (klasse === "dyrt") return "blandt dagens dyre timer";
    if (klasse === "moderat") return "midt i døgnet (hverken billig eller dyr)";
    return "";
  }

  function timeprofilTimeTekst(hour, klasse, dage) {
    const kl = fmtProfilHour(hour);
    if (!klasse || !(dage >= TIMEPROFIL_MIN_DAGE)) {
      const har = Number(dage) || 0;
      return har
        ? "Timeprofil: " + har + " af " + TIMEPROFIL_MIN_DAGE + " dage"
        : "Timeprofil: lærer stadig";
    }
    return kl + " er normalt " + timeprofilKlasseTekst(klasse) + ".";
  }

  function timeprofilDoegnTekst(hours, minDage) {
    const parts = [];
    let i = 0;
    while (i < 24) {
      const n = hours[i] && hours[i].n ? hours[i].n : 0;
      const klasse = n >= minDage ? timeprofilKlasse(hours[i].ewmaRank) : "";
      if (!klasse) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < 24) {
        const n2 = hours[j] && hours[j].n ? hours[j].n : 0;
        const k2 = n2 >= minDage ? timeprofilKlasse(hours[j].ewmaRank) : "";
        if (k2 !== klasse) break;
        j++;
      }
      parts.push(fmtProfilHour(i) + "–" + fmtProfilHour(j === 24 ? 0 : j) + " " + timeprofilKlasseTekst(klasse));
      i = j;
    }
    return parts.join(" · ");
  }

  function learnHourProfile() {
    const tom = {
      tekst: "Timeprofil: lærer stadig",
      kort: "lærer",
      rang: 0,
      doegn: "",
      dage: 0,
      modenhed: 0,
      datagrundlag: laeringDatagrundlag(0, false),
      hour: copenhagenParts(TimeNuStartpoint).hour
    };
    const prof = state.hourProfile || (state.hourProfile = { days: {}, hours: null });
    if (!prof.days || typeof prof.days !== "object") prof.days = {};
    if (!Array.isArray(prof.hours) || prof.hours.length !== 24) {
      prof.hours = [];
      for (let h = 0; h < 24; h++) prof.hours.push({ ewmaRel: 0, ewmaRank: 0, n: 0 });
    }

    let dirty = false;
    const a = STATUS_LAERING;
    const dayKeys = Object.keys(quarterIndex.completeDays || {}).sort();
    for (let d = 0; d < dayKeys.length; d++) {
      const key = dayKeys[d];
      if (!key || key >= idagStr) continue;
      if (!quarterIndex.completeDays[key]) continue;
      if (prof.days[key]) continue;

      const avgs = new Array(24).fill(null);
      const buckets = hourBucketsForDay(key);
      const hit = new Array(24).fill(0);
      for (let b = 0; b < buckets.length; b++) {
        const h = buckets[b].hour;
        if (h < 0 || h > 23) continue;
        avgs[h] = avgs[h] == null ? buckets[b].avg : (avgs[h] * hit[h] + buckets[b].avg) / (hit[h] + 1);
        hit[h]++;
      }
      let present = 0;
      for (let h = 0; h < 24; h++) if (avgs[h] != null) present++;
      if (present < 23) continue;

      const ds = quarterIndex.dayStats[key];
      const dayAvg = ds && ds.n ? ds.sum / ds.n : 0;
      if (!(dayAvg > 0)) continue;

      const ranked = [];
      for (let h = 0; h < 24; h++) {
        if (avgs[h] != null) ranked.push({ h, avg: avgs[h] });
      }
      ranked.sort((x, y) => x.avg - y.avg || x.h - y.h);
      const rankOf = new Array(24);
      for (let r = 0; r < ranked.length; r++) rankOf[ranked[r].h] = r + 1;

      for (let h = 0; h < 24; h++) {
        if (avgs[h] == null) continue;
        const slot = prof.hours[h];
        const rel = avgs[h] / dayAvg;
        const rank = rankOf[h];
        if (!(slot.n > 0)) {
          slot.ewmaRel = rel;
          slot.ewmaRank = rank;
          slot.n = 1;
        } else {
          slot.ewmaRel = (1 - a) * slot.ewmaRel + a * rel;
          slot.ewmaRank = (1 - a) * slot.ewmaRank + a * rank;
          slot.n++;
        }
        slot.ewmaRel = roundPrice(slot.ewmaRel);
        slot.ewmaRank = Number(slot.ewmaRank.toFixed(2));
      }
      prof.days[key] = true;
      dirty = true;
    }

    const kept = Object.keys(prof.days).sort();
    while (kept.length > 90) {
      delete prof.days[kept.shift()];
      dirty = true;
    }

    if (dirty) {
      state.hourProfile = prof;
      saveCacheState();
    }

    const hour = tom.hour;
    const slot = prof.hours[hour] || { ewmaRank: 0, n: 0 };
    const dage = Number(slot.n) || 0;
    const rang = dage ? Number(slot.ewmaRank) : 0;
    const klar = dage >= TIMEPROFIL_MIN_DAGE;
    const klasse = klar ? timeprofilKlasse(rang) : "";
    const modenhed = laeringModenhedPct(dage);
    return {
      tekst: timeprofilTimeTekst(hour, klasse, dage),
      kort: klar ? ("normalt " + timeprofilKlasseTekst(klasse)) : "lærer",
      rang: Number(rang.toFixed(1)),
      doegn: timeprofilDoegnTekst(prof.hours, TIMEPROFIL_MIN_DAGE),
      dage,
      modenhed,
      datagrundlag: laeringDatagrundlag(dage, klar),
      hour
    };
  }

  function prisStatusFraRang(stats) {
    const s = stats || {};
    if (!s.count) return "🟡 Normal";
    if (s.rank <= Math.ceil(s.count * 0.10)) return "🟢 Meget billig";
    if (s.rank <= Math.ceil(s.count * 0.25)) return "🟢 Billig";
    if (s.rank > Math.floor(s.count * 0.90)) return "🔴 Meget dyr";
    if (s.rank > Math.floor(s.count * 0.75)) return "🟠 Dyr";
    return "🟡 Normal";
  }

  function prisStatusFraPeriode(priceNow, baseline, bands) {
    const pris = Number(priceNow);
    if (!Number.isFinite(pris)) return "";
    if (bands && bands.p25 > 0 && bands.p75 > bands.p25) {
      if (pris <= bands.p10) return "🟢 Meget billig";
      if (pris <= bands.p25) return "🟢 Billig";
      if (pris >= bands.p90) return "🔴 Meget dyr";
      if (pris >= bands.p75) return "🟠 Dyr";
      return "🟡 Normal";
    }
    const typisk = Number(baseline);
    if (!(typisk > 0)) return "";
    const diff = pris - typisk;
    const pct = (diff / typisk) * 100;
    if (pct <= -STATUS_MEGET_BILLIG_PCT || diff <= -STATUS_MEGET_BILLIG_KR) return "🟢 Meget billig";
    if (pct <= -STATUS_BILLIG_PCT || diff <= -STATUS_BILLIG_KR) return "🟢 Billig";
    if (pct >= STATUS_MEGET_DYR_PCT || diff >= STATUS_MEGET_DYR_KR) return "🔴 Meget dyr";
    if (pct >= STATUS_DYR_PCT || diff >= STATUS_DYR_KR) return "🟠 Dyr";
    return "🟡 Normal";
  }

  function vsTypiskFraBaseline(priceNow, baseline) {
    const pris = roundPrice(priceNow);
    const typisk = roundPrice(baseline);
    if (!(typisk > 0) || !Number.isFinite(pris)) {
      return { typisk: 0, pct: 0, tekst: "—" };
    }
    const pct = Number(((pris / typisk - 1) * 100).toFixed(1));
    const pctTegn = pct > 0 ? "+" : "";
    return {
      typisk,
      pct,
      tekst: "Typisk " + fmtKr(typisk) + " kr · nu " + fmtKr(pris) + " kr · " + pctTegn + String(pct).replace(".", ",") + " %"
    };
  }

  function prisTendensTekst(kortKr, langKr) {
    const a = roundPrice(kortKr);
    const b = roundPrice(langKr);
    const pil = fmtKr(a) + " → " + fmtKr(b) + " kr.";
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "➡️ Stabil — " + pil;
    const diff = b - a;
    const pct = a > 0 ? (diff / a) * 100 : (b > 0 ? 100 : 0);
    if (diff <= -TENDENS_KR || pct <= -TENDENS_PCT) return "📉 Faldende — " + pil;
    if (diff >= TENDENS_KR || pct >= TENDENS_PCT) return "📈 Stigende — " + pil;
    return "➡️ Stabil — " + pil;
  }

  function besparelseVenteRaad(x) {
    const startNu = { raad: "Start nu", beslutning: "Start nu", minKw: 0 };
    if (!x.found) return { raad: "Ingen anbefalet periode", beslutning: "Start nu", minKw: 0 };
    if (x.autoTekst) return { raad: x.autoTekst, beslutning: "Start nu", minKw: 0 };
    if (x.startErNu || x.korselNu) return startNu;
    const spar = Number(x.sparKrKw) || 0;
    const vent = Number(x.ventetid) || 0;
    if (!(spar > 0) || !(vent > 0)) return startNu;
    const ventTekst = String(vent).replace(".", ",");
    const raadSpar = "Vent " + ventTekst + " t → spar " + fmtKr(spar) + " kr/kW";
    if (spar < VENT_MIN_KR_PR_KW) {
      return { raad: "Start nu — for lille gevinst", beslutning: "Start nu", minKw: 0 };
    }
    let minKw = Number((VENT_MIN_TOTAL_KR / spar).toFixed(2));
    if (minKw <= VENT_ALLTID_UNDER_KW) {
      return { raad: raadSpar, beslutning: "Vent", minKw: 0 };
    }
    return {
      raad: raadSpar + " · først ved > " + fmtKr(minKw) + " kW",
      beslutning: "Vent kun hvis forbruget > " + fmtKr(minKw) + " kW",
      minKw
    };
  }

  function besparelsesPotentiale(x) {
    const kw = Number(BESPARELSE_EKSEMPEL_KW);
    const tom = {
      tekst: "Ingen flytbar besparelse nu.",
      kort: "0 kr/kWh",
      krKwh: 0,
      eksempelKr: 0
    };
    if (!x.found || x.startErNu || x.korselNu) return tom;
    const nu = roundPrice(x.prisNu);
    const bedst = roundPrice(x.bedstSnit);
    const krKwh = roundPrice(Math.max(0, nu - bedst));
    const sparKw = roundPrice(Math.max(0, Number(x.sparKrKw) || 0));
    const eksempelKr = roundPrice(sparKw * (kw > 0 ? kw : 0));
    if (!(krKwh > 0) && !(sparKw > 0)) return tom;
    const vent = Number(x.ventetid) || 0;
    const ventTekst = String(vent).replace(".", ",");
    const linjer = [
      "Pris nu: " + fmtKr(nu) + " kr/kWh",
      "Bedste periode: " + fmtKr(bedst) + " kr/kWh",
      "Besparelse: " + fmtKr(krKwh) + " kr/kWh",
      "Ventetid: " + ventTekst + " t"
    ];
    if (kw > 0 && eksempelKr > 0) {
      linjer.push("Ved " + String(kw).replace(".", ",") + " kW i " + String(ArgsAntalTimer).replace(".", ",") + " t → " + fmtKr(eksempelKr) + " kr");
    }
    return {
      tekst: linjer.join("\n"),
      kort: "spar " + fmtKr(krKwh) + " kr/kWh" + (eksempelKr > 0 ? " · " + fmtKr(eksempelKr) + " kr ved " + String(kw).replace(".", ",") + " kW" : ""),
      krKwh,
      eksempelKr
    };
  }

  async function resolveDisplayTimezone() {
    const raw = String(TIDSZONE || "").trim();
    if (!raw || raw.toLowerCase() === "europe/copenhagen") return "Europe/Copenhagen";
    if (raw.toLowerCase() !== "auto") return "Europe/Copenhagen";

    const cached = state.homeyTimezone;
    const at = Number(state.homeyTimezoneAt) || 0;
    if (cached && Date.now() - at < 24 * 60 * 60 * 1000) return cached;

    try {
      if (typeof Homey !== "undefined" && Homey.system && Homey.system.getInfo) {
        const info = await Homey.system.getInfo();
        const tz = info && typeof info.timezone === "string" ? info.timezone.trim() : "";
        if (tz) {
          state.homeyTimezone = tz;
          state.homeyTimezoneAt = Date.now();
          saveCacheState();
          logTrace("Homey-tidszone (Auto): " + tz);
          return tz;
        }
      }
    } catch (e) {
      logTrace("Kunne ikke hente Homey-tidszone: " + (e && e.message ? e.message : e));
    }
    return cached || "Europe/Copenhagen";
  }

  function tagValuesEqual(a, b) {
    if (a === b) return true;
    if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
    if (typeof a === "number" && typeof b === "number") return a === b;
    return String(a ?? "") === String(b ?? "");
  }

  function toDKDate(d) {
    if (d instanceof Date) return d;
    return new Date(String(d).replace(' ', 'T'));
  }

  function parseApiUtc(value) {
    if (value instanceof Date) return isValidDate(value) ? value : null;
    if (value == null || value === "") return null;
    let raw = String(value).trim().replace(" ", "T");
    if (!/Z$/i.test(raw) && !/[+-]\d{2}:?\d{2}$/.test(raw)) raw += "Z";
    const d = new Date(raw);
    return isValidDate(d) ? d : null;
  }

  function copenhagenParts(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      hour12: false
    });
    const p = {};
    for (const part of formatter.formatToParts(d)) p[part.type] = part.value;
    let hour = parseInt(p.hour, 10);
    if (hour === 24) hour = 0;
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour,
      minute: parseInt(p.minute, 10),
      second: parseInt(p.second, 10)
    };
  }

  function copenhagenDayKey(dateObj) {
    return dayKeyFromParts(copenhagenParts(dateObj));
  }

  function dayKeyFromParts(p) {
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  }

  function weekdayFromParts(p) {
    return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0)).getUTCDay();
  }

  function copenhagenWeekday(dateObj) {
    return weekdayFromParts(copenhagenParts(dateObj));
  }

  function startOfIsoWeekNoon(dateObj) {
    const p = copenhagenParts(dateObj);
    const daysFromMonday = (weekdayFromParts(p) + 6) % 7;
    return new Date(Date.UTC(p.year, p.month - 1, p.day - daysFromMonday, 12, 0, 0));
  }

  function addUtcDays(dateObj, days) {
    return new Date(dateObj.getTime() + days * 24 * 60 * 60 * 1000);
  }

  function slotInstantFromRecord(r) {
    const utc = parseApiUtc(r && r.TimeUTC);
    if (utc) return floorToQuarter(utc);
    const dk = toDKDate(r && (r.TimeDK || r.HourDK));
    return isValidDate(dk) ? floorToQuarter(dk) : null;
  }

  function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtYmd(d) {
    const p = copenhagenParts(d);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  }

  function fmtYmdHm(d) {
    const p = copenhagenParts(d);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00`;
  }

  function chargeTypeCode(record) {
    return String(record && record.ChargeTypeCode ? record.ChargeTypeCode : "").toUpperCase().replace(/\s+/g, " ").trim();
  }

  function httpStatusMessage(status, context) {
    if (status >= 500) return `HTTP ${status} (Server Error). Energidataservice er midlertidigt nede eller overbelastet.`;
    if (status === 400) return `HTTP 400 (Bad Request). ${context || "API afviste anmodningen."}`;
    return `HTTP ${status}. Ukendt fejl ved hentning af data.`;
  }

  async function fetchDatasetJson(apiUrl, debugLabel, badRequestHint, options) {
    const maxRetries = options && options.maxRetries != null ? Number(options.maxRetries) : 3;
    const fastFail = Boolean(options && options.fastFail);
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logTrace(`${debugLabel} (forsøg ${attempt} af ${maxRetries})`);
        const response = await safeFetch(apiUrl);

        if (!response || !response.ok) {
          const status = response ? response.status : 0;
          if (status === 429) {
            lastError = new Error("429");
            if (fastFail || attempt >= maxRetries) throw lastError;
            const retryDelay = 10000 * attempt;
            log(`⚠️ API rate limit nået (429). Venter ${retryDelay / 1000} sekunder...`);
            await wait(retryDelay);
            continue;
          }
          throw new Error(httpStatusMessage(status, badRequestHint));
        }

        return await response.json();
      } catch (e) {
        lastError = e;
        if (e.message !== "429") {
          log(`Fejl under API kald (forsøg ${attempt}): ${e.message}`);
        }
        if (fastFail) throw e;
        if (attempt < maxRetries && e.message !== "429") {
          await wait(3000 * attempt);
        }
      }
    }

    throw lastError || new Error("API kald fejlede");
  }

  function isChargeValidAt(record, now) {
    if (!record || !record.ValidFrom || record.Price1 === null || record.Price1 === undefined) return false;
    const from = toDKDate(record.ValidFrom);
    if (!isValidDate(from) || from > now) return false;
    if (record.ValidTo) {
      const to = toDKDate(record.ValidTo);
      if (isValidDate(to) && to <= now) return false;
    }
    return true;
  }

  function validityFromRecord(record) {
    if (!record || !record.ValidFrom) return null;
    const from = toDKDate(record.ValidFrom);
    if (!isValidDate(from)) return null;
    let to = null;
    if (record.ValidTo) {
      const t = toDKDate(record.ValidTo);
      if (isValidDate(t)) to = t.getTime();
    }
    return { from: from.getTime(), to };
  }

  function intersectValidity(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const from = Math.max(a.from, b.from);
    let to = null;
    if (a.to == null) to = b.to;
    else if (b.to == null) to = a.to;
    else to = Math.min(a.to, b.to);
    if (to != null && to <= from) return null;
    return { from, to };
  }

  function earliestFutureStart(records, now, predicate) {
    const nowMs = now.getTime();
    let min = null;
    for (const r of records || []) {
      if (!predicate(r) || !r.ValidFrom) continue;
      const from = toDKDate(r.ValidFrom);
      if (!isValidDate(from)) continue;
      const t = from.getTime();
      if (t <= nowMs) continue;
      if (min == null || t < min) min = t;
    }
    return min;
  }

  function capValidityWithNextStart(window, nextStartMs) {
    if (!window) return null;
    if (nextStartMs == null) return window;
    const to = window.to == null ? nextStartMs : Math.min(window.to, nextStartMs);
    if (to <= window.from) return window;
    return { from: window.from, to };
  }

  function isValidityWindowActive(meta, now) {
    if (!meta || typeof meta.validFrom !== "number") return false;
    const t = now.getTime();
    if (t < meta.validFrom) return false;
    if (meta.validTo != null && t >= meta.validTo) return false;
    return true;
  }

  function isLiveGridCacheValid(now) {
    const cache = state.tariffCache || {};
    if (!cache.grid || !cache.gridMeta) return false;
    if (cache.gridMeta.gln !== NETSELSKAB) return false;
    return isValidityWindowActive(cache.gridMeta, now);
  }

  function isLiveEnerginetCacheValid(now) {
    const cache = state.tariffCache || {};
    if (typeof cache.energinet !== "number" || !cache.energinetMeta) return false;
    if (cache.energinetMeta.gln !== ENERGINET_GLN) return false;
    return isValidityWindowActive(cache.energinetMeta, now);
  }

  function formatValidityWindow(meta) {
    if (!meta || typeof meta.validFrom !== "number") return "ukendt gyldighed";
    const from = fmtYmd(new Date(meta.validFrom));
    const to = meta.validTo != null ? fmtYmd(new Date(meta.validTo)) : "åben";
    const code = meta.chargeTypeCode ? ` ${meta.chargeTypeCode}` : "";
    return `${from}–${to}${code}`;
  }

  function chargeNote(record) {
    return String(record && record.Note ? record.Note : "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function pickHouseholdGridTariff(validRecords) {
    const d03 = (validRecords || []).filter(r => r.ChargeType === "D03");
    if (!d03.length) return null;

    const codeOf = (r) => chargeTypeCode(r);
    const byCode = (code) => d03.find(r => codeOf(r) === code);

    // N1: CD = Nettarif C. CD R er rabat og må ikke bruges som selve kWh-tariffen.
    const household = byCode("CD") || d03.find(r => {
      const note = chargeNote(r);
      const code = codeOf(r);
      if (code === "CD R") return false;
      if (/nettarif\s*c\b/.test(note) || /\btarif\s*c\b/.test(note) || note === "c") return true;
      if (code.endsWith(" C")) return true;
      return false;
    });

    return household || d03[0];
  }

  function mergeGridRebate(base, rebate) {
    if (!base || !rebate) return base;
    const merged = Object.assign({}, base);
    for (let i = 1; i <= 24; i++) {
      const k = `Price${i}`;
      const a = Number(base[k]);
      const b = Number(rebate[k]);
      if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
      merged[k] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
    }
    merged.Note = `${base.Note || "Nettarif C"} (inkl. rabat)`;
    return merged;
  }

  function datahubStartParam() {
    const p = copenhagenParts(getDKTime());
    const start = new Date(Date.UTC(p.year, p.month - 19, p.day, 12, 0, 0));
    return `&start=${encodeURIComponent(fmtYmd(start))}`;
  }

  function findEnerginetCharge(validRecords, exactNote) {
    const want = String(exactNote).toLowerCase().replace(/\s+/g, " ").trim();
    return (validRecords || []).find(r =>
      r.ChargeType === "D03" && chargeNote(r) === want
    );
  }

  function floorToQuarter(dateObj) {
    const q = new Date(dateObj);
    if (!isValidDate(q)) return q;
    const p = copenhagenParts(q);
    const flooredMin = Math.floor((Number.isFinite(p.minute) ? p.minute : 0) / 15) * 15;
    const leftoverMs = (p.minute - flooredMin) * 60000 + (p.second || 0) * 1000 + q.getMilliseconds();
    q.setTime(q.getTime() - leftoverMs);
    return q;
  }

  function timeMs(x) {
    if (typeof x === "number") return x;
    if (x && typeof x.timestampMs === "number") return x.timestampMs;
    if (x && typeof x.getTime === "function") return x.getTime();
    return NaN;
  }

  function slotDiff(a, b) {
    return Math.round((timeMs(a) - timeMs(b)) / (15 * 60 * 1000));
  }

  function emptyWindowResult(cleared) {
    return {
      startKL: -1,
      startMIN: 0,
      startDato: null,
      totalPris: cleared ? 0 : 9999999,
      billigstKR: 0,
      billigstKL: -1,
      billigstMIN: 0,
      dyrestKR: 0,
      dyrestKL: -1,
      dyrestMIN: 0
    };
  }

  function isWindowFound(resultat) {
    return Boolean(resultat && resultat.startKL !== -1 && resultat.totalPris !== 9999999);
  }

  function snapshotSearchWindow(startQ, windowSum, startIndex) {
    let windowMinKR = 999999;
    let windowMaxKR = -10;
    let windowMinKL = -1;
    let windowMinMIN = 0;
    let windowMaxKL = -1;
    let windowMaxMIN = 0;
    for (let j = startIndex; j < startIndex + durationSlots; j++) {
      const w = processedRecords[j];
      if (w.total < windowMinKR) {
        windowMinKR = w.total;
        windowMinKL = w.hour;
        windowMinMIN = w.minute;
      }
      if (w.total > windowMaxKR) {
        windowMaxKR = w.total;
        windowMaxKL = w.hour;
        windowMaxMIN = w.minute;
      }
    }
    return {
      startKL: startQ.hour,
      startMIN: startQ.minute,
      startDato: startQ.timestamp,
      totalPris: windowSum,
      billigstKR: windowMinKR,
      billigstKL: windowMinKL,
      billigstMIN: windowMinMIN,
      dyrestKR: windowMaxKR,
      dyrestKL: windowMaxKL,
      dyrestMIN: windowMaxMIN
    };
  }

  function derivePeriodStats(resultat, found, runNowCost) {
    const startErNuHere = Boolean(
      found && resultat.startDato && resultat.startDato.getTime() === TimeNuMs
    );
    const korselSlutMs = (found && resultat.startDato)
      ? resultat.startDato.getTime() + durationSlots * 15 * 60 * 1000
      : 0;
    const korselNuHere = Boolean(
      found &&
      resultat.startDato &&
      TimeNuMs >= resultat.startDato.getTime() &&
      TimeNuMs < korselSlutMs
    );
    const runOpt = (found && resultat.startDato)
      ? runCostPerKw(resultat.startDato, ArgsAntalTimer)
      : { cost: 0, avg: 0, complete: false };
    let besparelse = 0;
    let ventetid = 0;
    if (found && !startErNuHere && runNowCost.complete && runOpt.complete) {
      besparelse = roundPrice(Math.max(0, runNowCost.cost - runOpt.cost));
      if (isValidDate(resultat.startDato)) {
        ventetid = Math.max(
          0,
          (resultat.startDato.getTime() - DatoNuStartpoint.getTime()) / (60 * 60 * 1000)
        );
        ventetid = Number(ventetid.toFixed(2));
      }
    }
    const slut = found
      ? shiftClock(resultat.startKL, resultat.startMIN, ArgsAntalTimer)
      : { h: -1, m: -1 };
    const snit = roundPrice(found && durationSlots ? (resultat.totalPris / durationSlots) : 0);
    const pct = (found && !startErNuHere && runNowCost.complete && runNowCost.cost > 0)
      ? roundPrice((besparelse / runNowCost.cost) * 100)
      : 0;
    const prVentetime = (besparelse > 0 && ventetid > 0)
      ? roundPrice(besparelse / ventetid)
      : 0;
    return {
      startErNu: startErNuHere,
      korselNu: korselNuHere,
      besparelse,
      ventetid,
      slut,
      snit,
      pct,
      prVentetime
    };
  }

  function resolveWaitLimit() {
    const raw = MaksimalVentetidTimer;
    if (typeof raw === "string" && raw.trim().toLowerCase() === "auto") {
      const cap = Number(VENT_AUTO_MAX_TIMER);
      return { mode: "auto", capHours: cap > 0 ? cap : 0 };
    }
    const n = Number(raw);
    return { mode: "fixed", capHours: n > 0 ? n : 0 };
  }

  function waitWorthAuto(waitHours, saveOreKwh) {
    const wait = Number(waitHours) || 0;
    const save = Number(saveOreKwh) || 0;
    if (!(wait > 0.02)) return true;
    const need = Math.max(Number(VENT_AUTO_MIN_ORE) || 0, (Number(VENT_AUTO_ORE_PR_TIME) || 0) * wait);
    return save >= need;
  }

  function isWithinMaxWait(waitHours, saveOreKwh, hasStartNow) {
    const wait = Number(waitHours);
    if (!(wait > 0.02)) return true;
    if (waitLimit.mode === "auto") {
      if (waitLimit.capHours > 0 && wait > waitLimit.capHours) return false;
      if (!hasStartNow) return true;
      return waitWorthAuto(wait, saveOreKwh);
    }
    if (!(waitLimit.capHours > 0)) return true;
    return wait <= waitLimit.capHours;
  }

  function maybeSnapAnbefaletForAutoWait(stat, runNowCost) {
    if (waitLimit.mode !== "auto") return;
    const rec = stat.anbefalet;
    if (!isWindowFound(rec) || !rec.startDato) return;
    if (rec.startDato.getTime() === TimeNuMs || rec.startDato.getTime() === SearchStartMs) return;
    if (!runNowCost || !runNowCost.complete) return;
    const runOpt = runCostPerKw(rec.startDato, ArgsAntalTimer);
    if (!runOpt.complete) return;
    const waitH = (rec.startDato.getTime() - DatoNuStartpoint.getTime()) / (60 * 60 * 1000);
    const saveOre = (runNowCost.avg - runOpt.avg) * 100;
    if (waitWorthAuto(waitH, saveOre)) return;
    if (isWindowFound(stat.startNu)) Object.assign(stat.anbefalet, stat.startNu);
  }

  function autoVentForklaring(runNowCost, absStats, absFound, starterNu) {
    const tom = { lang: "", kort: "" };
    if (waitLimit.mode !== "auto" || !starterNu || !absFound) return tom;
    if (absStats.startErNu || absStats.korselNu) return tom;
    if (!runNowCost || !runNowCost.complete) return tom;
    if (!(absStats.ventetid > 0) || !timespanStat.absolut.startDato) return tom;
    const runAbs = runCostPerKw(timespanStat.absolut.startDato, ArgsAntalTimer);
    if (!runAbs.complete) return tom;
    const saveOre = Math.round(Math.max(0, (runNowCost.avg - runAbs.avg) * 100));
    if (waitWorthAuto(absStats.ventetid, saveOre)) return tom;
    const waitTekst = String(absStats.ventetid).replace(".", ",");
    return {
      lang: "Der er en billigere periode om " + waitTekst + " t, men besparelsen er kun " + saveOre + " øre/kWh → start nu.",
      kort: "kun " + saveOre + " øre/kWh om " + waitTekst + " t"
    };
  }

  function zoneEndParts(zone) {
    if (!zone) return { h: -1, m: -1 };
    const end = new Date(zone.last.timestampMs + 15 * 60 * 1000);
    const p = copenhagenParts(end);
    return { h: p.hour, m: p.minute };
  }

  function resolveBilligPrisMinForskelOre(dayAvgKr) {
    const pct = Number(BilligPrisMinForskelPct);
    if (!(pct > 0)) return BilligPrisMinForskel;
    if (!(dayAvgKr > 0) || !Number.isFinite(dayAvgKr)) return BilligPrisMinForskel;
    return Math.max(1, Math.round(dayAvgKr * pct));
  }

  // kr pr. kW for at køre durationHours fra fromDate (ur-tid, overlap pr. kvarter).
  function indexAtOrAfter(fromMs) {
    const recs = processedRecords;
    const n = recs.length;
    const slotMs = 15 * 60 * 1000;
    let i = 0;
    if (quarterIndex && n) {
      if (fromMs >= SearchStartMs) i = quarterIndex.searchFrom;
      else if (fromMs >= TimeNuMs) i = quarterIndex.futureFrom;
      else if (quarterIndex.currentIndex >= 0) i = quarterIndex.currentIndex;
    }
    if (i > n) i = n;
    const anchor = recs[i];
    if (anchor && anchor.timestampMs + slotMs <= fromMs) {
      i = Math.min(n, i + Math.max(0, slotDiff(fromMs, anchor.timestampMs)));
      while (i > 0 && recs[i - 1].timestampMs + slotMs > fromMs) i--;
    }
    while (i < n && recs[i].timestampMs + slotMs <= fromMs) i++;
    return i;
  }

  function runCostPerKw(fromDate, durationHours) {
    const totalMinutes = Number(durationHours) * 60;
    if (!fromDate || !isValidDate(fromDate) || !(totalMinutes > 0)) {
      return { cost: 0, avg: 0, complete: false };
    }
    const fromMs = fromDate.getTime();
    const cache = runCostPerKw._cache || (runCostPerKw._cache = Object.create(null));
    const cacheKey = fromMs + ":" + durationHours;
    const cached = cache[cacheKey];
    if (cached) return cached;

    const slotMs = 15 * 60 * 1000;
    let minutesLeft = totalMinutes;
    let weighted = 0;
    let i = indexAtOrAfter(fromMs);
    for (; i < processedRecords.length; i++) {
      if (minutesLeft <= 0) break;
      const q = processedRecords[i];
      const overlapMin = (q.timestampMs + slotMs - Math.max(fromMs, q.timestampMs)) / 60000;
      if (overlapMin <= 0) continue;
      const take = Math.min(overlapMin, minutesLeft);
      weighted += q.total * take;
      minutesLeft -= take;
    }
    const used = totalMinutes - minutesLeft;
    const avg = used ? weighted / used : 0;
    const out = { cost: weighted / 60, avg, complete: minutesLeft < 1e-6 };
    cache[cacheKey] = out;
    return out;
  }

  function lastSundayOfMonth(year, monthIndex) {
    const last = new Date(year, monthIndex + 1, 0);
    last.setDate(last.getDate() - last.getDay());
    return last.getDate();
  }

  function expectedQuartersOnDay(dateObj) {
    const p = copenhagenParts(dateObj);
    const y = p.year;
    const m = p.month - 1;
    const d = p.day;
    if (m === 2 && d === lastSundayOfMonth(y, 2)) return 92;
    if (m === 9 && d === lastSundayOfMonth(y, 9)) return 100;
    return 96;
  }

  function cloneWindowStat(s) {
    return {
      gennemsnit: s.gennemsnit,
      billigstKR: s.billigstKR,
      billigstKL: s.billigstKL,
      billigstMIN: s.billigstMIN,
      dyrestKR: s.dyrestKR,
      dyrestKL: s.dyrestKL,
      dyrestMIN: s.dyrestMIN,
      timer: s.timer
    };
  }

  function dayListIsComplete(day, dayDate) {
    if (!day || !day.length || !dayDate) return false;
    const expected = expectedQuartersOnDay(dayDate);
    if (day.length !== expected) return false;
    const first = day[0];
    const last = day[day.length - 1];
    if (first.hour !== 0 || first.minute !== 0) return false;
    if (last.hour !== 23 || last.minute !== 45) return false;
    for (let i = 1; i < day.length; i++) {
      if (slotDiff(day[i], day[i - 1]) !== 1) return false;
    }
    return true;
  }

  function fillTimespanStats(idx, records, slots) {
    let sum = 0;
    let n = 0;
    const start = idx.searchFrom;
    const end = Math.min(records.length, start + slots);
    for (let i = start; i < end; i++) {
      sum += records[i].total;
      n++;
    }
    idx.timespanSum = sum;
    idx.timespanN = n;
  }

  function buildQuarterIndex(records) {
    const todayKey = idagStr;
    const byDay = Object.create(null);
    const dayStats = Object.create(null);
    const hourBucketsByDay = Object.create(null);
    const completeDays = Object.create(null);
    const nowMs = TimeNuMs;
    let futureFrom = records.length;
    let searchFrom = records.length;
    let currentIndex = -1;
    let prisNu = null;
    let timespanSum = 0;
    let timespanN = 0;
    let dups = 0;
    let missing = 0;
    let gaps = 0;
    let firstSearch = null;

    let prevDay = "";
    let hourBucket = null;
    let dayGapOk = true;
    let dayLast = null;

    const flushHour = () => {
      if (!hourBucket || !prevDay) return;
      hourBucketsByDay[prevDay].push({
        hour: hourBucket.hour,
        start: hourBucket.start,
        avg: hourBucket.sum / hourBucket.n
      });
      hourBucket = null;
    };

    const flushDay = () => {
      flushHour();
      if (!prevDay) return;
      const day = byDay[prevDay];
      const last = day[day.length - 1];
      const noon = noonFromDayKey(prevDay);
      completeDays[prevDay] = Boolean(
        dayGapOk &&
        noon &&
        day[0].hour === 0 &&
        day[0].minute === 0 &&
        last.hour === 23 &&
        last.minute === 45 &&
        day.length === expectedQuartersOnDay(noon)
      );
      dayGapOk = true;
      dayLast = null;
    };

    for (let i = 0; i < records.length; i++) {
      const q = records[i];
      if (i > 0) {
        const dt = slotDiff(q, records[i - 1]);
        if (dt === 0) dups++;
        else if (dt > 1) {
          gaps++;
          missing += dt - 1;
        }
      }
      if (futureFrom === records.length && q.timestampMs >= nowMs) futureFrom = i;
      if (searchFrom === records.length && q.timestampMs >= SearchStartMs) {
        searchFrom = i;
        firstSearch = q;
      }
      if (q.timestampMs === TimeNuMs) {
        currentIndex = i;
        prisNu = q;
      }
      const searchDiffSlots = slotDiff(q.timestampMs, SearchStartMs);
      if (searchDiffSlots >= 0 && searchDiffSlots < timespanSlots) {
        timespanSum += q.total;
        timespanN++;
      }
      if (q.minute === 0) {
        logTrace(`Time ${pad2(q.hour)}:00  ${q.total.toFixed(2)} kr  ${q.day}`);
      }

      if (q.day !== prevDay) {
        flushDay();
        prevDay = q.day;
        byDay[prevDay] = [];
        hourBucketsByDay[prevDay] = [];
        dayStats[prevDay] = {
          sum: 0,
          n: 0,
          min: q.total,
          minH: q.hour,
          minM: q.minute,
          max: q.total,
          maxH: q.hour,
          maxM: q.minute
        };
      }

      if (dayLast && slotDiff(q, dayLast) !== 1) dayGapOk = false;
      dayLast = q;
      byDay[prevDay].push(q);

      const ds = dayStats[prevDay];
      ds.sum += q.total;
      ds.n++;
      if (q.total < ds.min) {
        ds.min = q.total;
        ds.minH = q.hour;
        ds.minM = q.minute;
      }
      if (q.total > ds.max) {
        ds.max = q.total;
        ds.maxH = q.hour;
        ds.maxM = q.minute;
      }

      const hourStartMs = q.timestampMs - q.minute * 60 * 1000;
      if (!hourBucket || hourBucket.startMs !== hourStartMs) {
        flushHour();
        hourBucket = {
          hour: q.hour,
          start: new Date(hourStartMs),
          startMs: hourStartMs,
          sum: 0,
          n: 0
        };
      }
      hourBucket.sum += q.total;
      hourBucket.n++;
    }
    flushDay();

    const upcoming = Object.create(null);
    const s = emptyWindowStat();
    let total = 0;
    let lastSnap = null;
    const maxSlots = 8 * 4;
    const end = Math.min(records.length, futureFrom + maxSlots);
    for (let i = futureFrom; i < end; i++) {
      total = applyQuarterToWindowStat(s, records[i], total);
      s.gennemsnit = s.timer ? roundPrice(total / s.timer) : 0;
      lastSnap = cloneWindowStat(s);
      const n = i - futureFrom + 1;
      if (n % 4 === 0) upcoming[n / 4] = lastSnap;
    }
    if (lastSnap) {
      for (let h = 1; h <= 8; h++) {
        if (!upcoming[h]) upcoming[h] = lastSnap;
      }
    }

    return {
      todayKey,
      byDay,
      dayStats,
      hourBucketsByDay,
      completeDays,
      futureFrom,
      searchFrom,
      currentIndex,
      prisNu,
      timespanSum,
      timespanN,
      dups,
      missing,
      gaps,
      recordN: records.length,
      firstSearch,
      searchOff: firstSearch ? slotDiff(firstSearch.timestampMs, SearchStartMs) : null,
      todayRecords: byDay[todayKey] || [],
      upcoming
    };
  }

  function isCompleteLocalDay(records, dayDate) {
    const key = copenhagenDayKey(dayDate);
    if (quarterIndex && Object.prototype.hasOwnProperty.call(quarterIndex.completeDays, key)) {
      return quarterIndex.completeDays[key];
    }
    const day = [];
    for (const rec of records || []) {
      if (rec.day === key) day.push(rec);
    }
    return dayListIsComplete(day, dayDate);
  }

  // API-data → indeks (dagsstatistik, pris nu, søgevindue, huller) + smalle udsnit:
  // rang (i dag), speak (fra nu), zone (igangværende run), periode-søgning (søgevindue).
  function foldQuarterStats(records) {
    const ds = quarterIndex.dayStats[idagStr];
    const dagStat = (!ds || !ds.n)
      ? {
          totalPris: 0,
          timer: 0,
          gennemsnit: 0,
          billigstKR: 9999999,
          billigstKL: -1,
          billigstMIN: 0,
          dyrestKR: -10,
          dyrestKL: -1,
          dyrestMIN: 0
        }
      : {
          totalPris: ds.sum,
          timer: ds.n,
          gennemsnit: Number((ds.sum / ds.n).toFixed(2)),
          billigstKR: ds.min,
          billigstKL: ds.minH,
          billigstMIN: ds.minM,
          dyrestKR: ds.max,
          dyrestKL: ds.maxH,
          dyrestMIN: ds.maxM
        };

    const timespanStat = {
      totalPris: quarterIndex.timespanSum,
      timer: quarterIndex.timespanN,
      gennemsnit: Number((quarterIndex.timespanSum / (quarterIndex.timespanN || 1)).toFixed(2)),
      anbefalet: emptyWindowResult(),
      absolut: emptyWindowResult(),
      startNu: emptyWindowResult()
    };

    const prisNu = quarterIndex.prisNu;
    if (!prisNu) {
      logTrace("Fold: aktuelt kvarter mangler i datasættet");
      return { ok: false };
    }
    const PrisLigeNu = prisNu.total;
    const BilligPrisMinForskelOre = resolveBilligPrisMinForskelOre(
      dagStat.timer ? (dagStat.totalPris / dagStat.timer) : 0
    );
    logTrace(
      `Aktuelt kvarter ${formatClockHM(prisNu.hour, prisNu.minute)} · ${Number(PrisLigeNu).toFixed(2)} kr · dags-kvarter ${dagStat.timer} · søgevindue ${timespanStat.timer}`
    );

    const DagensOreVsSnit = Number(((PrisLigeNu - dagStat.gennemsnit) * 100).toFixed(0));
    const erBilligNu = DagensOreVsSnit < 0;
    const speakData = {
      billigTilKL: undefined,
      billigTilMIN: 0,
      naesteBilligKL: undefined,
      naesteBilligMIN: 0,
      naesteBilligKR: undefined,
      allerBilligstKR: undefined,
      allerBilligstKL: undefined,
      allerBilligstMIN: 0
    };

    const today = quarterIndex.todayRecords;
    let rankCheaper = 0;
    const rankCount = today.length;
    for (let t = 0; t < rankCount; t++) {
      if (today[t].total < PrisLigeNu) rankCheaper++;
    }

    const fromNow = quarterIndex.currentIndex >= 0 ? quarterIndex.currentIndex : quarterIndex.futureFrom;
    const searchFrom = quarterIndex.searchFrom;
    const speakEnd = Math.min(records.length, fromNow + timespanSlots);
    const lastStart = Math.min(
      records.length - durationSlots,
      searchFrom + timespanSlots - durationSlots
    );

    let zoneRun = null;
    let naesteZone = null;
    const nowMs = TimeNuMs;
    const slotMs = 15 * 60 * 1000;
    const threshold = dagStat.gennemsnit;
    let zoneStart = fromNow;
    if (threshold > 0 && zoneStart > 0 && records[zoneStart] && records[zoneStart].total < threshold) {
      while (zoneStart > 0 && records[zoneStart - 1].total < threshold) zoneStart--;
    }

    const minForbedringKR = (BilligPrisMinForskelOre * durationSlots) / 100;
    let slidingWindowSum = 0;
    let lastSlidingStartIndex = -2;
    const i0 = Math.max(0, Math.min(zoneStart, fromNow, searchFrom));
    const i1 = Math.max(speakEnd, dataQuality.safeForOptimization ? lastStart + 1 : speakEnd);

    for (let i = i0; i < i1; i++) {
      const q = records[i];

      if (i >= fromNow && i < speakEnd) {
        if (erBilligNu) {
          if (q.total >= dagStat.gennemsnit && speakData.billigTilKL == null) {
            speakData.billigTilKL = q.hour;
            speakData.billigTilMIN = q.minute;
          }
        } else if (q.total < dagStat.gennemsnit && speakData.naesteBilligKL == null) {
          speakData.naesteBilligKR = q.total;
          speakData.naesteBilligKL = q.hour;
          speakData.naesteBilligMIN = q.minute;
        }
        if (speakData.allerBilligstKL == null || q.total < speakData.allerBilligstKR) {
          speakData.allerBilligstKR = q.total;
          speakData.allerBilligstKL = q.hour;
          speakData.allerBilligstMIN = q.minute;
        }
      }

      if (threshold > 0 && !naesteZone && i >= zoneStart) {
        if (q.total < threshold) {
          if (!zoneRun) zoneRun = { start: q, last: q, slots: 0, sum: 0 };
          zoneRun.last = q;
          zoneRun.slots++;
          zoneRun.sum += q.total;
        } else if (zoneRun) {
          if (zoneRun.last.timestampMs + slotMs > nowMs) naesteZone = zoneRun;
          zoneRun = null;
        }
      }

      if (
        dataQuality.safeForOptimization &&
        i >= searchFrom &&
        i <= lastStart &&
        i + durationSlots <= records.length
      ) {
        const endRecord = records[i + durationSlots - 1];
        const endDiffSlots = slotDiff(endRecord.timestampMs, SearchStartMs);
        if (endDiffSlots < timespanSlots) {
          if (lastSlidingStartIndex === i - 1) {
            slidingWindowSum = slidingWindowSum - records[i - 1].total + endRecord.total;
          } else {
            slidingWindowSum = 0;
            for (let j = i; j < i + durationSlots; j++) {
              slidingWindowSum += records[j].total;
            }
          }
          lastSlidingStartIndex = i;

          const TimespanTotalpris_Udregnet = Number(slidingWindowSum.toFixed(4));
          const waitHours = (q.timestampMs - DatoNuMs) / (60 * 60 * 1000);
          const startNowSum = isWindowFound(timespanStat.startNu)
            ? timespanStat.startNu.totalPris
            : null;
          const saveOreKwh = (startNowSum != null && durationSlots)
            ? ((startNowSum - TimespanTotalpris_Udregnet) / durationSlots) * 100
            : 0;
          const withinMaxWait = isWithinMaxWait(waitHours, saveOreKwh, startNowSum != null);
          const beatsAbsolute = TimespanTotalpris_Udregnet < timespanStat.absolut.totalPris;
          const beatsRecommended = TimespanTotalpris_Udregnet < (timespanStat.anbefalet.totalPris - minForbedringKR);

          if (q.timestampMs === SearchStartMs || beatsAbsolute || (beatsRecommended && withinMaxWait)) {
            const snap = snapshotSearchWindow(q, TimespanTotalpris_Udregnet, i);
            if (q.timestampMs === SearchStartMs) {
              Object.assign(timespanStat.startNu, snap);
              logTrace(`Søg START NU ${formatClockHM(q.hour, q.minute)} · sum ${TimespanTotalpris_Udregnet.toFixed(2)}`);
            }
            if (beatsAbsolute) {
              Object.assign(timespanStat.absolut, snap);
              logTrace(`Søg ABS ${formatClockHM(q.hour, q.minute)} · sum ${TimespanTotalpris_Udregnet.toFixed(2)} · vent ${waitHours.toFixed(2)} t`);
            }
            if (beatsRecommended && withinMaxWait) {
              Object.assign(timespanStat.anbefalet, snap);
              logTrace(
                `Søg ANB ${formatClockHM(q.hour, q.minute)} · sum ${TimespanTotalpris_Udregnet.toFixed(2)} · vent ${waitHours.toFixed(2)} t · ${saveOreKwh.toFixed(1)} øre/kWh`
              );
            }
          }
        }
      }
    }

    if (!naesteZone && zoneRun && zoneRun.last.timestampMs + slotMs > nowMs) {
      naesteZone = zoneRun;
    }

    const rank = rankCount ? rankCheaper + 1 : 0;
    const percent = rankCount ? Number(((rank / rankCount) * 100).toFixed(1)) : 0;

    return {
      ok: true,
      dagStat,
      timespanStat,
      PrisLigeNu,
      prisNu,
      BilligPrisMinForskelOre,
      speakData,
      naesteZone,
      rangIDag: { rank, count: rankCount, percent }
    };
  }

  function analyzeQuarterQuality(todayDate) {
    const issues = [];
    if (!quarterIndex.recordN) {
      return { ok: false, issues: ["ingen kvarter"] };
    }

    const dups = quarterIndex.dups || 0;
    const missing = quarterIndex.missing || 0;
    const gaps = quarterIndex.gaps || 0;
    if (dups === 1) issues.push("1 dublet");
    else if (dups > 1) issues.push(`${dups} dubletter`);
    if (missing === 1) issues.push("1 manglende kvarter");
    else if (missing > 1) issues.push(`${missing} manglende kvarter`);
    else if (gaps) issues.push(`${gaps} hul i tidslinjen`);

    const todayN = quarterIndex.todayRecords.length;
    const expToday = expectedQuartersOnDay(todayDate);
    if (todayN !== expToday) {
      issues.push(`i dag ${todayN}/${expToday} kvarter`);
    }

    const firstSearch = quarterIndex.firstSearch;
    if (!firstSearch) {
      issues.push("mangler første forventede fremtidige kvarter");
    } else if (quarterIndex.searchOff !== 0) {
      issues.push(`første fremtidige kvarter ${formatClock(firstSearch.timestamp)} (forventet ${formatClock(SearchStartpoint)})`);
    }

    const safeForOptimization = (missing === 0 && gaps === 0);
    return { ok: issues.length === 0, safeForOptimization, issues, missing, dups, gaps };
  }

  function formatClockHM(hour, minute) {
    const h = Number(hour);
    const m = Number(minute) || 0;
    if (!Number.isFinite(h) || h < 0) return "-";
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  function hourBucketsForDay(dayKey) {
    const cached = quarterIndex && quarterIndex.hourBucketsByDay[dayKey];
    return cached || [];
  }

  function hourRankByIndex(buckets) {
    const n = buckets.length;
    const ranks = new Array(n);
    const order = buckets.map((b, i) => ({ i, avg: b.avg }))
      .sort((a, b) => a.avg - b.avg || a.i - b.i);
    for (let r = 0; r < n; r++) ranks[order[r].i] = r + 1;
    return ranks;
  }

  function barColorFromRank(rank, count) {
    if (!count) return "#eab308";
    if (rank <= Math.ceil(count * 0.10)) return "#15803d";
    if (rank <= Math.ceil(count * 0.25)) return "#22c55e";
    if (rank > Math.floor(count * 0.90)) return "#dc2626";
    if (rank > Math.floor(count * 0.75)) return "#ea580c";
    return "#eab308";
  }

  function statusEmojiFromRank(rank, count, asCurrent) {
    let emoji = "🟡";
    if (!count) emoji = "🟡";
    else if (rank <= Math.ceil(count * 0.10) || rank <= Math.ceil(count * 0.25)) emoji = "🟢";
    else if (rank > Math.floor(count * 0.90)) emoji = "🔴";
    else if (rank > Math.floor(count * 0.75)) emoji = "🟠";
    if (!asCurrent) return emoji;
    if (emoji === "🟢") return "🟩";
    if (emoji === "🔴") return "🟥";
    if (emoji === "🟠") return "🟧";
    return "🟨";
  }

  function currentHourIndex(buckets, nowDate) {
    if (!nowDate || !isValidDate(nowDate) || !buckets.length) return -1;
    const ms = nowDate.getTime();
    for (let i = 0; i < buckets.length; i++) {
      const start = buckets[i].start.getTime();
      if (ms >= start && ms < start + 60 * 60 * 1000) return i;
    }
    return -1;
  }

  function colorBarsForDay(dayKey, nowDate) {
    const buckets = hourBucketsForDay(dayKey);
    if (!buckets.length) return "-";
    const ranks = hourRankByIndex(buckets);
    const n = buckets.length;
    let currentIndex = currentHourIndex(buckets, nowDate);
    if (currentIndex < 0) currentIndex = 0;
    const start = Math.max(0, currentIndex - 2);
    let out = "";
    for (let i = start; i < n; i++) {
      out += statusEmojiFromRank(ranks[i], n, i === currentIndex);
    }
    return out;
  }

  function buildPriceBarChart(title, buckets, nowDate) {
    const ranks = hourRankByIndex(buckets);
    const n = buckets.length;
    const currentIndex = nowDate ? currentHourIndex(buckets, nowDate) : -1;
    const labels = buckets.map(b => pad2(b.hour));
    const chart = {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: buckets.map(b => Number(Number(b.avg).toFixed(2))),
          backgroundColor: buckets.map((_, i) => barColorFromRank(ranks[i], n)),
          borderColor: buckets.map((_, i) => i === currentIndex ? "#0f172a" : "rgba(0,0,0,0)"),
          borderWidth: buckets.map((_, i) => i === currentIndex ? 3 : 0),
          borderSkipped: false
        }]
      },
      options: {
        legend: { display: false },
        title: { display: true, text: title, fontSize: 14, fontColor: "#0f172a" },
        scales: {
          yAxes: [{
            ticks: { beginAtZero: false, fontColor: "#64748b" },
            gridLines: { color: "#e2e8f0" }
          }],
          xAxes: [{
            ticks: { fontSize: 9, fontColor: "#64748b", maxRotation: 0, minRotation: 0 },
            gridLines: { display: false }
          }]
        }
      }
    };
    if (currentIndex >= 0) {
      chart.options.annotation = {
        annotations: [{
          type: "line",
          mode: "vertical",
          scaleID: "x-axis-0",
          value: labels[currentIndex],
          borderColor: "#0f172a",
          borderWidth: 2,
          label: {
            enabled: true,
            content: "nu",
            position: "top",
            backgroundColor: "#0f172a",
            fontColor: "#ffffff"
          }
        }]
      };
    }
    return chart;
  }

  function rememberChartUrl(cacheKey, url) {
    const chartUrls = state.chartUrls || (state.chartUrls = {});
    chartUrls[cacheKey] = { url, at: Date.now() };
    const keys = Object.keys(chartUrls);
    if (keys.length > 8) {
      keys.sort((a, b) => (chartUrls[a].at || 0) - (chartUrls[b].at || 0));
      for (let i = 0; i < keys.length - 6; i++) delete chartUrls[keys[i]];
    }
    saveCacheState();
  }

  async function postQuickChart(chart) {
    try {
      const response = await safeFetch("https://quickchart.io/chart/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          width: 800,
          height: 360,
          backgroundColor: "white",
          format: "png",
          chart
        })
      });
      if (response && response.ok) {
        const data = await response.json();
        if (data && typeof data.url === "string" && data.url) return data.url;
      }
    } catch (_) {
      // Homey.fetch understøtter måske ikke POST — fald tilbage til GET
    }

    try {
      const encoded = encodeURIComponent(JSON.stringify(chart));
      if (encoded.length < 1800) {
        return `https://quickchart.io/chart?w=800&h=360&bkg=white&f=png&c=${encoded}`;
      }
    } catch (_) {
      // ignorer
    }
    return "";
  }

  async function chartUrlForToday(dayKey, hour, nowDate) {
    const hourKey = `${dayKey}|${hour}`;
    const prev = state.grafIDag;
    if (prev && prev.hourKey === hourKey && prev.url && prev.url !== "-") {
      logTrace("Graf i dag: genbruger URL (samme time).");
      return prev.url;
    }
    const url = await chartUrlForDay(dayKey, "Elpris i dag (kr/kWh inkl. moms)", nowDate);
    state.grafIDag = { hourKey, url, at: Date.now() };
    saveCacheState();
    return url || "-";
  }

  async function chartUrlForTomorrow(dayKey) {
    const fp = hourBucketsForDay(dayKey).map(b => b.avg.toFixed(3)).join(",");
    const prev = state.grafIMorgen;
    if (prev && prev.dayKey === dayKey && prev.fp === fp && prev.url && prev.url !== "-") {
      logTrace("Graf i morgen: genbruger URL (uændrede priser).");
      return prev.url;
    }
    const url = await chartUrlForDay(dayKey, "Elpris i morgen (kr/kWh inkl. moms)");
    state.grafIMorgen = { dayKey, fp, url, at: Date.now() };
    saveCacheState();
    return url || "-";
  }

  async function chartUrlForDay(dayKey, title, nowDate) {
    const buckets = hourBucketsForDay(dayKey);
    if (!buckets.length) return "-";
    const hourMark = nowDate && isValidDate(nowDate) ? String(copenhagenParts(nowDate).hour) : "";
    const cacheKey = `${dayKey}|h${hourMark}|${buckets.map(b => b.avg.toFixed(3)).join(",")}`;
    const hit = state.chartUrls && state.chartUrls[cacheKey];
    if (hit && hit.url && Date.now() - hit.at < 12 * 60 * 60 * 1000) return hit.url;

    const url = await postQuickChart(buildPriceBarChart(title, buckets, nowDate));
    if (url) rememberChartUrl(cacheKey, url);
    return url || "-";
  }

  function formatClock(dateObj) {
    if (!isValidDate(dateObj)) return String(dateObj);
    const p = copenhagenParts(dateObj);
    return formatClockHM(p.hour, p.minute);
  }

  function normalizeQuarterRecords(quarterRecords) {
    const seen = new Map();

    for (const r of quarterRecords) {
      const slot = slotInstantFromRecord(r);
      if (!isValidDate(slot)) continue;

      const price = Number(r.DayAheadPriceDKK ?? r.SpotPriceDKK);
      if (!Number.isFinite(price)) continue;

      const hourKey = String(slot.getTime());
      if (!seen.has(hourKey)) {
        seen.set(hourKey, {
          HourDK: fmtYmdHm(slot),
          TimeUTC: slot.toISOString(),
          SpotPriceDKK: price
        });
      }
    }

    const quarters = Array.from(seen.values()).sort((a, b) => {
      const ta = parseApiUtc(a.TimeUTC);
      const tb = parseApiUtc(b.TimeUTC);
      return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
    });
    logTrace(`ℹ️ Normaliserede ${quarterRecords.length} day-ahead-rækker til ${quarters.length} kvarter.`);
    return quarters;
  }

  function getDKTime() {
    return new Date();
  }

  function fmtKr(n) {
    return roundPrice(n).toFixed(2).replace('.', ',');
  }

  function padRight(text, width) {
    let s = String(text);
    while (s.length < width) s += " ";
    return s;
  }

  function shiftClock(hour, minute, addHours) {
    let total = hour * 60 + (Number(minute) || 0) + Math.round(Number(addHours) * 60);
    const dayMin = 24 * 60;
    total = ((total % dayMin) + dayMin) % dayMin;
    return { h: Math.floor(total / 60), m: total % 60 };
  }

  function logLine(icon, text) {
    log(`${icon} ${text}`);
  }

  function fmtSignedKr(n) {
    const v = roundPrice(n);
    if (!v) return "0,00 kr";
    return (v < 0 ? "−" : "+") + fmtKr(Math.abs(v)) + " kr";
  }

  function fmtSignedPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0) return "0,0 %";
    return (v < 0 ? "−" : "+") + String(Math.abs(v)).replace(".", ",") + " %";
  }

  function fmtTimerMin(hours) {
    const min = Math.max(0, Math.round(Number(hours) * 60));
    const t = Math.floor(min / 60);
    const m = min % 60;
    if (t && m) return t + " t " + m + " min";
    if (t) return t + " t";
    return m + " min";
  }

  function logRunSummary() {
    const nuKl = formatClock(DatoNuStartpoint);
    const slotStart = formatClock(TimeNuStartpoint);
    const slotParts = copenhagenParts(TimeNuStartpoint);
    const slotSlut = shiftClock(slotParts.hour, slotParts.minute, 0.25);
    const slotTekst = `${slotStart}–${formatClockHM(slotSlut.h, slotSlut.m)}`;
    const underTaerskel = PrisLigeNu <= SMERTETAERSKEL_KR;
    const vsDag = roundPrice(PrisLigeNu - dagStat.gennemsnit);
    const vsDagTekst = !vsDag
      ? "som dagens snit"
      : fmtKr(Math.abs(vsDag)) + " kr " + (vsDag > 0 ? "over" : "under") + " dagens snit";
    const profilKort = hourProfil.kort === "lærer"
      ? "lærer timeprofil"
      : hourProfil.kort.replace(/^normalt /, "");
    logLine(
      "⚡",
      `Elpris ${PriceArea} · ${nuKl} · ${fmtKr(PrisLigeNu)} kr · ${vsDagTekst} · ${tendensNu.split(" — ")[0]} · ${profilKort} · ${systemstatus.kort}`
    );

    if (!fandtPeriode) {
      logLine("⏱️", `Ingen anbefalet ${ArgsAntalTimer} t-periode i de næste ${ArgsTimespan} t`);
    } else {
      const start = formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN);
      const slut = formatClockHM(periodeSlut.h, periodeSlut.m);
      const venter = !startErNu && !korselNu;
      logLine(
        korselNu || startErNu ? "▶" : "⏳",
        `Anbefalet ${start}–${slut} · kør nu: ${korselNu ? "ja" : "nej"} · vent: ${venter ? "ja" : "nej"}`
      );
      let sparKwh = Number(sparePotentiale.krKwh) || 0;
      let ventVis = Number(ventetidTilOptimalTimer) || 0;
      if (!venter && fandtAbsolut && absolut.ventetid > 0 && !absolut.startErNu) {
        sparKwh = roundPrice(Math.max(0, PrisLigeNu - absolut.snit));
        ventVis = Number(absolut.ventetid) || 0;
      }
      if (ventVis > 0 && sparKwh > 0) {
        logLine("💰", `Vent ${fmtTimerMin(ventVis)} → spar ${fmtKr(sparKwh)} kr/kWh`);
      }
    }

    const prevP = prevProfile.lastPriceNow;
    const currP = roundPrice(PrisLigeNu);
    if (typeof prevP === "number" && prevP !== currP) {
      logLine(currP > prevP ? "📈" : "📉", `Pris ${currP > prevP ? "steget" : "faldet"} · ${fmtKr(prevP)} → ${fmtKr(currP)} kr`);
    } else {
      logLine("↔️", `Pris uændret · ${fmtKr(currP)} kr`);
    }

    const statusHoved = statusNu || statusPeriode || statusRangIDag || "—";
    if (statusNorm.bandsKlar && statusNorm.bands) {
      const b = statusNorm.bands;
      logLine("ℹ️", `Hos dig: ${statusHoved} · ${statusNorm.bandN} døgn`);
      log(
        `   Dine grænser: meget billig ${fmtKr(b.p10)} kr · billig ${fmtKr(b.p25)} kr · dyr ${fmtKr(b.p75)} kr · meget dyr ${fmtKr(b.p90)} kr`
      );
    } else {
      logLine(
        "ℹ️",
        `Hos dig: ${statusHoved} · lærer stadig (${statusNorm.bandN || 0} af ${TIMEPROFIL_MIN_DAGE} døgn, nu ${statusNorm.kilde || "typisk"})`
      );
    }
    if (vsTypisk.typisk > 0) {
      log(`   Typisk ${fmtKr(vsTypisk.typisk)} kr · nu ${fmtKr(PrisLigeNu)} kr (${fmtSignedPct(vsTypisk.pct)})`);
    } else {
      log("   Typisk: —");
    }
    if (rangIDag && rangIDag.count) {
      log(`   I dag: ${statusRangIDag} · ${rangIDag.rank}. billigste kvarter af ${rangIDag.count}`);
    } else {
      log(`   I dag: ${statusRangIDag || "—"}`);
    }

    const profilKl = fmtProfilHour(hourProfil.hour);
    if (hourProfil.dage >= TIMEPROFIL_MIN_DAGE) {
      logLine("🕐", `Kl. ${profilKl} plejer at være ${hourProfil.kort.replace(/^normalt /, "")} · ${hourProfil.datagrundlag}`);
    } else {
      logLine("🕐", `Timeprofil lærer stadig · ${hourProfil.datagrundlag}`);
    }
    for (const change of profileChanges) {
      if (change.kind === "price" || change.kind === "status") continue;
      const icon = change.kind === "period" ? "🔄" : "ℹ️";
      logLine(icon, change.text);
    }

    if (dataQuality.issues.length) {
      logLine("⚠️", `Datakvalitet: ${dataQuality.issues.join(" · ")}`);
      if (!dataQuality.safeForOptimization) {
        logLine("⛔", "Optimering deaktiveret — huller i data");
      }
    }
    const netKilde = FetchedGridTariff ? "API" : "fallback";
    const enKilde = (typeof FetchedEnerginetTariff === "number") ? "API" : "fallback";
    if (netKilde !== "API" || enKilde !== "API") {
      logLine("🔌", `Tarif-fallback  net ${netKilde}  ·  Energinet ${enKilde}`);
    }

    if (!isDebug()) return;

    const line = "──────── DEBUG ────────";
    log("");
    log(line);
    const firstQ = processedRecords[0];
    const lastQ = processedRecords[processedRecords.length - 1];
    const enhedFelter = dashboardFields.filter(f => !f.skipDevice && onDevice[f.key]).length;
    const enhedMangler = dashboardFields.filter(f => !f.skipDevice && !f.deviceOnly && !onDevice[f.key]).map(f => f.titles[0]);
    log(`Kørsel   ${priceAreaNorm} · args ${ArgsAntalTimer},${ArgsTimespan} t · wait ${waitLimit.mode}${waitLimit.capHours ? " loft " + waitLimit.capHours + " t" : ""} · settings-cache ${settingsCacheHit ? "hit" : "miss"}`);
    log(`Tid      ${formatClock(DatoNuStartpoint)} · kvarter ${slotTekst} · søg fra ${formatClock(SearchStartpoint)} · ${remainingInSlot} min tilbage i slot`);
    log(
      `Data     ${processedRecords.length} kvarter` +
      (firstQ && lastQ ? ` · ${formatClock(firstQ.timestamp)} → ${formatClock(lastQ.timestamp)}` : "") +
      ` · i dag ${dagStat.timer} · i morgen ${iMorgenKlar ? "klar" : "nej"}`
    );
    log(`Tarif    net ${FetchedGridTariff ? "API" : "fallback"} · Energinet ${typeof FetchedEnerginetTariff === "number" ? "API" : "fallback"}`);
    if (runNow && runNow.complete) {
      log(`Nu-kørsel snit ${fmtKr(runNow.avg)} kr/kWh · ${ArgsAntalTimer} t fra nu`);
    }
    if (fandtPeriode) {
      log(
        `Periode  ${formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN)}–${formatClockHM(periodeSlut.h, periodeSlut.m)}` +
        ` · snit ${fmtKr(anbefalet.snit)} kr · ${anbefaletErAbsolut ? "samme som absolut" : "hysterese"}` +
        ` · ${venteRaad.beslutning}`
      );
    } else {
      log(`Periode  ingen ${ArgsAntalTimer} t i ${ArgsTimespan} t`);
    }
    if (fandtAbsolut) {
      log(
        `Absolut  ${formatClockHM(timespanStat.absolut.startKL, timespanStat.absolut.startMIN)}` +
        ` · snit ${fmtKr(absolut.snit)} kr · vent ${fmtTimerMin(absolut.ventetid)}`
      );
    }
    if (autoVent.lang) log(`Auto     ${autoVent.lang}`);
    log(`Fejl     ${currentRunErrors.length ? currentRunErrors.join(" ") : "ingen"}`);
    log(
      `Homey    enhed ${elprisDevice ? "ja (" + enhedFelter + " felter)" : "nej"}` +
      (enhedMangler.length ? ` · tags: ${enhedMangler.join(", ")}` : "") +
      ` · ${tagsWritten} tag-ændringer` +
      ` · ${tagsUnchanged} uændret` +
      (alarmSyncNote ? ` · ur ${alarmSyncNote}` : "")
    );
    log(`Ms       API ${tAfterApi - tStart} ms · beregning ${tAfterCalc - tAfterApi} ms · Homey ${tAfterHomey - tAfterCalc} ms`);
    logLine("🎯", `Smertetærskel ${fmtKr(SMERTETAERSKEL_KR)} kr · ${underTaerskel ? "under" : "over"}`);
    if (prisNu) {
      logLine("📋", `Prisdele  spot ${fmtKr(prisNu.spot)} · net ${fmtKr(prisNu.nettarif)} · EN ${fmtKr(prisNu.energinet)} · afgift ${fmtKr(prisNu.elafgift)} · tillæg ${fmtKr(prisNu.tillaeg)} · moms ${fmtKr(prisNu.moms)}`);
    }
    if (hourProfil.doegn) log(`Døgn     ${hourProfil.doegn}`);
    if (naesteZone) {
      log(`Zone     ${formatClock(naesteZone.start.timestamp)}–${formatClockHM(zoneSlut.h, zoneSlut.m)} · ${iBilligZone ? "i zonen nu" : "næste"}`);
    }
    log(
      `Min. forskel ${BilligPrisMinForskelOre} øre/kWh` +
      (BilligPrisMinForskelPct > 0 && dagStat.timer ? ` (${BilligPrisMinForskelPct} % af dags-snit)` : " (fast)")
    );
    log(line);

    if (!isTrace()) return;
    log("");
    log("──────── TRACE ────────");
    log(`Niveau   ${String(LOG_LEVEL).trim().toUpperCase()} (${LOG_NIVEAU}) · forceAll enhedsfelter`);
    log(`Speak    ${Speak_GenerelRapport}`);
    log(`Speak p  ${Speak_FundneTimerRapport}`);
    if (dataQuality && dataQuality.issues && dataQuality.issues.length) {
      log(`Kvalitet ${dataQuality.issues.join(" · ")} · optimering ${dataQuality.safeForOptimization ? "ja" : "nej"}`);
    }
    log(line);
  }

  function getNetTariffExMoms(dateObj, gridTariffObj, clock) {
    const p = clock || copenhagenParts(dateObj);
    if (gridTariffObj) {
      const h = p.hour;
      const priceKey = `Price${h + 1}`;
      if (Object.prototype.hasOwnProperty.call(gridTariffObj, priceKey) && gridTariffObj[priceKey] !== null) {
        return Number(gridTariffObj[priceKey]) || 0;
      }
      if (!missingTariffKeysLogged[priceKey]) {
        missingTariffKeysLogged[priceKey] = true;
        log(`Advarsel: Mangler ${priceKey} i API tariff-data. Falder tilbage til manuelle satser for denne time.`);
      }
    }

    const h = p.hour;
    const month = p.month - 1;
    const dayOfWeek = weekdayFromParts(p);
    const isWinter = (month >= 9 || month < 3);
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

    let netInkl = Pris_Lavlast;
    if (!isWeekend) {
      if (h >= 6 && h < 17) netInkl = Pris_Hojlast;
      else if (h >= 17 && h < 21) netInkl = isWinter ? Pris_Spids : Pris_Hojlast;
      else if (h >= 21 && h < 24) netInkl = Pris_Hojlast;
    }
    return netInkl / 1.25;
  }

  function buildPriceParts(spotEksMoms, dateObj, gridTariffObj, energinetInklMoms, elafgiftInklMoms, clock) {
    const raaEks = Number(spotEksMoms) || 0;
    const tillaegEks = ELSKAB_TILLAEG_INKL_MOMS / 1.25;
    const dk = clock || copenhagenParts(dateObj);

    if (IGNORER_NETTARIF_OG_ELAFGIFT) {
      const sumEks = raaEks + tillaegEks;
      const moms = sumEks * 0.25;
      return {
        raaEks, nettarifEks: 0, energinetEks: 0, elafgiftEks: 0, tillaegEks, moms,
        totalInkl: sumEks + moms
      };
    }

    const energinetInkl = (typeof energinetInklMoms === "number")
      ? energinetInklMoms
      : ENERGINET_TARIF_INKL_MOMS;

    const nettarifEks = getNetTariffExMoms(dateObj, gridTariffObj, dk);
    const energinetEks = energinetInkl / 1.25;
    const elafgiftInkl = (typeof elafgiftInklMoms === "number")
      ? elafgiftInklMoms
      : elafgiftInklForAar(dk.year);
    const elafgiftEks = elafgiftInkl / 1.25;
    const sumEks = raaEks + nettarifEks + energinetEks + elafgiftEks + tillaegEks;
    const moms = sumEks * 0.25;

    return {
      raaEks, nettarifEks, energinetEks, elafgiftEks, tillaegEks, moms,
      totalInkl: sumEks + moms
    };
  }

  function buildQuarter(spotEksMoms, dateObj, gridTariffObj, energinetInklMoms, elafgiftInklMoms) {
    const clock = copenhagenParts(dateObj);
    const parts = buildPriceParts(spotEksMoms, dateObj, gridTariffObj, energinetInklMoms, elafgiftInklMoms, clock);
    return {
      timestamp: dateObj,
      timestampMs: dateObj.getTime(),
      spot: roundPrice(parts.raaEks),
      nettarif: roundPrice(parts.nettarifEks),
      energinet: roundPrice(parts.energinetEks),
      elafgift: roundPrice(parts.elafgiftEks),
      tillaeg: roundPrice(parts.tillaegEks),
      moms: roundPrice(parts.moms),
      total: Number(parts.totalInkl.toFixed(2)),
      day: dayKeyFromParts(clock),
      hour: clock.hour,
      minute: clock.minute
    };
  }

  function formatSpeechPrice(price) {
    const isNegative = Number(price) < 0;
    const absPrice = Math.abs(Number(price) || 0);
    const totalOre = Math.round(absPrice * 100);

    const kroner = Math.floor(totalOre / 100);
    const ore = totalOre % 100;

    const sign = (isNegative && totalOre > 0) ? "-" : "";
    const kroneTekst = (kroner === 1) ? "krone" : "kroner";
    
    if (kroner === 0 && ore === 0) {
      return "0 kroner";
    } else if (kroner === 0) {
      return `${sign}${ore} øre`;
    } else if (ore === 0) {
      return `${sign}${kroner} ${kroneTekst} lige`;
    } else {
      return `${sign}${kroner} ${kroneTekst} og ${ore} øre`;
    }
  }

  function formatOreAmount(ore) {
    const abs = Math.abs(Number(ore) || 0);
    if (abs === 0) return "0 øre";
    return formatSpeechPrice(abs / 100).replace(/ lige$/, "");
  }

  function roundPrice(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
  }

  function prettySpeak(txt) {
    return String(txt)
      .replace(/kl\. /g, "kl_TEMP_ ")
      .replace(/\. /g, ".\n")
      .replace(/kl_TEMP_ /g, "kl. ")
      .replace(/(-?\d+ (?:kroner?|øre)(?: lige| og \d+ øre)?)/g, "**$1**");
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function validateUserSettings() {
    const fejl = [];
    const tal = (navn, v, min, max) => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        fejl.push(navn + " skal være et tal");
        return false;
      }
      if (min != null && v < min) fejl.push(navn + " må ikke være under " + min);
      if (max != null && v > max) fejl.push(navn + " må ikke være over " + max);
      return true;
    };
    const bool = (navn, v) => {
      if (v !== true && v !== false) fejl.push(navn + " skal være true eller false");
    };
    const valg = (navn, v, tilladt) => {
      const k = String(v == null ? "" : v).trim().toUpperCase();
      if (tilladt.indexOf(k) < 0) fejl.push(navn + " skal være " + tilladt.join(", "));
    };

    tal("BilligPrisMinForskelPct", BilligPrisMinForskelPct, 0, 100);
    tal("BilligPrisMinForskel", BilligPrisMinForskel, 0, 500);
    if (typeof MaksimalVentetidTimer === "string" && MaksimalVentetidTimer.trim().toLowerCase() === "auto") {
      tal("VENT_AUTO_MIN_ORE", VENT_AUTO_MIN_ORE, 0, 200);
      tal("VENT_AUTO_ORE_PR_TIME", VENT_AUTO_ORE_PR_TIME, 0, 100);
      tal("VENT_AUTO_MAX_TIMER", VENT_AUTO_MAX_TIMER, 0, 48);
    } else {
      tal("MaksimalVentetidTimer", MaksimalVentetidTimer, 0, 24);
    }
    tal("BESPARELSE_EKSEMPEL_KW", BESPARELSE_EKSEMPEL_KW, 0.1, 50);
    bool("AUTO_FETCH_TARIFF", AUTO_FETCH_TARIFF);
    bool("AUTO_FETCH_ENERGINET", AUTO_FETCH_ENERGINET);
    if (!/^\d{13}$/.test(String(ENERGINET_GLN || "").trim())) {
      fejl.push("ENERGINET_GLN skal være 13 cifre");
    }
    tal("ELSKAB_TILLAEG_INKL_MOMS", ELSKAB_TILLAEG_INKL_MOMS, 0, 2);
    tal("ENERGINET_TARIF_INKL_MOMS", ENERGINET_TARIF_INKL_MOMS, 0, 2);
    bool("IGNORER_NETTARIF_OG_ELAFGIFT", IGNORER_NETTARIF_OG_ELAFGIFT);
    valg("LOG_LEVEL", LOG_LEVEL, ["INFO", "DEBUG", "TRACE"]);
    bool("GRAF_URL", GRAF_URL);
    bool("AFINSTALLER", AFINSTALLER);

    const tz = String(TIDSZONE || "").trim().toLowerCase();
    if (tz && tz !== "europe/copenhagen" && tz !== "auto") {
      fejl.push("TIDSZONE skal være Europe/Copenhagen eller Auto");
    }

    if (typeof elprisDeviceName !== "string") {
      fejl.push("elprisDeviceName skal være tekst (eller tom streng)");
    }
    if (elprisDeviceCapIds != null && (typeof elprisDeviceCapIds !== "object" || Array.isArray(elprisDeviceCapIds))) {
      fejl.push("elprisDeviceCapIds skal være et objekt");
    }
    if (typeof ELPRIS_ALARM_NAVN !== "string") {
      fejl.push("ELPRIS_ALARM_NAVN skal være tekst");
    }

    tal("SMERTETAERSKEL_KR", SMERTETAERSKEL_KR, 0, 10);
    bool("STATUS_VS_PERIODE", STATUS_VS_PERIODE);
    tal("STATUS_LAERING", STATUS_LAERING, 0.01, 1);
    tal("TIMEPROFIL_MIN_DAGE", TIMEPROFIL_MIN_DAGE, 1, 14);
    tal("STATUS_BILLIG_PCT", STATUS_BILLIG_PCT, 1, 80);
    tal("STATUS_MEGET_BILLIG_PCT", STATUS_MEGET_BILLIG_PCT, 1, 90);
    tal("STATUS_DYR_PCT", STATUS_DYR_PCT, 1, 80);
    tal("STATUS_MEGET_DYR_PCT", STATUS_MEGET_DYR_PCT, 1, 200);
    tal("STATUS_BILLIG_KR", STATUS_BILLIG_KR, 0, 5);
    tal("STATUS_MEGET_BILLIG_KR", STATUS_MEGET_BILLIG_KR, 0, 5);
    tal("STATUS_DYR_KR", STATUS_DYR_KR, 0, 5);
    tal("STATUS_MEGET_DYR_KR", STATUS_MEGET_DYR_KR, 0, 10);
    if (STATUS_MEGET_BILLIG_PCT < STATUS_BILLIG_PCT) {
      fejl.push("STATUS_MEGET_BILLIG_PCT skal være større end STATUS_BILLIG_PCT");
    }
    if (STATUS_MEGET_DYR_PCT < STATUS_DYR_PCT) {
      fejl.push("STATUS_MEGET_DYR_PCT skal være større end STATUS_DYR_PCT");
    }
    if (STATUS_MEGET_BILLIG_KR < STATUS_BILLIG_KR) {
      fejl.push("STATUS_MEGET_BILLIG_KR skal være større end STATUS_BILLIG_KR");
    }
    if (STATUS_MEGET_DYR_KR < STATUS_DYR_KR) {
      fejl.push("STATUS_MEGET_DYR_KR skal være større end STATUS_DYR_KR");
    }
    tal("TENDENS_KORT_T", TENDENS_KORT_T, 1, 7);
    tal("TENDENS_LANG_T", TENDENS_LANG_T, 1, 8);
    tal("TENDENS_PCT", TENDENS_PCT, 0, 50);
    tal("TENDENS_KR", TENDENS_KR, 0, 2);
    if (TENDENS_LANG_T <= TENDENS_KORT_T) {
      fejl.push("TENDENS_LANG_T skal være større end TENDENS_KORT_T");
    }
    const lavOk = tal("Pris_Lavlast", Pris_Lavlast, 0, 10);
    const hojOk = tal("Pris_Hojlast", Pris_Hojlast, 0, 10);
    const spidsOk = tal("Pris_Spids", Pris_Spids, 0, 10);
    if (lavOk && hojOk && Pris_Hojlast < Pris_Lavlast) {
      fejl.push("Pris_Hojlast må ikke være lavere end Pris_Lavlast");
    }
    if (hojOk && spidsOk && Pris_Spids < Pris_Hojlast) {
      fejl.push("Pris_Spids må ikke være lavere end Pris_Hojlast");
    }

    const afg = ELAFGIFT_INKL_MOMS_PR_AAR;
    if (!afg || typeof afg !== "object" || Array.isArray(afg)) {
      fejl.push("ELAFGIFT_INKL_MOMS_PR_AAR skal være et objekt med år: beløb");
    } else {
      const years = Object.keys(afg);
      if (!years.length) fejl.push("ELAFGIFT_INKL_MOMS_PR_AAR er tom");
      for (let i = 0; i < years.length; i++) {
        const y = Number(years[i]);
        const kr = afg[years[i]];
        if (!Number.isInteger(y) || y < 2000 || y > 2100) {
          fejl.push("ELAFGIFT_INKL_MOMS_PR_AAR har ugyldigt år " + years[i]);
        }
        if (typeof kr !== "number" || !Number.isFinite(kr) || kr < 0 || kr > 5) {
          fejl.push("ELAFGIFT_INKL_MOMS_PR_AAR[" + years[i] + "] skal være kr/kWh mellem 0 og 5");
        }
      }
    }

    if (NETSELSKAB_KATALOG && typeof NETSELSKAB_KATALOG === "object") {
      const navne = Object.keys(NETSELSKAB_KATALOG);
      for (let i = 0; i < navne.length; i++) {
        const gln = String(NETSELSKAB_KATALOG[navne[i]] || "");
        if (!/^\d{13}$/.test(gln)) {
          fejl.push("NETSELSKAB_KATALOG[" + navne[i] + "] skal være 13-cifret GLN");
        }
      }
    }

    return fejl;
  }

  function rawScriptArgsKey(argsData) {
    if (argsData == null || argsData === "") return "";
    if (typeof argsData === "string") return argsData;
    if (Array.isArray(argsData) && argsData.length) return String(argsData[0] ?? "");
    return String(argsData);
  }

  function settingsSignature(argsKey) {
    return JSON.stringify({
      args: String(argsKey ?? ""),
      PriceArea,
      BilligPrisMinForskelPct,
      BilligPrisMinForskel,
      MaksimalVentetidTimer,
      VENT_AUTO_MIN_ORE,
      VENT_AUTO_ORE_PR_TIME,
      VENT_AUTO_MAX_TIMER,
      VENT_MIN_KR_PR_KW,
      VENT_MIN_TOTAL_KR,
      VENT_ALLTID_UNDER_KW,
      BESPARELSE_EKSEMPEL_KW,
      AUTO_FETCH_TARIFF,
      AUTO_FETCH_ENERGINET,
      ENERGINET_GLN,
      ELSKAB_TILLAEG_INKL_MOMS,
      ENERGINET_TARIF_INKL_MOMS,
      NETSELSKAB_VALG,
      ELAFGIFT_INKL_MOMS_PR_AAR,
      IGNORER_NETTARIF_OG_ELAFGIFT,
      LOG_LEVEL,
      GRAF_URL,
      TIDSZONE,
      elprisDeviceName,
      elprisDeviceCapIds,
      ELPRIS_ALARM_NAVN,
      SMERTETAERSKEL_KR,
      STATUS_VS_PERIODE,
      STATUS_LAERING,
      TIMEPROFIL_MIN_DAGE,
      STATUS_BILLIG_PCT,
      STATUS_MEGET_BILLIG_PCT,
      STATUS_DYR_PCT,
      STATUS_MEGET_DYR_PCT,
      STATUS_BILLIG_KR,
      STATUS_MEGET_BILLIG_KR,
      STATUS_DYR_KR,
      STATUS_MEGET_DYR_KR,
      TENDENS_KORT_T,
      TENDENS_LANG_T,
      TENDENS_PCT,
      TENDENS_KR,
      Pris_Lavlast,
      Pris_Hojlast,
      Pris_Spids
    });
  }

  function settingsCacheValid(signature) {
    const cache = state.settingsCache;
    if (!cache || cache.signature !== signature || !cache.values) return false;
    const v = cache.values;
    return (
      Number(v.ArgsAntalTimer) > 0 &&
      Number(v.ArgsTimespan) > 0 &&
      (v.priceAreaNorm === "DK1" || v.priceAreaNorm === "DK2") &&
      v.waitLimit &&
      (v.waitLimit.mode === "auto" || v.waitLimit.mode === "fixed")
    );
  }

  function settingsError(kode, message) {
    const err = new Error(message || "");
    err.elprisKode = kode;
    return err;
  }

  function buildSettingsValues(argsData) {
    const parsed = parseScriptArguments(argsData);
    const settingFejl = validateUserSettings();
    if (settingFejl.length) throw settingsError("F-602", settingFejl.join(" · "));
    const priceAreaNorm = String(PriceArea || "").trim().toUpperCase();
    if (priceAreaNorm !== "DK1" && priceAreaNorm !== "DK2") {
      throw settingsError("A-107", String(PriceArea || "").trim() || "(tom)");
    }
    return {
      ArgsAntalTimer: parsed.ArgsAntalTimer,
      ArgsTimespan: parsed.ArgsTimespan,
      priceAreaNorm,
      waitLimit: resolveWaitLimit()
    };
  }

  function parseScriptArguments(argsData) {
    let ArgsAntalTimer = 2;
    let ArgsTimespan = 16;

    let argsString = null;
    if (typeof argsData === 'string') {
      argsString = argsData;
    } else if (Array.isArray(argsData) && argsData.length > 0) {
      argsString = argsData[0];
    }

    if (argsString) {
      const ArgsArray = String(argsString).split(",").map(s => s.trim());
      if (ArgsArray.length !== 2) {
        throw new Error("Der skal være præcist 2 arguments adskilt af komma (fx '3,12')");
      }
      ArgsAntalTimer = parseInt(ArgsArray[0], 10);
      ArgsTimespan = parseInt(ArgsArray[1], 10);
    }

    if (!Number.isFinite(ArgsAntalTimer) || !Number.isFinite(ArgsTimespan)) {
      throw new Error("Der skal indtastes 2 nummer-værdier som arguments");
    }
    if (ArgsAntalTimer > ArgsTimespan) throw new Error("Timespan skal være større end eller lig med antal billige timer");
    if (ArgsTimespan > 24) throw new Error("Timespan må max være 24 timer");
    if (ArgsAntalTimer <= 0 || ArgsTimespan <= 0) throw new Error("Arguments skal være større end 0");

    return { ArgsAntalTimer, ArgsTimespan };
  }

  function priceCacheCoversNow(entry, now) {
    if (!entry || !Array.isArray(entry.records) || !entry.records.length || !now) return false;
    const today = copenhagenDayKey(now);
    if (entry.daysCovered && entry.daysCovered.indexOf(today) >= 0) {
      const last = slotInstantFromRecord(entry.records[entry.records.length - 1]);
      if (!isValidDate(last)) return true;
      return now.getTime() <= last.getTime() + 15 * 60 * 1000;
    }
    const first = slotInstantFromRecord(entry.records[0]);
    const last = slotInstantFromRecord(entry.records[entry.records.length - 1]);
    if (!isValidDate(first) || !isValidDate(last)) return false;
    return now.getTime() >= first.getTime() && now.getTime() <= last.getTime() + 15 * 60 * 1000;
  }

  function pickUsablePriceCache(priceArea, now) {
    const cache = state.priceCache || {};
    let best = null;
    const keys = Object.keys(cache);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(priceArea + "_") !== 0) continue;
      const entry = cache[keys[i]];
      if (!priceCacheCoversNow(entry, now)) continue;
      if (!best || (entry.cachedAt || 0) > (best.cachedAt || 0)) best = entry;
    }
    return best;
  }

  async function fetchPricesFromApi(priceArea) {
    const dkTime = getDKTime();
    const pNow = copenhagenParts(dkTime);
    const cacheKey = `${priceArea}_${fmtYmd(dkTime)}_${pNow.hour >= 13 ? "m13" : "m0"}_w2`;
    const wantTomorrow = pNow.hour > 12 || (pNow.hour === 12 && pNow.minute >= 30);
    const cacheMaxAgeMs = 14 * 60 * 60 * 1000;
    const tomorrow = new Date(Date.UTC(pNow.year, pNow.month - 1, pNow.day + 1));
    const tomorrowKey = copenhagenDayKey(tomorrow);
    const tomorrowRetryMs = 30 * 60 * 1000;
    let held = state.priceCache[cacheKey] || null;

    if (held) {
      const stale = !held.cachedAt || (Date.now() - held.cachedAt > cacheMaxAgeMs);
      if (!stale) {
        const missingTomorrow = wantTomorrow && held.daysCovered && !held.daysCovered.includes(tomorrowKey);
        if (missingTomorrow) {
          const retryAt = Number(held.nextTomorrowRetryAt) || 0;
          if (retryAt > Date.now()) {
            const waitMin = Math.ceil((retryAt - Date.now()) / 60000);
            logTrace(`Cache mangler morgendagen — nyt API-kald om ca. ${waitMin} min`);
            return held;
          }
          logTrace("Cache mangler morgendagens priser — genhenter");
        } else {
          logTrace(wantTomorrow ? "Bruger cachede elpriser (morgendag bekræftet)" : "Bruger cachede elpriser");
          return held;
        }
      } else {
        logTrace("Pris-cache forældet — genhenter (beholder kopi hvis API er nede)");
      }
    }

    const thisWeekStart = startOfIsoWeekNoon(dkTime);
    const startDate = addUtcDays(thisWeekStart, -7);
    const endDate = new Date(Date.UTC(pNow.year, pNow.month - 1, pNow.day + 3, 12, 0, 0));
    // Sidste ISO-uge med i samme kald, så uge-snit ikke behøver et ekstra DayAhead-request.

    const apiUrl = `https://api.energidataservice.dk/dataset/DayAheadPrices?` +
      `filter=${encodeURIComponent(JSON.stringify({ PriceArea: [priceArea] }))}` +
      `&sort=${encodeURIComponent("TimeUTC asc")}` +
      `&start=${encodeURIComponent(fmtYmd(startDate) + "T00:00")}` +
      `&end=${encodeURIComponent(fmtYmd(endDate) + "T00:00")}` +
      `&limit=2000`;

    try {
      const data = await fetchDatasetJson(
        apiUrl,
        "Henter elpriser fra API'en...",
        "Tjek evt. datoformat eller PriceArea."
      );
      if (!data.records || data.records.length === 0) {
        const fallback = (held && priceCacheCoversNow(held, dkTime)) ? held : pickUsablePriceCache(priceArea, dkTime);
        if (fallback) {
          log("⚠️ API returnerede tomt datasæt. Bruger gemte day-ahead.");
          return fallback;
        }
        log("⚠️ API returnerede tomt datasæt.");
        reportFejl("A-101");
        return { records: [] };
      }

      data.records.sort((a, b) => {
        const ta = parseApiUtc(a.TimeUTC) || toDKDate(a.TimeDK || a.HourDK);
        const tb = parseApiUtc(b.TimeUTC) || toDKDate(b.TimeDK || b.HourDK);
        return ta - tb;
      });
      const quarterRecords = normalizeQuarterRecords(data.records);
      if (quarterRecords.length === 0) {
        const fallback = (held && priceCacheCoversNow(held, dkTime)) ? held : pickUsablePriceCache(priceArea, dkTime);
        if (fallback) {
          log("⚠️ Kunne ikke læse day-ahead-kvarter fra API. Bruger gemte priser.");
          return fallback;
        }
        log("⚠️ Kunne ikke læse day-ahead-kvarter fra API.");
        reportFejl("A-105");
        return { records: [] };
      }

      // Gem hvilke dage cachen faktisk dækker, så vi kan opdage manglende morgendagspriser
      const daysCovered = [...new Set(quarterRecords.map(r => {
        const inst = slotInstantFromRecord(r);
        return isValidDate(inst) ? copenhagenDayKey(inst) : null;
      }).filter(Boolean))].sort();
      const cached = { records: quarterRecords, cachedAt: Date.now(), daysCovered };
      // Morgendag mangler → gem sidste forsøg → vent 30 min → prøv igen (ikke hvert flow-kald).
      if (wantTomorrow && !daysCovered.includes(tomorrowKey)) {
        cached.nextTomorrowRetryAt = Date.now() + tomorrowRetryMs;
        logTrace(`Morgendagen mangler i API — prøver igen om ${Math.round(tomorrowRetryMs / 60000)} min`);
      }
      state.priceCache[cacheKey] = cached;
      saveCacheState();
      return cached;
    } catch (e) {
      const msg = e.message === "429" ? "Too Many Requests (429)" : e.message;
      const fallback = (held && priceCacheCoversNow(held, dkTime)) ? held : pickUsablePriceCache(priceArea, dkTime);
      if (fallback) {
        log(`⚠️ Elpriser API fejlede: ${msg}. Bruger gemte day-ahead (fx efter strømafbrydelse).`);
        return fallback;
      }
      log(`⚠️ Elpriser API fejlede: ${msg}`);
      reportFejl("A-102", msg);
      return null;
    }
  }

  async function fetchGridTariffFromApi(netselskab) {
    const filterStr = `{"GLN_Number":["${netselskab}"],"ChargeType":["D03"]}`;
    const apiUrl = `https://api.energidataservice.dk/dataset/DatahubPricelist?filter=${encodeURIComponent(filterStr)}&sort=${encodeURIComponent("ValidFrom desc")}${datahubStartParam()}&limit=5000`;

    try {
      const data = await fetchDatasetJson(
        apiUrl,
        `Henter nettarif fra API'en for ${netselskab}...`,
        `Tjek at netselskabets GLN-nummer ('${netselskab}') er korrekt.`
      );
      if (!data.records || data.records.length === 0) {
        log("⚠️ Fandt ingen tariffer for GLN '" + netselskab + "'. Falder tilbage til manuelle satser.");
        reportFejl("B-205", netselskab);
        return null;
      }

      const now = getDKTime();
      const validRecords = data.records
        .filter(r => isChargeValidAt(r, now))
        .sort((a, b) => toDKDate(b.ValidFrom) - toDKDate(a.ValidFrom));

      const validTariff = pickHouseholdGridTariff(validRecords);
      const rebate = validRecords.find(r => chargeTypeCode(r) === "CD R");
      const tariffWithRebate = mergeGridRebate(validTariff, rebate);

      if (!tariffWithRebate) {
        log("⚠️ Fandt selskabet i Datahub, men ingen aktive kWh-tariffer (D03) for dags dato. Afbryder og bruger fallback.");
        reportFejl("B-202");
        return null;
      }

      const selectedCode = chargeTypeCode(validTariff);
      let window = validityFromRecord(validTariff);
      if (rebate) window = intersectValidity(window, validityFromRecord(rebate));
      window = capValidityWithNextStart(
        window,
        earliestFutureStart(data.records, now, r => {
          const c = chargeTypeCode(r);
          return r.ChargeType === "D03" && (c === selectedCode || c === "CD R");
        })
      );

      const meta = {
        gln: netselskab,
        chargeTypeCode: selectedCode,
        rebateCode: rebate ? chargeTypeCode(rebate) : null,
        validFrom: window ? window.from : now.getTime(),
        validTo: window ? window.to : null
      };

      logTrace(`✅ Succes: Fandt nettarif (${validTariff.ChargeTypeCode || validTariff.Note || "Standard"})${rebate ? " inkl. CD R-rabat" : ""} · gyldig ${formatValidityWindow(meta)}.`);
      return { tariff: tariffWithRebate, meta };
    } catch (e) {
      if (state.tariffCache && state.tariffCache.grid) {
        log(`⚠️ Lokal nettarif API fejlede: ${e.message}. Bruger sidst gemte tarif.`);
        return { tariff: state.tariffCache.grid, meta: state.tariffCache.gridMeta };
      }
      log(`⚠️ Lokal nettarif API fejlede: ${e.message}. Falder tilbage til manuelle satser.`);
      reportFejl("B-201", e.message);
      return null;
    }
  }

  async function fetchEnerginetTariffFromApi() {
    const filterStr = `{"GLN_Number":["${ENERGINET_GLN}"],"ChargeType":["D03"]}`;
    const apiUrl = `https://api.energidataservice.dk/dataset/DatahubPricelist?filter=${encodeURIComponent(filterStr)}&sort=${encodeURIComponent("ValidFrom desc")}${datahubStartParam()}&limit=2000`;

    try {
      const data = await fetchDatasetJson(
        apiUrl,
        "Henter Energinet tariffer fra API'en...",
        "Fejl i anmodningen til Energinets tariffer."
      );
      if (!data.records || data.records.length === 0) {
        log("⚠️ Fandt slet ingen tariffer for Energinet i Datahub. Afbryder og bruger fallback.");
        reportFejl("B-206");
        return null;
      }

      const now = getDKTime();
      const validRecords = data.records
        .filter(r => isChargeValidAt(r, now))
        .sort((a, b) => toDKDate(b.ValidFrom) - toDKDate(a.ValidFrom));

      const transmission = findEnerginetCharge(validRecords, "Transmissions nettarif");
      const system = findEnerginetCharge(validRecords, "Systemtarif");

      if (!transmission || !system) {
        log("⚠️ Kunne ikke finde aktive Energinet system- og transmissionstariffer i Datahub. Afbryder og bruger fallback.");
        reportFejl("B-204");
        return null;
      }

      const totalInklMoms = ((Number(transmission.Price1) || 0) + (Number(system.Price1) || 0)) * 1.25;
      let window = intersectValidity(validityFromRecord(system), validityFromRecord(transmission));
      window = capValidityWithNextStart(
        window,
        earliestFutureStart(data.records, now, r => {
          const n = chargeNote(r);
          return n === "transmissions nettarif" || n === "systemtarif";
        })
      );
      const meta = {
        gln: ENERGINET_GLN,
        chargeTypeCode: `${chargeTypeCode(system)}+${chargeTypeCode(transmission)}`,
        validFrom: window ? window.from : now.getTime(),
        validTo: window ? window.to : null
      };
      logTrace(`✅ Succes: Energinet ${chargeNote(system)} ${Number(system.Price1) || 0} + ${chargeNote(transmission)} ${Number(transmission.Price1) || 0} = ${totalInklMoms.toFixed(4)} kr. inkl. moms · gyldig ${formatValidityWindow(meta)}.`);
      return { inkl: Number(totalInklMoms.toFixed(4)), meta };
    } catch (e) {
      if (state.tariffCache && typeof state.tariffCache.energinet === "number") {
        log(`⚠️ Energinet API fejlede: ${e.message}. Bruger sidst gemte tarif.`);
        return { inkl: state.tariffCache.energinet, meta: state.tariffCache.energinetMeta };
      }
      log(`⚠️ Energinet API fejlede: ${e.message}. Falder tilbage til manuel sats på ${ENERGINET_TARIF_INKL_MOMS} kr.`);
      reportFejl("B-203", e.message);
      return null;
    }
  }

  function klMinTags(prefix, kl, min) {
    const h = Number(kl);
    const m = Number(min) || 0;
    const ok = Number.isFinite(h) && h >= 0;
    return {
      [prefix]: ok ? formatClockHM(h, m) : "-",
      [prefix + " (kl)"]: ok ? h : -1,
      [prefix + " (min)"]: ok ? m : -1
    };
  }

  function dashboardFieldSpecs(x) {
    const naeste8 = x.naeste8;
    const morgenStat = x.morgenStat;
    const weekAvgs = x.weekAvgs;
    const rangIDag = x.rangIDag;
    const fields = [];
    const num = (key, titles, value, tagName, hot, precision, skipDevice) => {
      fields.push({
        key,
        titles,
        type: "number",
        precision: precision == null ? 2 : precision,
        hot: Boolean(hot),
        skipDevice: Boolean(skipDevice),
        value,
        tags: { [tagName]: value }
      });
    };
    const str = (key, titles, value, tags, hot, deviceOnly, skipDevice) => {
      fields.push({
        key,
        titles,
        type: "string",
        hot: Boolean(hot),
        skipDevice: Boolean(skipDevice),
        value,
        tags: deviceOnly ? null : tags,
        deviceOnly: Boolean(deviceOnly)
      });
    };
    const bool = (key, titles, value, tagName, hot, skipDevice) => {
      fields.push({
        key,
        titles,
        type: "boolean",
        hot: Boolean(hot),
        skipDevice: Boolean(skipDevice),
        value,
        tags: { [tagName]: value }
      });
    };
    const gnsTitles = h => [
      "Gns. næste " + h + "T",
      "Gns. pris næste " + h + "T",
      "Gns pris næste " + h + "T",
      "Pris +" + h + "T",
      "Næste " + h + "T"
    ];
    const periodeTekst = fandtPeriode
      ? formatClockHM(timespanStat.anbefalet.startKL, timespanStat.anbefalet.startMIN) +
        "–" +
        formatClockHM(periodeSlut.h, periodeSlut.m)
      : "-";

    num("prisNu", ["Pris nu"], roundPrice(PrisLigeNu), "Elpris pris nu (kr)", true);
    str("status", ["Status"], x.statusNu, { "Elpris status": x.statusNu }, true);
    str("tendens", ["Tendens", "Prisretning", "Prisprognose"], x.tendensNu, { "Elpris tendens": x.tendensNu }, true);
    bool("underSnit", ["Under dagens snit", "Under dagens gennemsnit"], Boolean(DagensGennemsnitKontraNu < 0), "Elpris under dagens snit", true);
    num("vsTypiskPct", ["Afvigelse fra typisk (%)", "Afvigelse vs typisk", "Vs. typisk"], Number(x.vsTypisk.pct) || 0, "Elpris vs typisk (%)", true, 1);
    num("rang", ["Rang i dag", "Pris nu rang i dag"], Number((rangIDag && rangIDag.rank) || 0), "Elpris rang i dag", true, 0);

    num("gns1t", gnsTitles(1), roundPrice(priceHoursAhead(1)), "Elpris gns. næste 1T (kr)", true);
    num("gns3t", gnsTitles(3), roundPrice(priceHoursAhead(3)), "Elpris gns. næste 3T (kr)", true);
    num("gns6t", gnsTitles(6), roundPrice(priceHoursAhead(6)), "Elpris gns. næste 6T (kr)", true);
    num("gns8t", ["Gns. næste 8T", "Gn. snt. pris næste 8T"], naeste8.gennemsnit, "Elpris gn. snt. næste 8T (kr)");
    str("billig8tTime", ["Billigste næste 8T tidspunkt", "Billigste time næste 8T"], formatClockHM(naeste8.billigstKL, naeste8.billigstMIN), klMinTags("Elpris billigste næste 8T", naeste8.billigstKL, naeste8.billigstMIN));
    num("billig8tPris", ["Billigste næste 8T", "Billigste pris næste 8T"], roundPrice(naeste8.billigstKR), "Elpris billigste næste 8T (kr)");
    str("dyr8tTime", ["Dyreste næste 8T tidspunkt", "Dyreste time næste 8T"], formatClockHM(naeste8.dyrestKL, naeste8.dyrestMIN), klMinTags("Elpris dyreste næste 8T", naeste8.dyrestKL, naeste8.dyrestMIN));
    num("dyr8tPris", ["Dyreste næste 8T", "Dyreste pris næste 8T"], roundPrice(naeste8.dyrestKR), "Elpris dyreste næste 8T (kr)");

    bool("kørNu", ["Kør nu"], Boolean(korselNu), "Elpris kør nu", true);
    bool("startNu", ["Start nu"], Boolean(startErNu), "Elpris start nu", true);
    str("anbefaletPeriode", ["Anbefalet periode"], periodeTekst, { "Elpris anbefalet periode": periodeTekst }, true);
    num("ventetid", ["Ventetid"], Number(ventetidTilOptimalTimer) || 0, "Elpris ventetid (t)", true);
    num("spareKrKwh", ["Besparelse", "Besparelse kr/kWh"], Number(x.sparePotentiale.krKwh) || 0, "Elpris besparelse (kr/kWh)", true);
    num("spareEksempel", ["Besparelse eksempel"], Number(x.sparePotentiale.eksempelKr) || 0, "Elpris besparelse eksempel (kr)", true);

    str("billigIDagTime", ["Billigste i dag tidspunkt", "Billigste time i dag"], formatClockHM(dagStat.billigstKL, dagStat.billigstMIN), klMinTags("Elpris billigste i dag", dagStat.billigstKL, dagStat.billigstMIN));
    num("billigIDagPris", ["Billigste i dag", "Billigste pris i dag"], roundPrice(dagStat.billigstKR), "Elpris billigste i dag (kr)");
    str("dyrIDagTime", ["Dyreste i dag tidspunkt", "Dyreste time i dag"], formatClockHM(dagStat.dyrestKL, dagStat.dyrestMIN), klMinTags("Elpris dyreste i dag", dagStat.dyrestKL, dagStat.dyrestMIN));
    num("dyrIDagPris", ["Dyreste i dag", "Dyreste pris i dag"], roundPrice(dagStat.dyrestKR), "Elpris dyreste i dag (kr)");
    bool("iMorgenKlar", ["I morgen klar", "Tomorrow ready"], Boolean(x.iMorgenKlar), "Elpris i morgen klar", true);

    num("typiskNiveau", ["Typisk pris", "Typisk niveau"], Number(x.vsTypisk.typisk) || 0, "Elpris typisk niveau (kr)", true);

    str("grafFarver", ["Graf farver i dag", "Graf farver"], x.grafFarverIDag, { "Elpris graf farver i dag": x.grafFarverIDag }, false, true);
    str("grafUrl", ["Graf URL", "Graph URL", "Chart URL"], String(x.grafIDagUrl || "-"), { "Elpris graf URL": String(x.grafIDagUrl || "-") }, true, true);
    str("grafIMorgenUrl", ["Graf i morgen URL", "Graph tomorrow URL"], String(x.grafIMorgenUrl || "-"), { "Elpris graf i morgen URL": String(x.grafIMorgenUrl || "-") }, true, true);
    str("systemstatus", ["Systemstatus", "Script health"], (x.systemstatus && x.systemstatus.detalje) || "—", null, true);

    num("prisAendring", ["Prisændring"], Number(x.prisAendringKr) || 0, "Elpris prisændring (kr)", true, 2, true);
    num("prisAendringPct", ["Prisændring %"], Number(x.prisAendringPct) || 0, "Elpris prisændring (%)", true, 1, true);
    bool("underTaerskel", ["Under smertetærskel"], Boolean(PrisLigeNu <= SMERTETAERSKEL_KR), "Elpris under smertetærskel", true, true);
    num("procent", ["Pris nu procent i dag"], Number((rangIDag && rangIDag.percent) || 0), "Elpris procent i dag (%)", true, 1, true);
    num("antalKvarter", ["Pris nu antal kvarter i dag"], Number((rangIDag && rangIDag.count) || 0), "Elpris antal kvarter i dag", true, 0, true);
    str("typiskVsNu", ["Typisk vs nu"], x.vsTypisk.tekst, { "Elpris typisk vs nu": x.vsTypisk.tekst }, true, false, true);
    [2, 4, 5, 7].forEach(h => {
      num("gns" + h + "t", gnsTitles(h), roundPrice(priceHoursAhead(h)), "Elpris gns. næste " + h + "T (kr)", true, 2, true);
    });
    str("venteBeslutning", ["Vente beslutning"], x.venteRaad.beslutning, { "Elpris vente beslutning": x.venteRaad.beslutning }, true, false, true);
    str("venteRaad", ["Vente råd", "Bedste start", "Er det værd at vente"], x.venteRaad.raad, { "Elpris vente råd": x.venteRaad.raad }, true, false, true);
    num("ventMinKw", ["Vent min forbrug"], Number(x.venteRaad.minKw) || 0, "Elpris vent min forbrug (kW)", true, 2, true);
    str("sparePotentiale", ["Besparelsespotentiale"], x.sparePotentiale.tekst, { "Elpris besparelsespotentiale": x.sparePotentiale.tekst }, true, false, true);
    num("gnsIDag", ["Gn. snt. pris i dag"], roundPrice(dagStat.gennemsnit), "Elpris gennemsnit i dag (kr)", false, 2, true);
    num("gnsIMorgen", ["Gn. snt. pris i morgen"], morgenStat.gennemsnit, "Elpris gennemsnit i morgen (kr)", false, 2, true);
    num("billigIMorgenPris", ["Billigste pris i morgen"], roundPrice(morgenStat.billigstKR), "Elpris billigste i morgen (kr)", false, 2, true);
    str("billigIMorgenTime", ["Billigste time i morgen"], formatClockHM(morgenStat.billigstKL, morgenStat.billigstMIN), klMinTags("Elpris billigste i morgen", morgenStat.billigstKL, morgenStat.billigstMIN), false, false, true);
    num("dyrIMorgenPris", ["Dyreste pris i morgen"], roundPrice(morgenStat.dyrestKR), "Elpris dyreste i morgen (kr)", false, 2, true);
    str("dyrIMorgenTime", ["Dyreste time i morgen"], formatClockHM(morgenStat.dyrestKL, morgenStat.dyrestMIN), klMinTags("Elpris dyreste i morgen", morgenStat.dyrestKL, morgenStat.dyrestMIN), false, false, true);
    num("ugeSidst", ["Gn. snt. pris sidste uge"], weekAvgs.lastWeekAvg, "Elpris gn. snt. sidste uge (kr)", false, 2, true);
    num("ugeNu", ["Gn. snt. pris denne uge"], weekAvgs.thisWeekAvg, "Elpris gn. snt. denne uge (kr)", false, 2, true);
    num("ugeKvarter", ["Uges kvarter"], weekAvgs.thisWeekCount || 0, "Elpris uges kvarter", false, 0, true);
    str("timeprofil", ["Typisk timeprofil"], x.hourProfil.tekst, { "Elpris typisk timeprofil": x.hourProfil.tekst }, true, false, true);
    str("timeprofilKort", ["Timeprofil"], x.hourProfil.kort, { "Elpris timeprofil": x.hourProfil.kort }, true, false, true);
    num("timeprofilRang", ["Timeprofil rang"], Number(x.hourProfil.rang) || 0, "Elpris timeprofil rang", true, 1, true);
    num("timeprofilDage", ["Timeprofil dage"], Number(x.hourProfil.dage) || 0, "Elpris timeprofil dage", true, 0, true);
    str("laeringGrundlag", ["Læring datagrundlag"], x.hourProfil.datagrundlag, { "Elpris læring datagrundlag": x.hourProfil.datagrundlag }, true, false, true);
    num("laeringModenhed", ["Læring modenhed"], Number(x.hourProfil.modenhed) || 0, "Elpris læring modenhed (%)", true, 0, true);
    str("timeprofilDoegn", ["Timeprofil døgn"], x.hourProfil.doegn || "—", { "Elpris timeprofil døgn": x.hourProfil.doegn || "—" }, true, false, true);
    return fields;
  }

  function normalizeCapLabel(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "oe")
      .replace(/å/g, "aa")
      .replace(/[.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function slugifyCap(s) {
    return normalizeCapLabel(s)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  function labelHasHourToken(text, hour) {
    const n = String(hour);
    const compact = String(text || "").replace(/[^a-z0-9+]+/g, "");
    return new RegExp("(?:^|[^0-9])" + n + "t(?:$|[^0-9])").test(compact);
  }

  function hourTokensInText(text) {
    const spaced = normalizeCapLabel(String(text || "").replace(/…/g, " ").replace(/\.\.\./g, " "))
      .replace(/[^a-z0-9]+/g, " ");
    const tokens = [];
    const re = /\b(\d+)t\b/g;
    let m;
    while ((m = re.exec(spaced))) tokens.push(m[1]);
    return tokens;
  }

  function isHourRangeLabel(text) {
    return hourTokensInText(text).length >= 2;
  }

  function capabilityLabels(c) {
    const out = [];
    const add = (v) => {
      if (v == null || v === "") return;
      if (typeof v === "string") {
        const n = normalizeCapLabel(v);
        if (n && out.indexOf(n) < 0) out.push(n);
        return;
      }
      if (typeof v === "object") {
        const keys = Object.keys(v);
        for (let i = 0; i < keys.length; i++) add(v[keys[i]]);
      }
    };
    add(c && c.title);
    add(c && c.desc);
    add(c && c.name);
    add(c && c.insightsTitle);
    add(c && c.options);
    return out;
  }

  function labelFitsWant(label, want) {
    if (want.indexOf("morgen") >= 0 !== label.indexOf("morgen") >= 0) return false;
    if (want.indexOf("url") >= 0 && label.indexOf("url") < 0) return false;
    if (want.indexOf("url") >= 0 && want.indexOf("morgen") < 0 && label.indexOf("morgen") >= 0) return false;
    if (want.indexOf("farver") >= 0 && label.indexOf("farver") < 0 && label.indexOf("color") < 0) return false;
    return true;
  }

  function capMatchesTitles(c, names, capId) {
    const labels = capabilityLabels(c);
    const idSlug = slugifyCap(String(capId || (c && c.id) || ""));
    const compactLabels = labels.map(l => l.replace(/[^a-z0-9]+/g, ""));
    for (let i = 0; i < names.length; i++) {
      const want = normalizeCapLabel(names[i]);
      if (!want) continue;
      if (labels.indexOf(want) >= 0) return true;
      const wantCompact = want.replace(/[^a-z0-9]+/g, "");
      if (wantCompact && compactLabels.indexOf(wantCompact) >= 0) return true;
      const hourM = want.match(/\b(\d+)t\b/);
      if (hourM) {
        if (labels.some(isHourRangeLabel) || isHourRangeLabel(idSlug.replace(/_/g, " "))) continue;
        const hour = hourM[1];
        const hourOk =
          labels.some(l => hourTokensInText(l).length === 1 && hourTokensInText(l)[0] === hour) ||
          (hourTokensInText(idSlug.replace(/_/g, " ")).join() === hour);
        if (!hourOk) continue;
        const contextOk = labels.some(l =>
          l.indexOf("naeste") >= 0 ||
          l.indexOf("gns") >= 0 ||
          l.indexOf("gennemsnit") >= 0 ||
          l.indexOf("+" + hour) >= 0
        );
        if (contextOk || labels.some(l => labelHasHourToken(l, hour) && l.indexOf("pris") >= 0)) return true;
        continue;
      }
      const wantSlug = slugifyCap(names[i]);
      if (wantSlug && (idSlug === wantSlug || idSlug.endsWith("_" + wantSlug))) return true;
      const words = want.split(" ").filter(w => w.length >= 4 || w === "url");
      if (words.length && labels.some(l => labelFitsWant(l, want) && words.every(w => l.indexOf(w) >= 0))) return true;
    }
    return false;
  }

  function capabilityTitle(c) {
    const labels = capabilityLabels(c);
    return labels[0] || "";
  }

  function getCapabilitiesObj(device) {
    const obj = (device && (device.capabilitiesObj || device.CapabilitiesObj)) || {};
    if (obj && Object.keys(obj).length) return obj;
    const ids = (device && device.capabilities) || [];
    const out = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id || out[id]) continue;
      let type = "string";
      if (/^measure_|^meter_/.test(id) || id === "dim") type = "number";
      else if (/^boolean|^onoff|^alarm_/.test(id)) type = "boolean";
      out[id] = { id, type };
    }
    return out;
  }

  function isLikelyDashboardBoolean(capId, c) {
    const id = String(capId || (c && c.id) || "").toLowerCase();
    if (/alarm_(motion|contact|smoke|co|heat|water|tamper|battery|night)/.test(id)) return false;
    const t = String((c && c.type) || "").toLowerCase();
    if (t === "boolean") return true;
    if (/^boolean(\.|$)/.test(id)) return true;
    if (/^onoff(\.|$)/.test(id)) return true;
    if (/^alarm_generic(\.|$)/.test(id)) return true;
    return false;
  }

  function resolveDeviceCap(device, field, used) {
    if (!device || !field) return null;
    const capabilities = getCapabilitiesObj(device);
    const remembered = state.elprisCapIds || (state.elprisCapIds = {});
    const manual = elprisDeviceCapIds || {};
    const names = field.titles || (field.title ? [field.title] : []);
    let capId = (field.key && manual[field.key]) || (field.key && remembered[field.key]) || "";
    let cap = capId ? capabilities[capId] : null;
    if (cap && used && used[capId]) {
      cap = null;
      if (field.key && remembered[field.key] === capId && !(manual && field.key && manual[field.key])) {
        delete remembered[field.key];
        saveCacheState();
      }
    }
    if (cap) return { capId, cap };
    const capEntry = Object.entries(capabilities).find(([id, c]) => {
      if (used && used[id]) return false;
      const kind = capKind(c, id);
      if (field.type === "number" && kind !== "number") return false;
      if (field.type === "string" && kind !== "string") return false;
      return capMatchesTitles(c, names, id);
    });
    if (!capEntry) {
      if (field.key && remembered[field.key]) {
        delete remembered[field.key];
        saveCacheState();
      }
      return null;
    }
    capId = capEntry[0];
    cap = capEntry[1];
    if (field.key && remembered[field.key] !== capId) {
      remembered[field.key] = capId;
      saveCacheState();
    }
    return { capId, cap };
  }

  function mapAllDeviceCaps(device, fields) {
    const map = {};
    const used = {};
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.skipDevice) continue;
      const found = resolveDeviceCap(device, field, used);
      if (!found) continue;
      map[field.key] = found;
      used[found.capId] = true;
    }
    return map;
  }

  async function refreshElprisDeviceIfCapsMissing(device, fields) {
    if (!device) return device;
    const map = mapAllDeviceCaps(device, fields);
    const missingBool = fields.some(f => f.type === "boolean" && !f.skipDevice && !map[f.key]);
    if (!missingBool) return device;
    const fresh = await searchElprisVirtualDeviceByName();
    return fresh || device;
  }

  function logMissingBooleanCaps(device, fields, deviceCapMap) {
    const missingGns = fields.filter(f => /^gns(1|3|6|8)t$/.test(f.key) && !f.skipDevice && !deviceCapMap[f.key]);
    const missingBool = fields.filter(f => f.type === "boolean" && !f.skipDevice && !deviceCapMap[f.key]);
    const capabilities = getCapabilitiesObj(device);
    const rangeCap = Object.entries(capabilities).find(([, c]) =>
      capabilityLabels(c).some(isHourRangeLabel)
    );
    if (missingGns.length && rangeCap) {
      log(
        "Gns. næste 1T/3T/6T/8T er ét number-felt («" +
          (capabilityTitle(rangeCap[1]) || rangeCap[0]) +
          "»). Homey kan kun vise ét tal dér. Opret fire felter: Gns. næste 1T, 3T, 6T og 8T."
      );
    }
    const missing = rangeCap && missingGns.length ? missingBool : missingGns.concat(missingBool);
    if (!missing.length) return;
    const listed = Object.entries(capabilities).map(([id, c]) => {
      const title = capabilityTitle(c) || "-";
      return id + " [" + (c && c.type ? c.type : "?") + "] " + title;
    });
    log(
      "Felter på enheden blev ikke matchet (" +
        missing.map(f => f.titles[0]).join(", ") +
        "). Capabilities: " +
        (listed.length ? listed.join(" | ") : "(ingen capabilitiesObj)")
    );
  }

  function capKind(cap, capId) {
    const id = String(capId || (cap && cap.id) || "").toLowerCase();
    const t = String((cap && cap.type) || "").toLowerCase();
    if (t === "number" || /^measure_|^meter_/.test(id)) return "number";
    if (t === "string" || t === "enum") return "string";
    return "boolean";
  }

  function encodedCapValues(kind, on) {
    if (kind === "number") return [on ? 1 : 0];
    if (kind === "string") return [on ? "Ja" : "Nej", on ? "true" : "false"];
    return [Boolean(on), on ? 1 : 0, on ? "true" : "false"];
  }

  function capAlreadyEquals(cap, kind, on) {
    const v = cap && cap.value;
    if (kind === "string") {
      const s = String(v == null ? "" : v).toLowerCase();
      if (!s) return false;
      if (on) return s === "ja" || s === "true" || s === "yes" || s === "1";
      return s === "nej" || s === "false" || s === "no" || s === "0";
    }
    if (v !== true && v !== false && v !== 0 && v !== 1) return false;
    return Boolean(v) === Boolean(on);
  }

  function isNotSetableErr(e) {
    const m = String((e && e.message) || e || "").toLowerCase();
    return m.indexOf("not setable") >= 0 || m.indexOf("not settable") >= 0;
  }

  function isMissingCapErr(e) {
    const m = String((e && e.message) || e || "").toLowerCase();
    if (!m) return false;
    return (
      m.indexOf("not found") >= 0 ||
      m.indexOf("unknown capability") >= 0 ||
      m.indexOf("invalid capability") >= 0 ||
      m.indexOf("invalid_capability") >= 0 ||
      m.indexOf("does not exist") >= 0 ||
      m.indexOf("no capability") >= 0 ||
      m.indexOf("unknown field") >= 0 ||
      m.indexOf("field not found") >= 0 ||
      m.indexOf("missing capability") >= 0
    );
  }

  async function getDeviceCapabilitiesApp() {
    if (Object.prototype.hasOwnProperty.call(getDeviceCapabilitiesApp, "_cache")) {
      return getDeviceCapabilitiesApp._cache;
    }
    let app = null;
    if (typeof Homey !== "undefined" && Homey.apps && typeof Homey.apps.getApp === "function") {
      try {
        app = await Homey.apps.getApp({ id: "nl.qluster-it.DeviceCapabilities" });
      } catch (_) {
        app = null;
      }
    }
    getDeviceCapabilitiesApp._cache = app;
    return app;
  }

  async function setAvdFieldValue(device, capId, value) {
    const app = await getDeviceCapabilitiesApp();
    if (!app) throw new Error("Device Capabilities-appen blev ikke fundet");
    const deviceId = device.id || device.name;
    const shortField = String(capId).split(".").pop();
    const bodies = [
      { device: deviceId, field: capId, value },
      { device: deviceId, field: shortField, value },
      { device: device.name, field: capId, value },
      { device: device.name, field: shortField, value }
    ];
    let lastErr = null;
    for (let i = 0; i < bodies.length; i++) {
      try {
        if (typeof app.apiPost === "function") {
          await app.apiPost("setvalue", bodies[i]);
          return;
        }
        if (typeof app.post === "function") {
          await app.post({ path: "setvalue", body: bodies[i] });
          return;
        }
        throw new Error("apiPost mangler på Device Capabilities");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("AVD setvalue fejlede");
  }

  async function writeDeviceValue(device, capId, value, cap) {
    const viaDc = state.elprisCapWriteViaDc || (state.elprisCapWriteViaDc = {});
    const preferDc = Boolean(viaDc[capId]) || (cap && cap.setable === false && String(capId).indexOf("devicecapabilities") >= 0);
    if (!preferDc) {
      try {
        await device.setCapabilityValue(capId, value);
        return;
      } catch (e) {
        if (!isNotSetableErr(e)) {
          if (typeof Homey !== "undefined" && Homey.devices && typeof Homey.devices.setCapabilityValue === "function") {
            try {
              await Homey.devices.setCapabilityValue({ deviceId: device.id, capabilityId: capId, value });
              return;
            } catch (e2) {
              if (!isNotSetableErr(e2)) throw e2;
            }
          } else {
            throw e;
          }
        }
      }
    }
    await setAvdFieldValue(device, capId, value);
    if (!viaDc[capId]) {
      viaDc[capId] = true;
      saveCacheState();
    }
  }

  async function setDeviceCapability(device, capId, on, cap) {
    const kind = capKind(cap, capId);
    const candidates = encodedCapValues(kind, on);
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      try {
        await writeDeviceValue(device, capId, candidates[i], cap);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("setCapabilityValue fejlede");
  }

  async function removeDashboardTagsOnDevice(fields, onDevice) {
    const lastTags = state.lastTags || {};
    const toRemove = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!onDevice[field.key] || !field.tags) continue;
      const keys = Object.keys(field.tags);
      for (let k = 0; k < keys.length; k++) toRemove.push(keys[k]);
    }
    const unique = [];
    for (let i = 0; i < toRemove.length; i++) {
      const key = toRemove[i];
      if (unique.indexOf(key) >= 0) continue;
      if (!Object.prototype.hasOwnProperty.call(lastTags, key)) continue;
      unique.push(key);
    }
    if (!unique.length) return;
    await removeHomeyTags(unique);
  }

  async function removeHomeyTags(keys) {
    const lastTags = state.lastTags || (state.lastTags = {});
    let removed = 0;
    for (const key of keys) {
      try {
        if (typeof tag !== "undefined") {
          await tag(key, null);
        }
        if (Object.prototype.hasOwnProperty.call(lastTags, key)) {
          delete lastTags[key];
        }
        removed++;
      } catch (_) {
        if (Object.prototype.hasOwnProperty.call(lastTags, key)) {
          delete lastTags[key];
          removed++;
        }
      }
    }
    if (removed) saveCacheState();
    return removed;
  }

  async function updateErrorTags() {
    const lastTags = state.lastTags || (state.lastTags = {});
    const fejl = currentRunErrors.length > 0;
    const kodeStr = currentRunErrors.join(" ");
    const pairs = [
      ["Elpris fejl", fejl],
      ["Elpris fejlkode", kodeStr]
    ];
    const health = buildSystemStatus(healthCtx);
    pairs.push(["Elpris systemstatus", health.kort]);
    pairs.push(["Elpris systemstatus detalje", health.detaljeTag || health.detalje]);
    if (typeof healthCtx.msTotal === "number") {
      pairs.push(["Elpris sidste kørsel (ms)", healthCtx.msTotal]);
      pairs.push(["Elpris API (ms)", healthCtx.msApi]);
      pairs.push(["Elpris beregning (ms)", healthCtx.msCalc]);
    }
    if (typeof healthCtx.tagsChanged === "number") {
      pairs.push(["Elpris tags ændret", healthCtx.tagsChanged]);
      pairs.push(["Elpris tags uændret", healthCtx.tagsUnchanged || 0]);
    }
    const changed = pairs.filter(([k, v]) =>
      !Object.prototype.hasOwnProperty.call(lastTags, k) || !tagValuesEqual(lastTags[k], v)
    );
    if (!changed.length) return;
    for (let i = 0; i < changed.length; i++) {
      const k = changed[i][0];
      const v = changed[i][1];
      try {
        if (typeof tag !== "undefined") await tag(k, v);
        lastTags[k] = v;
      } catch (e) {
        log("Kunne ikke skrive tag '" + k + "': " + (e && e.message ? e.message : e));
      }
    }
    saveCacheState();
  }

  function fmtHealthSiden(prevAt) {
    if (!(prevAt > 0)) return "første kørsel";
    const min = Math.round((Date.now() - prevAt) / 60000);
    if (min < 1) return "lige nu";
    if (min === 1) return "1 min siden";
    if (min < 60) return min + " min siden";
    const t = Math.round(min / 60);
    if (t === 1) return "1 t siden";
    if (t < 48) return t + " t siden";
    return Math.round(t / 24) + " dage siden";
  }

  function buildSystemStatus(ctx) {
    const c = ctx || healthCtx;
    const stop = [];
    const warn = [];
    for (let i = 0; i < currentRunErrors.length; i++) {
      const kode = currentRunErrors[i];
      const niv = FEJLKATALOG[kode] && FEJLKATALOG[kode].niveau;
      if (niv === "stop") stop.push(kode);
      else warn.push(kode);
    }

    const aFejl = currentRunErrors.some(k => k.charAt(0) === "A" && k !== "A-108");
    let api = "ukendt";
    if (aFejl) api = "fejl";
    else if (c.hadPrices) api = "OK";

    const wantGrid = AUTO_FETCH_TARIFF;
    const wantEn = AUTO_FETCH_ENERGINET;
    let tarif = "ukendt";
    if (c.gridApi != null || c.energinetApi != null) {
      const gridOk = !wantGrid || c.gridApi === true;
      const enOk = !wantEn || c.energinetApi === true;
      if (gridOk && enOk) tarif = (wantGrid || wantEn) ? "API" : "manuel";
      else if (!gridOk && !enOk) tarif = "fallback";
      else tarif = "delvis";
    } else if (currentRunErrors.some(k => k.charAt(0) === "B")) {
      tarif = "fallback";
    }

    let data = "ukendt";
    const dq = c.dataQuality;
    if (dq) {
      if (dq.ok) data = "komplet";
      else if (dq.safeForOptimization) data = "advarsel";
      else data = "huller";
    } else if (aFejl) {
      data = "mangler";
    }

    let iMorgen = "ukendt";
    if (c.iMorgenKlar === true) iMorgen = "klar";
    else if (c.iMorgenKlar === false) {
      iMorgen = (c.clockHour != null && c.clockHour >= 14) ? "mangler" : "afventer";
    }

    const siden = fmtHealthSiden(c.prevRunAt);
    const tarifGul = tarif === "fallback" || tarif === "delvis";
    const dataGul = data === "advarsel" || data === "huller" || data === "mangler";
    const morgenGul = iMorgen === "mangler";
    let kort = "🟢 OK";
    if (stop.length || api === "fejl" || data === "huller" || data === "mangler") kort = "🔴 Fejl";
    else if (warn.length || tarifGul || dataGul || morgenGul) kort = "🟡 Advarsel";

    const medMs = (ms) => (typeof ms === "number" ? " · " + ms + " ms" : "");
    const tarifTid = (() => {
      const dele = [];
      if (AUTO_FETCH_TARIFF) {
        dele.push(c.gridCached ? "net cache" : "net " + (c.msGrid || 0) + " ms");
      } else {
        dele.push("net manuel");
      }
      if (AUTO_FETCH_ENERGINET) {
        dele.push(c.energinetCached ? "EN cache" : "EN " + (c.msEnerginet || 0) + " ms");
      } else {
        dele.push("EN manuel");
      }
      return dele.length ? " · " + dele.join(" · ") : "";
    })();

    const detaljeLinjer = [
      kort,
      "API: " + api + medMs(c.msPrices != null ? c.msPrices : c.msApi),
      "Tarif: " + tarif + tarifTid,
      "Data: " + data + medMs(c.msCalc),
      "I morgen: " + iMorgen,
      "Siden sidst: " + siden
    ];
    if (typeof c.msHomey === "number") detaljeLinjer.push("Homey: " + c.msHomey + " ms");
    if (typeof c.msTotal === "number") detaljeLinjer.push("Kørsel: " + c.msTotal + " ms");
    if (typeof c.tagsChanged === "number") {
      detaljeLinjer.push("Tags: " + c.tagsChanged + " ændret · " + (c.tagsUnchanged || 0) + " uændret");
    }

    const detaljeTag = detaljeLinjer.join(" · ").replace(/\s+/g, " ").trim();
    return {
      kort,
      detalje: detaljeLinjer.join("\n"),
      detaljeTag: detaljeTag.length > 240 ? detaljeTag.slice(0, 237) + "..." : detaljeTag,
      api,
      tarif,
      data,
      iMorgen,
      siden
    };
  }

  async function updateHomeyTags(hotTags, coldTags, timezone, writeCold) {
    const lastTags = state.lastTags || (state.lastTags = {});
    const tagsObject = writeCold ? Object.assign({}, hotTags, coldTags) : hotTags;
    const saveTag = async (k, v) => {
      try {
        if (typeof tag !== "undefined") {
          await tag(k, v);
        } else {
          logTrace(`[Lokalt Test Tag] ${k} = ${v}`);
        }
        lastTags[k] = v;
        return true;
      } catch (e) {
        log(`Advarsel: Kunne ikke gemme tag '${k}'. Fejl: ${e.message}`);
        return false;
      }
    };

    const changed = [];
    for (const [key, value] of Object.entries(tagsObject)) {
      if (Object.prototype.hasOwnProperty.call(lastTags, key) && tagValuesEqual(lastTags[key], value)) {
        continue;
      }
      changed.push([key, value]);
    }
    const considered = Object.keys(tagsObject).length;
    const unchanged = Math.max(0, considered - changed.length);

    if (!changed.length) {
      logTrace("Tags: ingen ændringer" + (writeCold ? " (kold skrivning)" : " (kun varme)"));
      if (writeCold) state.lastTagHourKey = hourKey;
      return { written: 0, unchanged };
    }
    logTrace(
      "Tags: " + changed.length + " ændringer" +
      (writeCold ? " (inkl. kolde)" : " (kun varme)") +
      " · " + changed.map(pair => pair[0]).join(", ")
    );

    const stamp = new Date().toLocaleString("da-DK", {
      hour12: false,
      timeZone: timezone || "Europe/Copenhagen"
    });
    await saveTag("Elpris opdateret", stamp);
    await Promise.all(changed.map(([key, value]) => saveTag(key, value)));
    if (writeCold) state.lastTagHourKey = hourKey;
    saveCacheState();
    return { written: changed.length, unchanged };
  }

  function emptyWindowStat() {
    return {
      gennemsnit: 0,
      billigstKR: 0,
      billigstKL: -1,
      billigstMIN: 0,
      dyrestKR: 0,
      dyrestKL: -1,
      dyrestMIN: 0,
      timer: 0
    };
  }

  function applyQuarterToWindowStat(s, q, total) {
    s.timer++;
    if (s.timer === 1 || q.total < s.billigstKR) {
      s.billigstKR = q.total;
      s.billigstKL = q.hour;
      s.billigstMIN = q.minute;
    }
    if (s.timer === 1 || q.total > s.dyrestKR) {
      s.dyrestKR = q.total;
      s.dyrestKL = q.hour;
      s.dyrestMIN = q.minute;
    }
    return total + q.total;
  }

  function statsForDateString(dateStr) {
    const ds = quarterIndex.dayStats[dateStr];
    if (!ds || !ds.n) return emptyWindowStat();
    return {
      gennemsnit: roundPrice(ds.sum / ds.n),
      billigstKR: ds.min,
      billigstKL: ds.minH,
      billigstMIN: ds.minM,
      dyrestKR: ds.max,
      dyrestKL: ds.maxH,
      dyrestMIN: ds.maxM,
      timer: ds.n
    };
  }

  function statsForUpcomingHours(hours) {
    const h = Math.max(0, Math.round(Number(hours)));
    const cached = quarterIndex.upcoming[h];
    if (cached) return cloneWindowStat(cached);
    const s = emptyWindowStat();
    const slots = Math.max(0, Math.round(Number(hours) * 4));
    let total = 0;
    const start = quarterIndex.futureFrom;
    const end = Math.min(processedRecords.length, start + slots);
    for (let i = start; i < end; i++) {
      total = applyQuarterToWindowStat(s, processedRecords[i], total);
    }
    s.gennemsnit = s.timer ? roundPrice(total / s.timer) : 0;
    return s;
  }

  function priceHoursAhead(hours) {
    return statsForUpcomingHours(hours).gennemsnit;
  }

  function uniqueChargeTimes(records) {
    const set = new Set();
    for (const r of records || []) {
      if (r.ValidFrom) {
        const d = toDKDate(r.ValidFrom);
        if (isValidDate(d)) set.add(d.getTime());
      }
      if (r.ValidTo) {
        const d = toDKDate(r.ValidTo);
        if (isValidDate(d)) set.add(d.getTime());
      }
    }
    return Array.from(set).sort((a, b) => a - b).map(t => new Date(t));
  }

  function packGridPrices(tariff) {
    if (!tariff) return null;
    const prices = {};
    for (let i = 1; i <= 24; i++) {
      const k = `Price${i}`;
      prices[k] = tariff[k];
    }
    return prices;
  }

  function gridPricesEqual(a, b) {
    if (!a || !b) return a === b;
    for (let i = 1; i <= 24; i++) {
      if (Number(a[`Price${i}`]) !== Number(b[`Price${i}`])) return false;
    }
    return true;
  }

  function lookupPeriod(periods, dateMs) {
    if (!periods || !periods.length) return null;
    for (let i = periods.length - 1; i >= 0; i--) {
      const p = periods[i];
      if (dateMs >= p.from && (p.to == null || dateMs < p.to)) return p;
    }
    return null;
  }

  function buildGridTimeline(records) {
    const periods = [];
    for (const t of uniqueChargeTimes(records)) {
      const valid = (records || []).filter(r => isChargeValidAt(r, t));
      const merged = mergeGridRebate(
        pickHouseholdGridTariff(valid),
        valid.find(r => chargeTypeCode(r) === "CD R")
      );
      const prices = packGridPrices(merged);
      if (!prices) continue;
      const last = periods[periods.length - 1];
      if (last && gridPricesEqual(last.prices, prices)) continue;
      if (last) last.to = t.getTime();
      periods.push({ from: t.getTime(), to: null, prices });
    }
    return periods;
  }

  function buildEnerginetTimeline(records) {
    const periods = [];
    for (const t of uniqueChargeTimes(records)) {
      const valid = (records || [])
        .filter(r => isChargeValidAt(r, t))
        .sort((a, b) => toDKDate(b.ValidFrom) - toDKDate(a.ValidFrom));
      const transmission = findEnerginetCharge(valid, "Transmissions nettarif");
      const system = findEnerginetCharge(valid, "Systemtarif");
      if (!transmission || !system) continue;
      const inkl = Number((((Number(transmission.Price1) || 0) + (Number(system.Price1) || 0)) * 1.25).toFixed(4));
      const last = periods[periods.length - 1];
      if (last && last.inkl === inkl) continue;
      if (last) last.to = t.getTime();
      periods.push({ from: t.getTime(), to: null, inkl });
    }
    return periods;
  }

  function elafgiftInklAt(dateObj) {
    return elafgiftInklForAar(copenhagenParts(dateObj).year);
  }

  async function fetchDatahubD03Records(gln, limit) {
    const filterStr = `{"GLN_Number":["${gln}"],"ChargeType":["D03"]}`;
    const apiUrl = `https://api.energidataservice.dk/dataset/DatahubPricelist?filter=${encodeURIComponent(filterStr)}&sort=${encodeURIComponent("ValidFrom desc")}${datahubStartParam()}&limit=${limit}`;
    const data = await fetchDatasetJson(
      apiUrl,
      `Henter historiske Datahub-tariffer for ${gln}...`,
      "Tjek GLN og ChargeType i Datahub.",
      { maxRetries: 2, fastFail: true }
    );
    return (data && Array.isArray(data.records)) ? data.records : [];
  }

  function isChargeTimelineFresh(prev, cacheKey) {
    if (!prev || prev.key !== cacheKey) return false;
    const age = Date.now() - (Number(prev.cachedAt) || 0);
    if (!(prev.cachedAt > 0) || age > 7 * 24 * 60 * 60 * 1000) return false;
    const liveFrom = Math.max(
      Number(state.tariffCache && state.tariffCache.gridMeta && state.tariffCache.gridMeta.validFrom) || 0,
      Number(state.tariffCache && state.tariffCache.energinetMeta && state.tariffCache.energinetMeta.validFrom) || 0
    );
    if (liveFrom && liveFrom > prev.cachedAt) return false;
    return true;
  }

  async function getHistoricalChargeTimelines() {
    const weekAvg = state.weekAvg || (state.weekAvg = {});
    const cacheKey = `htw2_${NETSELSKAB}_${ENERGINET_GLN}`;
    const prev = weekAvg.chargeTimelines;
    if (isChargeTimelineFresh(prev, cacheKey)) {
      return prev;
    }
    if (Date.now() < (Number(weekAvg.tariffRetryAt) || 0) && prev && (prev.grid || prev.energinet)) {
      logTrace("Historiske tariffer: sidste timeline (API-backoff)");
      return prev;
    }

    try {
      const gridRecs = AUTO_FETCH_TARIFF
        ? await fetchDatahubD03Records(NETSELSKAB, 1500)
        : [];
      const enRecs = AUTO_FETCH_ENERGINET
        ? await fetchDatahubD03Records(ENERGINET_GLN, 800)
        : [];
      const packed = {
        key: cacheKey,
        cachedAt: Date.now(),
        grid: buildGridTimeline(gridRecs),
        energinet: buildEnerginetTimeline(enRecs)
      };
      weekAvg.chargeTimelines = packed;
      weekAvg.tariffRetryAt = 0;
      saveCacheState();
      logTrace(`Historiske tariffer: ${packed.grid.length} net-perioder, ${packed.energinet.length} Energinet-perioder.`);
      return packed;
    } catch (e) {
      weekAvg.tariffRetryAt = Date.now() + 45 * 60 * 1000;
      saveCacheState();
      if (prev && (prev.grid || prev.energinet)) {
        log(`⚠️ Historiske tariffer fejlede (${e.message}). Bruger sidste kendte timeline.`);
        return prev;
      }
      throw e;
    }
  }

  function sumPricesForRecords(rawRecords, timelines) {
    let sum = 0;
    let count = 0;
    for (const r of rawRecords) {
      const timestamp = slotInstantFromRecord(r);
      if (!isValidDate(timestamp)) continue;
      const ms = timestamp.getTime();
      const gridPeriod = lookupPeriod(timelines && timelines.grid, ms);
      const enPeriod = lookupPeriod(timelines && timelines.energinet, ms);
      const q = buildQuarter(
        r.SpotPriceDKK / 1000,
        timestamp,
        (gridPeriod && gridPeriod.prices) || FetchedGridTariff,
        (enPeriod && typeof enPeriod.inkl === "number") ? enPeriod.inkl : FetchedEnerginetTariff,
        elafgiftInklAt(timestamp)
      );
      if (!Number.isFinite(q.total)) continue;
      sum += q.total;
      count++;
    }
    return { sum, count };
  }

  function filterDayAheadRange(rawRecords, startDate, endDate) {
    const a = fmtYmd(startDate);
    const b = fmtYmd(endDate);
    const out = [];
    for (let i = 0; i < (rawRecords || []).length; i++) {
      const r = rawRecords[i];
      const inst = slotInstantFromRecord(r);
      if (!isValidDate(inst)) continue;
      const k = fmtYmd(inst);
      if (k >= a && k < b) out.push(r);
    }
    return out;
  }

  function expectedQuartersInRange(startDate, endDate) {
    const days = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    if (!(days > 0)) return 0;
    return days * 80;
  }

  async function fetchDayAheadRecords(priceArea, startDate, endDate) {
    const pageSize = 2000;
    let offset = 0;
    const merged = [];

    while (true) {
      const apiUrl = `https://api.energidataservice.dk/dataset/DayAheadPrices?` +
        `filter=${encodeURIComponent(JSON.stringify({ PriceArea: [priceArea] }))}` +
        `&sort=${encodeURIComponent("TimeUTC asc")}` +
        `&start=${encodeURIComponent(fmtYmd(startDate) + "T00:00")}` +
        `&end=${encodeURIComponent(fmtYmd(endDate) + "T00:00")}` +
        `&limit=${pageSize}&offset=${offset}`;

      const data = await fetchDatasetJson(
        apiUrl,
        `Henter historiske elpriser (${fmtYmd(startDate)}–${fmtYmd(endDate)})...`,
        "Tjek evt. datoformat eller PriceArea.",
        { maxRetries: 2, fastFail: true }
      );
      const batch = (data && Array.isArray(data.records)) ? data.records : [];
      merged.push(...batch);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }

    merged.sort((a, b) => {
      const ta = parseApiUtc(a.TimeUTC) || toDKDate(a.TimeDK || a.HourDK);
      const tb = parseApiUtc(b.TimeUTC) || toDKDate(b.TimeDK || b.HourDK);
      return ta - tb;
    });
    return normalizeQuarterRecords(merged);
  }

  async function sumSpotRange(startDate, endDate, timelines, allowFetch) {
    const need = expectedQuartersInRange(startDate, endDate);
    let raw = filterDayAheadRange(records, startDate, endDate);
    if (raw.length >= need) {
      logTrace(`Uge-snit ${fmtYmd(startDate)}–${fmtYmd(endDate)}: ${raw.length} kvarter fra allerede hentede priser`);
      return sumPricesForRecords(raw, timelines);
    }

    if (!allowFetch) {
      logTrace(`Uge-snit ${fmtYmd(startDate)}–${fmtYmd(endDate)}: kun ${raw.length}/${need} i lager — venter med nyt API-kald`);
      return raw.length ? sumPricesForRecords(raw, timelines) : null;
    }

    try {
      raw = await fetchDayAheadRecords(priceAreaNorm, startDate, endDate);
      if (!raw.length) return null;
      return sumPricesForRecords(raw, timelines);
    } catch (e) {
      const weekAvg = state.weekAvg || (state.weekAvg = {});
      weekAvg.spotRetryAt = Date.now() + 45 * 60 * 1000;
      saveCacheState();
      log(`⚠️ Kunne ikke hente ugetal: ${e.message}`);
      reportFejl("D-402", e.message);
      return raw.length ? sumPricesForRecords(raw, timelines) : null;
    }
  }

  async function getWeekAverages() {
    const pNow = copenhagenParts(DatoNuStartpoint);
    const weekAvg = state.weekAvg || (state.weekAvg = {});
    const thisWeekStart = startOfIsoWeekNoon(DatoNuStartpoint);
    const lastWeekStart = addUtcDays(thisWeekStart, -7);
    const todayStart = new Date(Date.UTC(pNow.year, pNow.month - 1, pNow.day, 12, 0, 0));
    const isMonday = fmtYmd(thisWeekStart) === fmtYmd(todayStart);
    const lastKey = `w1_${fmtYmd(lastWeekStart)}`;
    const priorKey = `w1_${fmtYmd(thisWeekStart)}_${fmtYmd(todayStart)}`;

    const lastReady = weekAvg.lastKey === lastKey && typeof weekAvg.lastAvg === "number";
    const priorReady = isMonday || weekAvg.priorKey === priorKey;
    const slotMs = TimeNuMs;

    const applyTodaySlot = () => {
      const day = quarterIndex.todayRecords || [];
      const lastSlot = Number(weekAvg.todaySlotMs) || 0;
      const gapSlots = lastSlot
        ? Math.round((slotMs - lastSlot) / (15 * 60 * 1000))
        : 99;
      const newDay = weekAvg.todayDay !== idagStr;
      let i = Number(weekAvg.todayNext) || 0;
      const badIndex = i < 0 || i > day.length;
      const resync = newDay || badIndex || gapSlots < 0 || gapSlots > 96;

      if (resync) {
        weekAvg.todaySum = 0;
        weekAvg.todayCount = 0;
        i = 0;
        weekAvg.todayDay = idagStr;
      }

      let added = 0;
      while (i < day.length && day[i].timestampMs <= slotMs) {
        weekAvg.todaySum += day[i].total;
        weekAvg.todayCount++;
        i++;
        added++;
      }
      weekAvg.todayNext = i;
      if (added || resync) saveCacheState();
      if (resync || added > 1) {
        logTrace(
          "Uge-snit i dag: " +
            (resync ? "genopbygget fra kl. 0" : "indhentet") +
            " (+" + added + " kvarter efter pause)."
        );
      }
      return {
        sum: Number(weekAvg.todaySum) || 0,
        count: Number(weekAvg.todayCount) || 0
      };
    };

    const finish = (lastAvg, priorSum, priorCount) => {
      const today = applyTodaySlot();
      const sum = priorSum + today.sum;
      const count = priorCount + today.count;
      const thisAvg = count ? roundPrice(sum / count) : 0;
      weekAvg.todaySlotMs = slotMs;
      weekAvg.thisAvg = thisAvg;
      weekAvg.thisCount = count;
      saveCacheState();
      return {
        lastWeekAvg: lastAvg == null ? 0 : lastAvg,
        thisWeekAvg: thisAvg,
        thisWeekCount: Number(count) || 0
      };
    };

    if (
      lastReady &&
      priorReady &&
      weekAvg.todayDay === idagStr &&
      weekAvg.todaySlotMs === slotMs &&
      typeof weekAvg.thisAvg === "number"
    ) {
      logTrace("Uge-snit fra cache (samme kvarter).");
      return {
        lastWeekAvg: weekAvg.lastAvg,
        thisWeekAvg: weekAvg.thisAvg,
        thisWeekCount: Number(weekAvg.thisCount) || 0
      };
    }

    if (lastReady && priorReady) {
      const priorSum = isMonday ? 0 : (Number(weekAvg.priorSum) || 0);
      const priorCount = isMonday ? 0 : (Number(weekAvg.priorCount) || 0);
      logTrace("Uge-snit fra cache (ét nyt kvarter).");
      return finish(weekAvg.lastAvg, priorSum, priorCount);
    }

    let lastWeekAvg = lastReady ? weekAvg.lastAvg : null;
    let priorSum = 0;
    let priorCount = 0;
    let needPrior = !isMonday && weekAvg.priorKey !== priorKey;
    if (!needPrior && !isMonday && weekAvg.priorKey === priorKey) {
      priorSum = Number(weekAvg.priorSum) || 0;
      priorCount = Number(weekAvg.priorCount) || 0;
    }

    const allowSpotFetch = Date.now() >= (Number(weekAvg.spotRetryAt) || 0);
    let timelines = { grid: [], energinet: [] };
    try {
      timelines = await getHistoricalChargeTimelines();
    } catch (e) {
      log(`⚠️ Historiske tariffer kunne ikke hentes (${e.message}). Uge-snit bruger aktuelle tariffer som fallback.`);
      reportFejl("D-401", e.message);
    }

    if (lastWeekAvg == null) {
      const lastSum = await sumSpotRange(lastWeekStart, thisWeekStart, timelines, allowSpotFetch);
      if (lastSum && lastSum.count) {
        lastWeekAvg = roundPrice(lastSum.sum / lastSum.count);
        weekAvg.lastKey = lastKey;
        weekAvg.lastAvg = lastWeekAvg;
        weekAvg.spotRetryAt = 0;
        saveCacheState();
      } else if (weekAvg.lastKey === lastKey && typeof weekAvg.lastAvg === "number") {
        lastWeekAvg = weekAvg.lastAvg;
      }
    }

    if (needPrior) {
      const prior = await sumSpotRange(thisWeekStart, todayStart, timelines, allowSpotFetch);
      if (prior && prior.count) {
        priorSum = prior.sum;
        priorCount = prior.count;
        weekAvg.priorKey = priorKey;
        weekAvg.priorSum = priorSum;
        weekAvg.priorCount = priorCount;
        weekAvg.spotRetryAt = 0;
        saveCacheState();
      }
    }

    return finish(lastWeekAvg, priorSum, priorCount);
  }

  function alarmTimeHHMM(hour, minute) {
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  function normalizeAlarmTime(t) {
    const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return "";
    return `${pad2(m[1])}:${m[2]}`;
  }

  function weekdayRepetitionFlags(dateObj) {
    const flags = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false
    };
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if (!dateObj || !isValidDate(dateObj)) return flags;
    flags[names[copenhagenWeekday(dateObj)]] = true;
    return flags;
  }

  function alarmPayloadDiffers(existing, next) {
    if (!existing) return true;
    if (String(existing.name || "") !== next.name) return true;
    if (normalizeAlarmTime(existing.time) !== next.time) return true;
    if (Boolean(existing.enabled) !== Boolean(next.enabled)) return true;
    const r = existing.repetition || {};
    for (const day of Object.keys(next.repetition)) {
      if (Boolean(r[day]) !== Boolean(next.repetition[day])) return true;
    }
    return false;
  }

  async function listHomeyAlarms() {
    if (typeof Homey === "undefined" || !Homey.alarms || !Homey.alarms.getAlarms) return [];
    const all = await Homey.alarms.getAlarms();
    return Array.isArray(all) ? all : Object.values(all || {});
  }

  async function rememberElprisAlarm(alarm, name) {
    const id = alarm && alarm.id;
    if (!id) return alarm;
    const lookup = String(name || "");
    const same =
      state.elprisAlarmId === id &&
      state.elprisAlarmLookupName === lookup &&
      !state.elprisAlarmKnownMissing;
    if (!same) {
      state.elprisAlarmId = id;
      state.elprisAlarmLookupName = lookup;
      state.elprisAlarmKnownMissing = false;
      saveCacheState();
    }
    return alarm;
  }

  async function getHomeyAlarmById(id) {
    if (!id || typeof Homey === "undefined" || !Homey.alarms) return null;
    if (typeof Homey.alarms.getAlarm !== "function") return null;
    try {
      const alarm = await Homey.alarms.getAlarm({ id });
      return alarm || null;
    } catch (_) {
      return null;
    }
  }

  async function searchHomeyAlarmByName(name) {
    const list = await listHomeyAlarms();
    state.elprisAlarmListSearchAt = Date.now();
    const found = list.find(a => a && a.name === name) || null;
    if (found) {
      logTrace(`Fandt Homey-ur '${name}' via alarmliste (id gemt).`);
      return rememberElprisAlarm(found, name);
    }
    state.elprisAlarmKnownMissing = true;
    state.elprisAlarmLookupName = name;
    delete state.elprisAlarmId;
    saveCacheState();
    return null;
  }

  async function findHomeyAlarm(name) {
    const cachedId = state.elprisAlarmId;
    const nameOk = state.elprisAlarmLookupName === name;
    const listCooldownMs = 60 * 60 * 1000;

    if (cachedId && nameOk) {
      const byId = await getHomeyAlarmById(cachedId);
      if (byId && String(byId.name || "") === name) {
        logTrace(`Homey-ur via gemt id (${cachedId}).`);
        return rememberElprisAlarm(byId, name);
      }
      logTrace("getAlarm fejlede eller navn matcher ikke — søger i alarmlisten.");
      return await searchHomeyAlarmByName(name);
    }

    if (nameOk && state.elprisAlarmKnownMissing) {
      const last = Number(state.elprisAlarmListSearchAt) || 0;
      if (last && Date.now() - last < listCooldownMs) {
        logTrace("Intet Homey-ur sidst — springer getAlarms() over.");
        return null;
      }
    }

    return await searchHomeyAlarmByName(name);
  }

  async function syncOptimalHomeyAlarm(opts) {
    const name = opts && opts.name;
    if (!name) return "slået fra";
    if (typeof Homey === "undefined" || !Homey.alarms) return "API mangler";

    const time = (opts.found && opts.startKL >= 0)
      ? alarmTimeHHMM(opts.startKL, opts.startMIN)
      : "";

    let alarm = await findHomeyAlarm(name);
    if (!alarm && !time) return "ingen periode";

    const next = {
      name,
      time: time || normalizeAlarmTime(alarm && alarm.time) || "00:00",
      enabled: Boolean(opts.enable && time),
      repetition: time ? weekdayRepetitionFlags(opts.startDato) : ((alarm && alarm.repetition) || weekdayRepetitionFlags(null))
    };
    if (!alarm) {
      if (typeof Homey.alarms.createAlarm !== "function") return "kan ikke oprettes";
      alarm = await Homey.alarms.createAlarm({ alarm: next });
      await rememberElprisAlarm(alarm, name);
      return next.enabled ? `oprettet kl. ${next.time}` : `oprettet (slukket)`;
    }

    await rememberElprisAlarm(alarm, name);
    if (!alarmPayloadDiffers(alarm, next)) {
      return next.enabled ? `kl. ${next.time}` : `kl. ${next.time} (slukket)`;
    }
    if (typeof Homey.alarms.updateAlarm !== "function") return "kan ikke opdateres";
    await Homey.alarms.updateAlarm({ id: alarm.id, alarm: next });
    return next.enabled ? `sat til kl. ${next.time}` : `kl. ${next.time} (slukket)`;
  }

  async function rememberElprisDevice(device) {
    const id = device && device.id;
    if (!id) return device;
    const same =
      state.elprisDeviceId === id &&
      state.elprisDeviceLookupName === elprisDeviceName &&
      !state.elprisDeviceKnownMissing;
    if (!same) {
      if (state.elprisDeviceId && state.elprisDeviceId !== id) delete state.elprisCapIds;
      state.elprisDeviceId = id;
      state.elprisDeviceLookupName = elprisDeviceName;
      state.elprisDeviceKnownMissing = false;
      saveCacheState();
    }
    return device;
  }

  function forgetElprisDevice() {
    if (state.elprisDeviceId || state.elprisDeviceLookupName || state.elprisDeviceKnownMissing) {
      delete state.elprisDeviceId;
      delete state.elprisDeviceLookupName;
      delete state.elprisDeviceKnownMissing;
      delete state.elprisDeviceListSearchAt;
      delete state.elprisCapIds;
      saveCacheState();
    }
  }

  function markElprisDeviceMissing() {
    state.elprisDeviceKnownMissing = true;
    state.elprisDeviceListSearchAt = Date.now();
    state.elprisDeviceLookupName = elprisDeviceName;
    delete state.elprisDeviceId;
    delete state.elprisCapIds;
    saveCacheState();
  }

  async function searchElprisVirtualDeviceByName() {
    if (!Homey.devices.getDevices) return null;
    state.elprisDeviceListSearchAt = Date.now();
    saveCacheState();
    const allDevices = await Homey.devices.getDevices();
    const list = Array.isArray(allDevices) ? allDevices : Object.values(allDevices || {});
    const found = list.find(d => d && d.name === elprisDeviceName) || null;
    if (found) {
      logTrace(`Fandt virtuel enhed '${elprisDeviceName}' via enhedsliste (id gemt).`);
      return rememberElprisDevice(found);
    }
    markElprisDeviceMissing();
    logTrace(`Ingen enhed ved navn '${elprisDeviceName}' — springer listen over indtil næste cooldown.`);
    return null;
  }

  async function findElprisVirtualDevice() {
    if (!elprisDeviceName) {
      forgetElprisDevice();
      return null;
    }
    if (typeof Homey === "undefined" || !Homey.devices) return null;

    const cachedId = state.elprisDeviceId;
    const nameOk = state.elprisDeviceLookupName === elprisDeviceName;
    const listCooldownMs = 60 * 60 * 1000;

    if (cachedId && nameOk && typeof Homey.devices.getDevice === "function") {
      try {
        const byId = await Homey.devices.getDevice({ id: cachedId });
        if (byId) {
          logTrace(`Virtuel enhed via gemt id (${cachedId}).`);
          return rememberElprisDevice(byId);
        }
      } catch (_) {
        logTrace("getDevice fejlede — søger én gang i enhedslisten.");
      }
      // Fejl eller tomt svar: dyre fallback kun her
      return await searchElprisVirtualDeviceByName();
    }

    if (nameOk && state.elprisDeviceKnownMissing) {
      const last = Number(state.elprisDeviceListSearchAt) || 0;
      if (last && Date.now() - last < listCooldownMs) {
        logTrace("Ingen virtuel enhed sidst — springer getDevices() over.");
        return null;
      }
    }

    return await searchElprisVirtualDeviceByName();
  }

  async function updateElprisVirtualDevice(device, fields, writeCold, deviceCapMap) {
    const missingKeys = [];
    if (!device) {
      logTrace("Ingen virtuel enhed — dashboard-tal udgives som flow-tags.");
      return missingKeys;
    }

    try {
      const forceAll = isTrace();
      const writeColdDevice = forceAll || writeCold !== false;
      const capMap = deviceCapMap || mapAllDeviceCaps(device, fields);
      const jobs = [];

      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.skipDevice) continue;
        const found = capMap[field.key];
        if (!found) continue;
        const unset = found.cap.value == null || found.cap.value === "";
        if (!forceAll && !field.hot && !writeColdDevice && !unset) continue;
        const capId = found.capId;
        const cap = found.cap;

        if (field.type === "boolean") {
          const on = Boolean(field.value);
          const kind = capKind(cap, capId);
          if (!forceAll && capAlreadyEquals(cap, kind, on)) continue;
          logTrace(`Enhed felt ${field.titles[0]} → ${on ? "on" : "off"} (${capId})`);
          jobs.push({ field, capId, cap, on: true, boolOn: on });
          continue;
        }

        if (field.type === "string") {
          const next = String(field.value);
          if (!forceAll && String(cap.value ?? "") === next) continue;
          logTrace(`Enhed felt ${field.titles[0]} → ${next} (${capId})`);
          jobs.push({ field, capId, cap, value: next });
          continue;
        }

        const precision = field.precision ?? 2;
        const next = Number(Number(field.value).toFixed(precision));
        const current = Number(Number(cap.value).toFixed(precision));
        if (!forceAll && Number.isFinite(current) && next === current) continue;
        logTrace(`Enhed felt ${field.titles[0]} → ${next} (${capId})`);
        jobs.push({ field, capId, cap, value: next });
      }

      if (!jobs.length) {
        logTrace(`Virtuel enhed '${elprisDeviceName}': ingen ændringer.`);
        return missingKeys;
      }

      const results = await Promise.allSettled(
        jobs.map(job => {
          if (job.on) return setDeviceCapability(device, job.capId, job.boolOn, job.cap);
          return writeDeviceValue(device, job.capId, job.value, job.cap);
        })
      );
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length) {
        const names = [];
        let firstMsg = "";
        let forgotIds = false;
        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== "rejected") continue;
          const job = jobs[i];
          const reason = results[i].reason;
          const key = job.field && job.field.key;
          if (isMissingCapErr(reason)) {
            if (key) missingKeys.push(key);
            if (key && state.elprisCapIds && state.elprisCapIds[key]) {
              delete state.elprisCapIds[key];
              forgotIds = true;
            }
            continue;
          }
          const msg = reason && reason.message ? reason.message : String(reason || "");
          if (!firstMsg) firstMsg = msg;
          if (job.field && job.field.titles && job.field.titles[0]) names.push(job.field.titles[0]);
        }
        if (forgotIds) saveCacheState();
        if (names.length) reportFejl("E-504", names.join(", ") + (firstMsg ? " — " + firstMsg : ""));
      } else {
        logTrace(`Virtuel enhed '${elprisDeviceName}': ${jobs.length} ændring(er) skrevet.`);
      }
    } catch (e) {
      logTrace(`Springer virtuel enhed over: ${e.message}`);
    }
    return missingKeys;
  }

})();
