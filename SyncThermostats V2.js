// ############################################################################
// 1. Hovedformålet
// Scriptet sørger for, at hvis du ændrer temperaturen på én termostat, så følger
// alle de andre termostater i samme gruppe automatisk med. Det sparer dig for
// at skulle lave manuelle flows for hver eneste kombination af termostater
// (hvis A ændres -> opdater B, hvis B ændres -> opdater A osv.).
//
// 2. De "intelligente" funktioner
// Scriptet er mere avanceret end et simpelt flow, fordi det håndterer tre udfordringer:
// - Undgår "Loop-kaos" (Sync Lock): Forhindrer at termostaterne trigger hinanden
//   i en uendelig løkke.
// - Debounce (Ventetid): Venter 3 sekunder (DEBOUNCE_PERIOD_MS) på at du har
//   skruet færdig, før det sender signalet videre. Det sparer batteri og netværk.
// - Automatisk identifikation: Scriptet finder selv termostaterne i dit
//   Advanced Flow, som er brugt som "Måltemperatur er ændret" triggere.
//
// 3. Hvordan bruger du det i praksis?
// - Opret et Advanced Flow.
//   "Måltemperaturen er ændret" og "Termostat-tilstand er ændret".
// - (Valgfrit) Indsæt dør/vindue sensorer som triggere: "Kontakt-alarmen ændres".
// - Forbind alle disse triggere til ét kort: "Logik: Kør HomeyScript med argument".
// - I argument-feltet skal du indsætte ID'et på dit Advanced Flow
//   (findes i URL'en i din browser).
// - Gem scriptet under navnet SyncThermostats.
// ############################################################################

// ################
// ### ARGUMENTER
// #######

const TESTING_FLOW_ID = "63fadb39-9493-491b-b9ff-e36c7c5b68b2"

// ################
// ### KONFIGURATION
// #######

// Tid at vente på yderligere opdateringer, før synkroniseringen startes
const DEBOUNCE_PERIOD_MS  = 3000

// Afrund måltemperatur til nærmeste 0,5 (f.eks. 20,3 -> 20,5 eller 20,1 -> 20,0)
const ROUND_TO_NEAREST_HALF = true

// Temperatur der skal sættes, hvis en dør-/vinduessensor er åben
const WINDOW_OPEN_TEMP = 5

// Sæt til true for at aktivere vinduesdetektering, false for at deaktivere
const ENABLE_WINDOW_OPEN_DETECTION = true

// Forsinkelse i sekunder før vindueslogik aktiveres (forhindrer aktivering ved hurtig åbning/lukning)
const WINDOW_OPEN_DELAY_SEC = 30

// Tid at vente mellem enhedsopdateringer for ikke at overbelaste netværket
const SYNC_GAP_PERIOD_MS  = 100

// Tid at vente på, at alle opdateringer er anvendt efter sync, før processen låses op
// Denne forsinkelse forhindrer, at selve synkroniseringen udløser en ny synkronisering
const POST_SYNC_PERIOD_MS = 1000

// Hvor tæt temperaturer skal være for at tælle som ens
const TEMP_EQUAL_EPS = 0.05

// Max tid at vente på en optaget sync-lås (derefter overtages en mulig hængende lås)
const LOCK_WAIT_MAX_MS = 20000
const LOCK_RETRY_MS = 400
const LOCK_STALE_MS = 90000

// ################
// ### INITIALISERING
// #######

if (!args[0]) {
  log(`Ingen flow-id i argumentet. Bruger test-flow-id: ${TESTING_FLOW_ID}`)
  args[0] = TESTING_FLOW_ID
}

const flowId = args[0]
const SYNC_LOCK_VAR_NAME = `HomeyScript:SyncThermostats:sync_lock:${flowId}`
const GLOBAL_TARGET_TEMP_KEY = `flow:${flowId}:newest_target_temperature`
const RESTORE_STATE_VAR_NAME = `HomeyScript:SyncThermostats:restore_state:${flowId}`
const WINDOW_WAIT_VAR_NAME = `HomeyScript:SyncThermostats:window_wait:${flowId}`
const runToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

// ################
// ### HJÆLPEFUNKTIONER
// #######

function roundToHalf(temp) {
  return Math.round(Number(temp) * 2) / 2
}

function tempsEqual(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false
  const na = Number(a)
  const nb = Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return false
  return Math.abs(na - nb) < TEMP_EQUAL_EPS
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

function lastUriSegment(uri) {
  if (!uri || typeof uri !== 'string') return null
  const parts = uri.split(':')
  return parts[parts.length - 1] || null
}

function deviceIdFromCard(card) {
  if (card.ownerUri && card.ownerUri.indexOf('homey:device:') === 0) {
    return lastUriSegment(card.ownerUri)
  }
  if (card.id && card.id.indexOf('homey:device:') === 0) {
    const parts = card.id.split(':')
    if (parts.length >= 3) return parts[2]
  }
  return lastUriSegment(card.ownerUri)
}

function comfortTempAmong(thermostats) {
  let best = null
  for (const device of thermostats) {
    const temp = device.capabilitiesObj && device.capabilitiesObj.target_temperature
      ? toNumberOrNull(device.capabilitiesObj.target_temperature.value)
      : null
    if (temp !== null && temp > WINDOW_OPEN_TEMP && (best === null || temp > best)) {
      best = temp
    }
  }
  return best
}

function saveRestoreStateIfNeeded(thermostats, leader) {
  if (parseStored(global.get(RESTORE_STATE_VAR_NAME))) return
  const tempToSave = comfortTempAmong(thermostats)
  if (tempToSave === null) return
  const stateToSave = {
    temp: tempToSave,
    mode: leader && leader.thermostatMode ? leader.thermostatMode.value : null
  }
  writeStored(RESTORE_STATE_VAR_NAME, stateToSave)
  log(`Gemmer tilstand før lav temperatur: ${stateToSave.temp}°C / ${stateToSave.mode}`)
}

function parseStored(raw) {
  if (raw === null || raw === undefined || raw === false || raw === '') return null
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return null }
  }
  return null
}

function writeStored(key, value) {
  if (value === null || value === undefined) {
    global.set(key, null)
    return
  }
  global.set(key, JSON.stringify(value))
}

function isDebounceStale() {
  return global.get(GLOBAL_TARGET_TEMP_KEY) != timestamp
}

function readLock() {
  const raw = global.get(SYNC_LOCK_VAR_NAME)
  if (raw === true) return { token: 'legacy', until: 0 }
  return parseStored(raw)
}

function lockIsFree() {
  const lock = readLock()
  if (!lock || !lock.token) return true
  if (!lock.until || Date.now() > lock.until) return true
  return false
}

function writeLock(token) {
  writeStored(SYNC_LOCK_VAR_NAME, { token, until: Date.now() + LOCK_STALE_MS })
}

function lockIsMine(token) {
  const lock = readLock()
  return !!(lock && lock.token === token && lock.until && Date.now() <= lock.until)
}

async function acquireLock(token, options) {
  const ignoreStale = options && options.ignoreStale
  const deadline = Date.now() + LOCK_WAIT_MAX_MS
  while (Date.now() < deadline) {
    if (!ignoreStale && isDebounceStale()) return 'stale'
    if (lockIsFree()) {
      writeLock(token)
      await wait(50)
      if (lockIsMine(token)) return 'acquired'
    }
    await wait(LOCK_RETRY_MS)
  }
  if (!ignoreStale && isDebounceStale()) return 'stale'
  log("Synk-låsen ser ud til at hænge. Overtager den.")
  writeLock(token)
  await wait(50)
  return lockIsMine(token) ? 'acquired' : 'failed'
}

function releaseLock(token) {
  if (lockIsMine(token) || (readLock() && readLock().token === token)) {
    global.set(SYNC_LOCK_VAR_NAME, null)
  }
}

function readWindowWait() {
  return parseStored(global.get(WINDOW_WAIT_VAR_NAME))
}

function windowWaitIsActive() {
  const waitState = readWindowWait()
  if (!waitState || !waitState.token) return false
  if (!waitState.until || Date.now() > waitState.until) return false
  return true
}

function deviceModeValues(device) {
  const cap = device.capabilitiesObj && device.capabilitiesObj.thermostat_mode
  if (!cap) return []
  const values = cap.values || []
  return values.map(v => (typeof v === 'string' ? v : (v && (v.id || v.value)))).filter(Boolean)
}

function isContactOpen(sensor) {
  const value = sensor && sensor.capabilitiesObj && sensor.capabilitiesObj.alarm_contact
    ? sensor.capabilitiesObj.alarm_contact.value
    : null
  return value === true || value === 'true' || value === 1 || value === '1'
}

function deviceSupportsMode(device, mode) {
  if (!mode || !device.capabilitiesObj || !device.capabilitiesObj.thermostat_mode) return false
  const values = deviceModeValues(device)
  if (values.length === 0) return true
  const wanted = String(mode).toLowerCase()
  return values.some(v => String(v).toLowerCase() === wanted)
}

function resolveWindowMode(thermostats) {
  const withMode = thermostats.filter(d => d.capabilitiesObj && d.capabilitiesObj.thermostat_mode)
  if (withMode.length === 0) return null
  if (withMode.some(d => deviceSupportsMode(d, 'off'))) return 'off'
  return null
}

/**
 * Finder alle enheder (termostater og sensorer) fra trigger-kortene i et flow.
 */
async function getTriggeredDevices(flowId) {
    const flow = await Homey.flow.getAdvancedFlow({ id: flowId });
    log(`Synkroniserer triggere for flowet "${flow.name}"`);

    const cards = flow.cards ? Object.values(flow.cards) : []
    const triggerDeviceIds = [...new Set(cards
        .filter(card => card && card.type === 'trigger' && card.id && (
            card.id.endsWith(":target_temperature_changed") ||
            card.id.endsWith("target_temperature_changed") ||
            card.id.endsWith(":thermostat_mode_changed") ||
            card.id.endsWith("thermostat_mode_changed") ||
            card.id.endsWith(":alarm_contact_changed") ||
            card.id.endsWith("alarm_contact_changed")
        ))
        .map(card => deviceIdFromCard(card))
        .filter(id => id))];

    const allDevices = []
    for (const deviceId of triggerDeviceIds) {
        try {
            allDevices.push(await Homey.devices.getDevice({ id: deviceId }))
        } catch (err) {
            log(`Kunne ikke hente enhed ${deviceId}: ${err.message}`)
        }
    }

    const thermostats = allDevices.filter(d => d.capabilitiesObj && ('target_temperature' in d.capabilitiesObj || 'thermostat_mode' in d.capabilitiesObj));
    const sensors = allDevices.filter(d => d.capabilitiesObj && 'alarm_contact' in d.capabilitiesObj);

    return { thermostats, sensors, triggerDeviceIds };
}

/**
 * Finder den termostat, der senest er blevet opdateret.
 */
function findLeaderThermostat(thermostats) {
    if (!thermostats || thermostats.length === 0) return null
    return thermostats
        .map(device => {
            const caps = device.capabilitiesObj || {};
            const tempLast = (caps.target_temperature && caps.target_temperature.lastUpdated) ? Date.parse(caps.target_temperature.lastUpdated) : 0;
            const modeLast = (caps.thermostat_mode && caps.thermostat_mode.lastUpdated) ? Date.parse(caps.thermostat_mode.lastUpdated) : 0;
            return {
                id: device.id,
                lastUpdated: Math.max(tempLast || 0, modeLast || 0),
                targetTemperature: caps.target_temperature || null,
                thermostatMode: caps.thermostat_mode || null,
            };
        })
        .reduce((latest, current) => (current.lastUpdated > latest.lastUpdated ? current : latest));
}

/**
 * Synkroniserer den ønskede temperatur og tilstand til alle termostater.
 * Enheder der allerede har værdien (inden for tolerance) springes over.
 */
async function syncDevices(thermostats, targetTemp, targetMode) {
    if (targetTemp !== null) log(`Måltemperatur: ${targetTemp}°C`);
    if (targetMode !== null) log(`Måltilstand: ${targetMode}`);

    for (const device of thermostats) {
        let didUpdate = false;
        const supportsMode = deviceSupportsMode(device, targetMode)
        const currentMode = device.capabilitiesObj && device.capabilitiesObj.thermostat_mode
            ? device.capabilitiesObj.thermostat_mode.value
            : null
        const currentTemp = device.capabilitiesObj && device.capabilitiesObj.target_temperature
            ? device.capabilitiesObj.target_temperature.value
            : null

        const setTempFirst = targetMode === 'off'

        const applyMode = async function () {
            if (targetMode === null || !supportsMode || currentMode === targetMode) return
            if (typeof currentMode === 'string' && currentMode.toLowerCase() === String(targetMode).toLowerCase()) return
            log(`Synkroniserer tilstand på ${device.name} til ${targetMode}...`);
            try {
                await device.setCapabilityValue('thermostat_mode', targetMode);
                if (device.capabilitiesObj.thermostat_mode) device.capabilitiesObj.thermostat_mode.value = targetMode;
                await wait(SYNC_GAP_PERIOD_MS);
                didUpdate = true;
            } catch (err) {
                log(`Fejl ved opdatering af tilstand på ${device.name}: ${err.message}`);
            }
        }

        const applyTemp = async function () {
            if (targetTemp === null || !device.capabilitiesObj || !device.capabilitiesObj.target_temperature) return
            if (tempsEqual(currentTemp, targetTemp)) return
            log(`Synkroniserer temperatur på ${device.name} til ${targetTemp}°C...`);
            try {
                await device.setCapabilityValue('target_temperature', targetTemp);
                if (device.capabilitiesObj.target_temperature) device.capabilitiesObj.target_temperature.value = targetTemp;
                await wait(SYNC_GAP_PERIOD_MS);
                didUpdate = true;
            } catch (err) {
                log(`Fejl ved opdatering af temperatur på ${device.name}: ${err.message}`);
            }
        }

        if (setTempFirst) {
            await applyTemp()
            await applyMode()
        } else {
            await applyMode()
            await applyTemp()
        }

        if (!didUpdate) {
            if (targetMode !== null && device.capabilitiesObj && device.capabilitiesObj.thermostat_mode && !supportsMode) {
                log(`Springer tilstand ${targetMode} over på ${device.name} (understøttes ikke)`);
            }
            log(`Ingen opdatering nødvendig for ${device.name}`);
        }
    }
}

/**
 * Hovedfunktionen der orkestrerer hele synkroniseringen.
 */
async function main() {
    const lockResult = await acquireLock(runToken)
    if (lockResult === 'stale') {
        log("En nyere synk kører allerede. Stopper denne kørsel.")
        return
    }
    if (lockResult !== 'acquired') {
        log("Kunne ikke få synk-låsen. Afbryder.")
        return
    }

    let iHoldTheLock = true
    let iHoldWindowWait = false

    try {
        log("Låser synkroniseringen.");

        let { thermostats, sensors } = await getTriggeredDevices(flowId);

        log("--- Termostater ---");
        if (thermostats.length === 0) {
            log("Ingen termostater fundet i trigger-kortene. Afbryder.");
            return;
        }
        thermostats.forEach(t => log(t.name));
        log("------");

        let leader = findLeaderThermostat(thermostats);

        let openSensor = ENABLE_WINDOW_OPEN_DETECTION
            ? sensors.find(s => isContactOpen(s))
            : null;

        // Vindues-forsinkelse: frigiv låsen, så "vindue lukket" kan køre imens.
        if (openSensor && WINDOW_OPEN_DELAY_SEC > 0) {
            const lastUpdatedRaw = openSensor.capabilitiesObj.alarm_contact.lastUpdated
            const lastUpdated = lastUpdatedRaw ? new Date(lastUpdatedRaw).getTime() : NaN
            const delayMs = WINDOW_OPEN_DELAY_SEC * 1000
            const diff = Number.isNaN(lastUpdated) ? 0 : (Date.now() - lastUpdated)

            if (diff < delayMs) {
                if (windowWaitIsActive()) {
                    log("En anden proces venter allerede på vindues-forsinkelsen. Gemmer tilstand og afbryder overflødig kørsel.");
                    saveRestoreStateIfNeeded(thermostats, leader)
                    return;
                }

                saveRestoreStateIfNeeded(thermostats, leader)

                const remainingMs = Math.max(delayMs - diff, 0)
                log(`Vindue/dør er åben, venter på forsinkelse (${Math.round(remainingMs / 1000)} s)...`);
                writeStored(WINDOW_WAIT_VAR_NAME, {
                    token: runToken,
                    until: Date.now() + remainingMs + 15000
                })
                iHoldWindowWait = true
                releaseLock(runToken)
                iHoldTheLock = false

                await wait(remainingMs)

                // Gennemfør altid efter ventetiden: en nyere kørsel kan have
                // afbrudt sig selv, fordi denne vindues-vent stadig kørte.
                const reacquire = await acquireLock(runToken, { ignoreStale: true })
                if (reacquire !== 'acquired') {
                    throw new Error("Kunne ikke få synk-låsen igen efter vindues-vent.")
                }
                iHoldTheLock = true

                const freshDevices = await getTriggeredDevices(flowId);
                thermostats = freshDevices.thermostats;
                sensors = freshDevices.sensors;
                if (thermostats.length === 0) {
                    log("Ingen termostater fundet efter vindues-vent. Afbryder.");
                    return;
                }
                leader = findLeaderThermostat(thermostats);
                openSensor = ENABLE_WINDOW_OPEN_DETECTION
                    ? sensors.find(s => isContactOpen(s))
                    : null;
                if (!openSensor) log("Vindue/dør blev lukket under ventetiden. Fortsætter med normal synk...");
            }
        }

        let targetTemp = null;
        let targetMode = null;

        if (openSensor) {
            log(`!! Åbent vindue/dør registreret: ${openSensor.name || 'Ukendt'} !!`);
            saveRestoreStateIfNeeded(thermostats, leader)
            targetTemp = WINDOW_OPEN_TEMP;
            targetMode = resolveWindowMode(thermostats);
        } else {
            const savedState = parseStored(global.get(RESTORE_STATE_VAR_NAME));
            if (savedState) {
                log(`Vindue/dør lukket. Gendanner tilstand: ${savedState.temp}°C / ${savedState.mode}`);
                targetTemp = toNumberOrNull(savedState.temp);
                targetMode = savedState.mode || null;
                writeStored(RESTORE_STATE_VAR_NAME, null);
            } else if (leader) {
                targetTemp = leader.targetTemperature ? toNumberOrNull(leader.targetTemperature.value) : null;
                targetMode = leader.thermostatMode ? leader.thermostatMode.value : null;
                log(`Nyeste ændring kommer fra enhed: ${leader.id}`);
            } else {
                log("Ingen leder-termostat fundet. Afbryder.");
                return;
            }
        }

        if (ROUND_TO_NEAREST_HALF && targetTemp !== null) {
            targetTemp = roundToHalf(targetTemp);
        }

        await syncDevices(thermostats, targetTemp, targetMode);

        await wait(POST_SYNC_PERIOD_MS);
    } catch (err) {
        log(`Fejl under synk: ${err && err.message ? err.message : err}`);
    } finally {
        if (iHoldWindowWait) {
            const waitState = readWindowWait()
            if (waitState && waitState.token === runToken) {
                global.set(WINDOW_WAIT_VAR_NAME, null)
            }
        }
        if (iHoldTheLock) {
            releaseLock(runToken)
            log("Lås frigivet.");
        }
    }
}

// ################
// ### SKIP SCRIPTET HVIS NYERE OPDATERINGER ER SKET
// ### (DEBOUNCE / FORSINKELSE)
// #######

const timestamp = (new Date()).toISOString();
global.set(GLOBAL_TARGET_TEMP_KEY, timestamp)

log("Debounce-vent starter")
await wait(DEBOUNCE_PERIOD_MS);
log("Debounce-vent slut")

if (isDebounceStale()) {
  log("En nyere synk kører allerede. Stopper denne kørsel.")
  log(`MIN TID: ${timestamp} | NYESTE TID: ${global.get(GLOBAL_TARGET_TEMP_KEY)}`)
} else {
  await main();
}
