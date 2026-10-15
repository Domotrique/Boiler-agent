#!/usr/bin/env node
/**
 * Connecteur Granulink
 *
 * Installé chez le client, sur le même réseau que la chaudière : il lit les journaux CSV
 * de la régulation Ökofen Pelletronic Touch (/logfiles/pelletronic) et les envoie à Granulink
 * par HTTPS. Firmware V4 (plus de journaux) : il relève chaque minute l'interface JSON de la
 * régulation (port 4321) et envoie ces relevés. Seules des connexions sortantes sont utilisées :
 * rien à ouvrir sur la box.
 *
 * Aucune dépendance : Node.js 18 ou plus récent.
 *
 * Variables d'environnement :
 *   GRANULINK_SERVER        adresse de Granulink (ex. https://app.granulink.fr)        obligatoire
 *   BOILER_URL            adresse de la chaudière (ex. http://192.168.1.20)       obligatoire
 *   GRANULINK_PAIRING_CODE  code d'appairage affiché par Granulink (premier démarrage)
 *   BOILER_JSON_PASSWORD  mot de passe de l'interface JSON (écran : Général › IPConfig) — firmware V4
 *   BOILER_JSON_PORT      port de l'interface JSON (défaut : 4321)
 *   BOILER_SOURCE         auto (défaut : journaux CSV, sinon interface JSON), csv ou json
 *   DATA_DIR              dossier où est conservé le jeton (défaut : ./data) — un dossier par chaudière
 *   INTERVAL_MINUTES      intervalle forcé entre deux envois (défaut : celui de Granulink)
 *   AGENT_NAME            nom affiché dans Granulink (défaut : nom de la machine)
 *   LOG_LEVEL             info (défaut) ou debug
 *
 * Commandes :
 *   node granulink-agent.mjs          appairage si nécessaire, puis envois en continu
 *   node granulink-agent.mjs --once   un seul cycle (test)
 *   node granulink-agent.mjs --reset  oublie le jeton (pour refaire l'appairage)
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const AGENT_VERSION = "1.3.0"

const LOGFILES_PATH = "/logfiles/pelletronic"
const BOILER_LISTING_TIMEOUT_MS = 10_000
const BOILER_CSV_TIMEOUT_MS = 60_000
const SERVER_TIMEOUT_MS = 60_000
const DEFAULT_INTERVAL_MINUTES = 10
const MAX_BACKOFF_MINUTES = 30
const DEFAULT_JSON_PORT = 4321
const BOILER_JSON_TIMEOUT_MS = 15_000
/** Interface JSON : un relevé par minute (la régulation refuse les interrogations trop rapprochées) */
const JSON_POLL_MS = 60_000
/** Relevés envoyés par requête, et conservés au plus en attente (une semaine) si Granulink est injoignable */
const READINGS_PER_REQUEST = 1440
const MAX_QUEUED_READINGS = 7 * 1440
/** Au-delà de ce délai sans relevé réussi, la chaudière est signalée injoignable */
const JSON_STALE_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Journalisation
// ---------------------------------------------------------------------------

// Sous Docker, le nom de machine est l'identifiant du conteneur : AGENT_NAME permet un nom parlant
const agentName = () => process.env.AGENT_NAME?.trim() || hostname()

const debugEnabled = (process.env.LOG_LEVEL ?? "info").toLowerCase() === "debug"

function log(level, message) {
  if (level === "debug" && !debugEnabled) return
  const line = `${new Date().toISOString()} [${level}] ${message}`
  if (level === "error" || level === "warn") console.error(line)
  else console.log(line)
}

// ---------------------------------------------------------------------------
// Fonctions pures (testées)
// ---------------------------------------------------------------------------

/** Normalise une adresse : « 192.168.1.20 » → « http://192.168.1.20 », sans chemin ni « / » final */
export function normalizeUrl(input) {
  let raw = String(input ?? "").trim()
  if (!raw) throw new Error("adresse vide")
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`protocole non pris en charge : ${url.protocol}`)
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
}

/** Dates (AAAA-MM-JJ) des fichiers touch_AAAAMMJJ.csv d'une page de listing, triées */
export function parseListing(html) {
  const dates = new Set()
  for (const m of String(html).matchAll(/touch_(\d{4})(\d{2})(\d{2})\.csv/g)) {
    dates.add(`${m[1]}-${m[2]}-${m[3]}`)
  }
  return [...dates].sort()
}

/**
 * Lignes à envoyer d'un journal : l'en-tête et les mesures postérieures à la dernière connue de Granulink
 * (`sinceTime`, HH:MM:SS). La régulation n'écrit ses journaux que toutes les 2 heures environ : la plupart des
 * cycles n'ont rien de nouveau (`count` nul) et n'envoient rien. Journal entier sans avancement connu, si
 * Granulink demande une relecture (00:00:00) ou si l'heure recule dans le fichier (passage à l'heure d'hiver).
 */
export function newLinesOnly(csv, sinceTime) {
  const lines = String(csv).split(/\r?\n/)
  const header = lines[0] ?? ""
  const data = lines.slice(1).filter((l) => l.trim() !== "")
  const time = (line) => line.split(";")[1]?.trim() ?? ""
  const rewound = data.some((l, i) => i > 0 && time(l) < time(data[i - 1]))
  if (!sinceTime || sinceTime === "00:00:00" || rewound) return { body: csv, count: data.length }
  const fresh = data.filter((l) => time(l) > sinceTime)
  return { body: fresh.length > 0 ? `${[header, ...fresh].join("\n")}\n` : "", count: fresh.length }
}

/** Un jour est complet côté Granulink quand sa mesure de 23:59 est enregistrée */
export function isComplete(progress, date) {
  const last = progress?.[date]
  return typeof last === "string" && last >= "23:59:00"
}

/** Code d'appairage comparable (majuscules, sans espace ni tiret) */
export function canonicalCode(code) {
  return String(code ?? "").toUpperCase().replace(/[\s-]/g, "")
}

/** Faut-il tenter un appairage ? Pas avec un code déjà consommé ou refusé (évite les essais sans fin) */
export function shouldPair(pairingCode, dormant) {
  if (!pairingCode) return false
  return !dormant?.consumedCode || canonicalCode(pairingCode) !== canonicalCode(dormant.consumedCode)
}

/**
 * Un code différent de celui de l'appairage en cours est une demande explicite de nouvel appairage.
 * Sans cette règle, un second connecteur lancé dans le même dossier ignorait son code et envoyait
 * les journaux de SA chaudière avec le jeton de la première (historiques mélangés).
 */
export function isNewPairingCode(pairingCode, state) {
  if (!pairingCode || !state?.token) return false
  if (state.refusedCode && canonicalCode(state.refusedCode) === canonicalCode(pairingCode)) return false
  // Ancien état sans code mémorisé : impossible de savoir si le code fourni est nouveau
  return !!state.pairingCode && canonicalCode(pairingCode) !== canonicalCode(state.pairingCode)
}

/** Chaudière pour laquelle le jeton a été délivré, si BOILER_URL en désigne une autre (sinon null) */
export function boilerMismatch(state, boilerUrl) {
  if (!state?.token || !state.boilerUrl) return null
  return state.boilerUrl === boilerUrl ? null : state.boilerUrl
}

/** Explication quand BOILER_URL ne correspond plus à la chaudière appairée */
export function mismatchAdvice(pairedUrl, boilerUrl) {
  return (
    `ce connecteur a été appairé pour la chaudière ${pairedUrl}, mais BOILER_URL vaut ${boilerUrl} : ` +
    "aucun envoi pour ne pas mélanger les historiques. " +
    "S'il s'agit d'une autre chaudière, lancez un connecteur séparé avec son propre dossier DATA_DIR " +
    "(ou son propre volume Docker) et le code d'appairage de cette chaudière. " +
    "Si l'adresse de la même chaudière a changé, générez un nouveau code d'appairage dans Granulink " +
    "et redémarrez avec GRANULINK_PAIRING_CODE."
  )
}

/** Instructions affichées quand le connecteur n'a plus de chaudière à servir */
export function dormantAdvice(reason) {
  if (reason === "deleted" || reason === "deactivated") {
    return (
      "Ce connecteur n'a plus d'utilité : vous pouvez le désinstaller. " +
      "Docker : docker rm -f granulink-agent && docker volume rm granulink-agent-data ; " +
      "sans Docker : arrêtez le programme puis supprimez granulink-agent.mjs et le dossier data. " +
      "Pour le réutiliser avec une autre chaudière, renseignez un nouveau GRANULINK_PAIRING_CODE et redémarrez-le."
    )
  }
  return "Pour le réutiliser, renseignez un nouveau GRANULINK_PAIRING_CODE (affiché par Granulink) et redémarrez-le."
}

/** Adresse de l'interface JSON : même hôte que BOILER_URL, port de l'interface, mot de passe dans le chemin */
export function jsonUrl(boilerUrl, port, password) {
  const url = new URL(boilerUrl)
  url.port = String(port)
  url.pathname = `/${encodeURIComponent(password)}/all`
  return url.toString()
}

/** La même adresse, mot de passe masqué (journaux, comptes rendus) */
export function maskedJsonUrl(boilerUrl, port) {
  return jsonUrl(boilerUrl, port, "***").replace("%2A%2A%2A", "***")
}

// Valeurs de l'interface JSON. Deux formes selon le firmware : valeur nue (« 537 », 537) ou, sur les firmwares
// récents, objet avec métadonnées ({"val": 537, "factor": 0.1, "unit": "°C"…}). La valeur brute a la même unité
// dans les deux cas (températures en dixièmes de degré) : seule `val` est lue.
// Valeurs « indisponible » de la régulation (bornes d'un entier 16 bits) : sonde absente, compteur non alimenté
const isUnavailable = (n) => (n >= 32765 && n <= 32767) || (n >= -32768 && n <= -32766)
const rawValue = (value) => (value !== null && typeof value === "object" ? value.val : value)
function jsonNumber(value) {
  const v = rawValue(value)
  if (v === undefined || v === null || v === "" || typeof v === "boolean") return null
  const n = Number(v)
  return Number.isFinite(n) && !isUnavailable(n) ? n : null
}
const tenths = (value) => {
  const n = jsonNumber(value)
  return n === null ? null : Math.round(n) / 10
}
function jsonBool(value) {
  const v = rawValue(value)
  if (v === true || v === "true" || v === 1 || v === "1") return true
  if (v === false || v === "false" || v === 0 || v === "0") return false
  return null
}

/** Codes d'état de la chaudière (colonne PE1 Status des journaux CSV) */
const STATE_STANDBY = 99
const MAX_STATE_CODE = 13
/**
 * État de la chaudière d'après pe1.L_state. Selon le firmware, c'est soit le code de la colonne PE1 Status
 * (4 = combustion, 99 = veille), soit un champ de bits : bit n levé pour l'état n (16 = combustion, 32 = fin de
 * combustion), bit 31 pour l'arrêt, bit 28 pour une information (« température chaudière supérieure à la
 * température de redémarrage »). Une valeur hors des codes connus révèle le champ de bits : `memory.bitfield`
 * le retient pour les relevés suivants (sinon, 4 ou 8 seraient ambigus). pe1.L_state_enum, quand il est publié,
 * donne directement le code.
 */
export function boilerState(pe, memory = {}) {
  const code = jsonNumber(pe.L_state_enum)
  if (code !== null) return Math.round(code)
  const v = rawValue(pe.L_state)
  const n = v === undefined || v === null || v === "" ? NaN : Number(v)
  if (!Number.isInteger(n) || n < 0) return null
  if (!memory.bitfield && (n <= MAX_STATE_CODE || (n >= 97 && n <= 101))) return n
  memory.bitfield = true
  for (let bit = 0; bit <= MAX_STATE_CODE; bit++) {
    if (Math.floor(n / 2 ** bit) % 2 === 1) return bit
  }
  return STATE_STANDBY
}

/** Le texte brut de /all en JSON, malgré les défauts connus des firmwares */
export function parseBoilerJson(text) {
  return JSON.parse(
    text
      // Firmware 4.02 : guillemet fermant manquant après L_statetext
      .replace(/"L_statetext:/g, '"L_statetext":')
      // Caractères de contrôle non échappés dans les textes (retours à la ligne, tabulations)
      .replace(/[\u0000-\u001f]/g, " ")
  )
}

/** Texte de la réponse : UTF-8 sur les firmwares récents, Windows-1252 sur les anciens */
export function decodeBoilerText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1252").decode(bytes)
  }
}

/**
 * Relevé d'une minute à partir de la réponse de /all (firmware V3 ou V4), au format attendu par Granulink.
 * Les compteurs de granulés (storage_fill_today/yesterday, ou L_pellets_today/yesterday selon le firmware) ne
 * sont alimentés que sur les chaudières récentes. `memory` garde d'un relevé à l'autre la forme de l'état.
 */
export function readingFromJson(data, at = new Date(), memory = {}) {
  const system = data?.system ?? {}
  const pe = data?.pe1 ?? {}
  const hk = data?.hk1 ?? {}
  if (!data || typeof data !== "object" || Object.keys(pe).length === 0) {
    // Régulation Ökofen sans chaudière à granulés (pompe à chaleur, solaire seul) : rien à suivre
    throw new Error(
      data?.wp1
        ? "l'interface JSON décrit une pompe à chaleur Ökofen, sans chaudière à granulés (pe1) : non prise en charge"
        : "réponse de l'interface JSON sans section pe1 : est-ce bien une chaudière Ökofen ?"
    )
  }
  // pe1.L_ext_temp est la température des fumées, pas la température extérieure
  return {
    at: new Date(at).toISOString(),
    outdoorTempC: tenths(system.L_ambient),
    boilerTempC: tenths(pe.L_temp_act),
    boilerTempSetC: tenths(pe.L_temp_set),
    flowTempC: tenths(hk.L_flowtemp_act),
    flowTempSetC: tenths(hk.L_flowtemp_set),
    roomTempC: tenths(hk.L_roomtemp_act),
    roomTempSetC: tenths(hk.L_roomtemp_set),
    flameTempC: tenths(pe.L_frt_temp_act),
    modulationPct: jsonNumber(pe.L_modulation),
    boilerStatus: boilerState(pe, memory),
    heatingPumpOn: jsonBool(hk.L_pump),
    pelletCounterTodayKg: jsonNumber(pe.storage_fill_today ?? pe.L_pellets_today ?? pe.L_storage_fill_today),
    pelletCounterYesterdayKg: jsonNumber(
      pe.storage_fill_yesterday ?? pe.L_pellets_yesterday ?? pe.L_storage_fill_yesterday
    ),
  }
}

// ---------------------------------------------------------------------------
// Données détaillées de la régulation : compteurs, cendrier, entretien, réglages. Une partie n'est publiée
// qu'avec un fichier json.properties sur une clé USB laissée dans la Pelletronic Touch (une centaine de valeurs
// en plus, clés « L_ » en lecture seule). Facteur : celui des métadonnées (/all?), sinon celui relevé sur une
// Touch V4.02b (/all ne donne que la valeur brute).
// ---------------------------------------------------------------------------

const MS_TO_MIN = 1 / 60_000
/** [nom envoyé à Granulink, section, clé de la régulation, facteur par défaut, type] */
const DETAIL_FIELDS = [
  ["boilerPowerKw", "pe1", "L_cfg_power", 1],
  ["burnerStarts", "pe1", "L_starts", 1],
  ["burnerHours", "pe1", "L_runtime", 1],
  ["avgRuntimeMin", "pe1", "L_avg_runtime", 1],
  ["screwOn", "pe1", "L_runtimeburner", 1],
  ["screwPause", "pe1", "L_resttimeburner", 1],
  ["flueGasC", "pe1", "L_ext_temp", 0.1],
  ["storageFillKg", "pe1", "L_storage_fill", 1],
  ["storageMinKg", "pe1", "L_storage_min", 1],
  ["storageMaxKg", "pe1", "L_storage_max", 1],
  ["hopperKg", "pe1", ["L_storage_popper", "L_storage_hopper"], 1],
  ["ashMeasurement", "pe1", "L_cfg_ash_measurement", 1, "bool"],
  ["ashKg", "pe1", "L_ash_amount", 0.1],
  ["ashLimitKg", "pe1", "L_cfg_ash_limit", 0.1],
  ["ashWarnLeftH", "pe1", "L_ash_warn_left", 1],
  ["ashWarnIntervalH", "pe1", "L_ash_warn_interval", 1],
  ["maintLeftHours", "pe1", "L_maint_left_hours", 1],
  ["maintLeftDays", "pe1", "L_maint_left_days", 1],
  ["boilerHeatingLimitC", "pe1", "L_cfg_heating_limit", 0.1],
  ["burnerOnHystK", "pe1", "L_cfg_on_hyst", 0.1],
  ["burnerOffHystK", "pe1", "L_cfg_off_hyst", 0.1],
  ["minRuntimeMin", "pe1", "L_cfg_min_runtime", MS_TO_MIN],
  ["minStandstillMin", "pe1", "L_cfg_min_standstill", MS_TO_MIN],
  ["curveSlope", "hk1", "L_cfg_curve_slope", 0.1],
  ["curveBasepointC", "hk1", "L_cfg_curve_basepoint", 0.1],
  ["heatLimitC", "hk1", "L_cfg_limit_heat", 0.1],
  ["setbackLimitC", "hk1", "L_cfg_limit_setback", 0.1],
  ["flowMinC", "hk1", "L_cfg_flow_min", 0.1],
  ["flowMaxC", "hk1", "L_cfg_flow_max", 0.1],
  ["ambientAvgC", "system", "L_ambient_avg", 0.1],
  ["usbStick", "system", "L_usb_stick", 1, "bool"],
]

const roundDetail = (n) => Math.round(n * 100) / 100

/**
 * Valeurs détaillées publiées par la régulation, converties (kg, °C, h, min). Seules les valeurs présentes sont
 * renvoyées ; null si aucune ne l'est. `screwRatioPct` : part du temps de vis dans le cycle vis + pause en cours.
 */
export function boilerDetails(data) {
  const details = {}
  for (const [name, section, keys, defaultFactor, type] of DETAIL_FIELDS) {
    const field = [keys].flat().map((k) => data?.[section]?.[k]).find((v) => v !== undefined)
    if (field === undefined) continue
    if (type === "bool") {
      const b = jsonBool(field)
      if (b !== null) details[name] = b
      continue
    }
    const n = jsonNumber(field)
    if (n === null) continue
    const factor = field !== null && typeof field === "object" && Number.isFinite(Number(field.factor)) ? Number(field.factor) : defaultFactor
    details[name] = roundDetail(n * factor)
  }
  if (details.screwOn !== undefined && details.screwPause !== undefined) {
    const cycle = details.screwOn + details.screwPause
    details.screwRatioPct = cycle > 0 ? roundDetail((100 * details.screwOn) / cycle) : 0
  }
  delete details.screwOn
  delete details.screwPause
  return Object.keys(details).length > 0 ? details : null
}

/** Ajoute des relevés à la file d'attente, sans dépasser sa capacité (les plus anciens sont abandonnés) */
export function enqueue(queue, readings, max = MAX_QUEUED_READINGS) {
  const next = [...queue, ...readings]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Jours à envoyer : ceux proposés par la chaudière et pas encore complets côté Granulink */
export function daysToSend(boilerDates, progress) {
  return boilerDates.filter((d) => !isComplete(progress, d))
}

// ---------------------------------------------------------------------------
// Configuration et état local
// ---------------------------------------------------------------------------

function readConfig() {
  // Anciens noms (VERTUOZ_*) acceptés : connecteurs installés avant le changement de nom
  const server = process.env.GRANULINK_SERVER ?? process.env.VERTUOZ_SERVER
  const boiler = process.env.BOILER_URL
  const missing = [!server && "GRANULINK_SERVER", !boiler && "BOILER_URL"].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`variable(s) d'environnement manquante(s) : ${missing.join(", ")}`)
  }
  const interval = Number(process.env.INTERVAL_MINUTES)
  const jsonPort = Number(process.env.BOILER_JSON_PORT || DEFAULT_JSON_PORT)
  const source = (process.env.BOILER_SOURCE ?? "auto").trim().toLowerCase() || "auto"
  if (!["auto", "csv", "json"].includes(source)) throw new Error("BOILER_SOURCE : auto, csv ou json attendu")
  const jsonPassword = process.env.BOILER_JSON_PASSWORD?.trim() || null
  if (source === "json" && !jsonPassword) throw new Error("BOILER_SOURCE=json : renseignez BOILER_JSON_PASSWORD")
  return {
    server: normalizeUrl(server),
    boilerUrl: normalizeUrl(boiler),
    source,
    jsonPassword,
    jsonPort: Number.isInteger(jsonPort) && jsonPort > 0 && jsonPort < 65536 ? jsonPort : DEFAULT_JSON_PORT,
    pairingCode: (process.env.GRANULINK_PAIRING_CODE ?? process.env.VERTUOZ_PAIRING_CODE)?.trim() || null,
    dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
    intervalOverride: Number.isFinite(interval) && interval >= 1 ? interval : null,
  }
}

function stateFile(config) {
  return path.join(config.dataDir, "agent.json")
}

async function loadState(config) {
  try {
    return JSON.parse(await readFile(stateFile(config), "utf8"))
  } catch {
    return null
  }
}

/** Vérifie que le jeton pourra être enregistré, avant de consommer le code d'appairage */
async function checkDataDir(config) {
  const probe = path.join(config.dataDir, ".ecriture")
  try {
    await mkdir(config.dataDir, { recursive: true })
    await writeFile(probe, "ok")
    await rm(probe, { force: true })
  } catch (error) {
    throw new Error(`impossible d'écrire dans ${config.dataDir} (${error.code ?? error.message}) : vérifiez DATA_DIR et les droits du dossier`)
  }
}

async function saveState(config, state) {
  await mkdir(config.dataDir, { recursive: true })
  await writeFile(stateFile(config), JSON.stringify(state, null, 2), { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, reason) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

function describeFetchError(error, url, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return `${url} : pas de réponse après ${timeoutMs / 1000} s`
  }
  return `${url} : ${error?.cause?.message ?? error?.message ?? error}`
}

async function boilerGet(boilerUrl, pathname, timeoutMs) {
  const url = `${boilerUrl}${pathname}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(describeFetchError(error, url, timeoutMs))
  }
  if (!res.ok) throw new Error(`${url} : la chaudière a répondu ${res.status}`)
  // Journaux en ISO-8859-1 : décodage avant envoi en UTF-8
  return new TextDecoder("latin1").decode(await res.arrayBuffer())
}

/** Réponse de l'interface JSON (texte en Windows-1252) */
async function boilerJson(config) {
  const url = jsonUrl(config.boilerUrl, config.jsonPort, config.jsonPassword)
  const shown = maskedJsonUrl(config.boilerUrl, config.jsonPort)
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(BOILER_JSON_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(describeFetchError(error, shown, BOILER_JSON_TIMEOUT_MS))
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${shown} : mot de passe JSON refusé (BOILER_JSON_PASSWORD)`)
  if (!res.ok) throw new Error(`${shown} : la chaudière a répondu ${res.status}`)
  const text = decodeBoilerText(new Uint8Array(await res.arrayBuffer()))
  try {
    return parseBoilerJson(text)
  } catch {
    // Firmware V3.10c/d en allemand : les umlauts cassent le JSON (régler l'écran en anglais)
    throw new Error(`${shown} : réponse illisible (JSON invalide) ; si la régulation est en allemand, passez-la en anglais`)
  }
}

async function serverRequest(config, method, pathname, { token, json, text } = {}) {
  const url = `${config.server}${pathname}`
  const headers = { "user-agent": `granulink-agent/${AGENT_VERSION}` }
  if (token) headers.authorization = `Bearer ${token}`
  let body
  if (json !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(json)
  } else if (text !== undefined) {
    headers["content-type"] = "text/csv; charset=utf-8"
    body = text
  }
  let res
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) })
  } catch (error) {
    throw new HttpError(0, `Granulink injoignable (${describeFetchError(error, url, SERVER_TIMEOUT_MS)})`)
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(res.status, payload.error ?? `Granulink a répondu ${res.status}`, payload.reason)
  return payload
}

// ---------------------------------------------------------------------------
// Appairage et cycle d'envoi
// ---------------------------------------------------------------------------

async function pair(config) {
  if (!config.pairingCode) {
    throw new Error(
      "connecteur non appairé : renseignez GRANULINK_PAIRING_CODE avec le code affiché par Granulink (page de la chaudière)"
    )
  }
  await checkDataDir(config)
  log("info", `Appairage avec ${config.server}…`)
  const res = await serverRequest(config, "POST", "/api/agent/v1/pair", {
    json: { code: config.pairingCode, hostname: agentName(), version: AGENT_VERSION, boilerUrl: config.boilerUrl },
  })
  const state = {
    server: config.server,
    token: res.token,
    installation: res.installation,
    pairedAt: new Date().toISOString(),
    pairingCode: canonicalCode(config.pairingCode),
    boilerUrl: config.boilerUrl,
  }
  await saveState(config, state)
  log("info", `Appairé à l'installation « ${res.installation.name} ». Le code d'appairage n'est plus nécessaire.`)
  return state
}

/** Un cycle : liste les journaux de la chaudière et envoie ceux qui manquent à Granulink */
export async function runCycle(config, state) {
  const startedAt = new Date().toISOString()
  const remote = await serverRequest(config, "GET", "/api/agent/v1/state", { token: state.token })

  let dates
  try {
    dates = parseListing(await boilerGet(config.boilerUrl, LOGFILES_PATH, BOILER_LISTING_TIMEOUT_MS))
  } catch (error) {
    // Pas de journaux : firmware V4, dont seule reste l'interface JSON
    if (config.source === "auto" && config.jsonPassword) {
      try {
        await boilerJson(config)
        log("info", "Journaux CSV indisponibles, interface JSON joignable : relevé minute par minute (firmware V4).")
        return { intervalMinutes: remote.intervalMinutes, switchToJson: true }
      } catch (jsonError) {
        error.message = `${error.message} ; interface JSON : ${jsonError.message}`
      }
    }
    log("warn", `Chaudière injoignable : ${error.message}`)
    await serverRequest(config, "POST", "/api/agent/v1/heartbeat", {
      token: state.token,
      json: { boilerReachable: false, error: error.message, boilerUrl: config.boilerUrl, hostname: agentName(), version: AGENT_VERSION, startedAt, source: "csv" },
    })
    return { intervalMinutes: remote.intervalMinutes, boilerReachable: false }
  }

  const pending = daysToSend(dates, remote.progress)
  log("debug", `${dates.length} journal(aux) sur la chaudière, ${pending.length} à envoyer`)

  let filesSent = 0
  let unchanged = 0
  let rowsInserted = 0
  let rowsRejected = 0
  const problems = []
  for (const date of pending) {
    try {
      const csv = await boilerGet(config.boilerUrl, `${LOGFILES_PATH}/touch_${date.replace(/-/g, "")}.csv`, BOILER_CSV_TIMEOUT_MS)
      const { body, count } = newLinesOnly(csv, remote.progress?.[date])
      // Journal inchangé depuis le dernier envoi : rien à transmettre (le compte rendu sert de signe de vie)
      if (count === 0) {
        unchanged++
        continue
      }
      const res = await serverRequest(config, "POST", `/api/agent/v1/days/${date}`, { token: state.token, text: body })
      filesSent++
      rowsInserted += res.inserted
      rowsRejected += res.rejected
      if (res.warnings?.length) problems.push(`${date} : ${res.warnings.join(" ; ")}`)
      log("debug", `${date} : ${res.inserted} mesure(s) ajoutée(s)`)
    } catch (error) {
      // Jeton inconnu ou révoqué : inutile de continuer le cycle
      if (error instanceof HttpError && (error.status === 401 || error.status === 410)) throw error
      problems.push(`${date} : ${error.message}`)
      log("warn", `${date} : ${error.message}`)
    }
  }

  // Firmware V3 avec l'interface JSON activée : données détaillées en plus des journaux
  let details
  if (config.jsonPassword) {
    try {
      details = boilerDetails(await boilerJson(config)) ?? undefined
    } catch (error) {
      log("debug", `Interface JSON : ${error.message}`)
    }
  }

  const ack = await serverRequest(config, "POST", "/api/agent/v1/heartbeat", {
    token: state.token,
    json: {
      boilerReachable: true,
      message: problems.length ? problems.join("\n") : undefined,
      boilerUrl: config.boilerUrl,
      hostname: agentName(),
      version: AGENT_VERSION,
      filesSent,
      rowsInserted,
      rowsRejected,
      startedAt,
      source: "csv",
      details,
    },
  })
  log(
    "info",
    `Cycle terminé : ${filesSent} journal(aux) envoyé(s), ${rowsInserted} nouvelle(s) mesure(s)${unchanged ? `, ${unchanged} inchangé(s)` : ""}`
  )
  announceUpdate(ack?.latestVersion)
  return { intervalMinutes: remote.intervalMinutes, boilerReachable: true }
}

// ---------------------------------------------------------------------------
// Interface JSON (firmware V4) : relevé minute par minute, file d'attente sur disque, envoi à chaque cycle
// ---------------------------------------------------------------------------

const jsonPolling = { queue: null, timer: null, lastOkAt: 0, lastError: null, busy: false, stateMemory: {}, details: null }

function queueFile(config) {
  return path.join(config.dataDir, "readings-queue.json")
}

async function loadQueue(config) {
  try {
    const queue = JSON.parse(await readFile(queueFile(config), "utf8"))
    return Array.isArray(queue) ? queue : []
  } catch {
    return []
  }
}

/** File d'attente enregistrée à chaque relevé : un redémarrage ou une coupure de Granulink ne perd rien */
async function saveQueue(config, queue) {
  await mkdir(config.dataDir, { recursive: true })
  const file = queueFile(config)
  await writeFile(`${file}.tmp`, JSON.stringify(queue), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

async function pollJson(config) {
  if (jsonPolling.busy) return
  jsonPolling.busy = true
  try {
    const data = await boilerJson(config)
    const reading = readingFromJson(data, new Date(), jsonPolling.stateMemory)
    jsonPolling.details = boilerDetails(data)
    jsonPolling.queue = enqueue(jsonPolling.queue ?? [], [reading])
    jsonPolling.lastOkAt = Date.now()
    jsonPolling.lastError = null
    await saveQueue(config, jsonPolling.queue)
    log("debug", `Relevé JSON : état ${reading.boilerStatus}, ${reading.boilerTempC} °C, ${jsonPolling.queue.length} en attente`)
  } catch (error) {
    jsonPolling.lastError = error.message
    log("warn", `Interface JSON : ${error.message}`)
  } finally {
    jsonPolling.busy = false
  }
}

async function startJsonPolling(config) {
  if (jsonPolling.timer) return
  jsonPolling.queue ??= await loadQueue(config)
  await pollJson(config)
  jsonPolling.timer = setInterval(() => void pollJson(config), JSON_POLL_MS)
}

function stopJsonPolling() {
  if (jsonPolling.timer) clearInterval(jsonPolling.timer)
  jsonPolling.timer = null
}

/** Un cycle en mode JSON : envoie les relevés en attente, puis le compte rendu */
export async function runJsonCycle(config, state) {
  const startedAt = new Date().toISOString()
  const remote = await serverRequest(config, "GET", "/api/agent/v1/state", { token: state.token })
  let rowsInserted = 0
  let rowsRejected = 0
  let batches = 0
  const problems = []
  while ((jsonPolling.queue ?? []).length > 0) {
    const batch = jsonPolling.queue.slice(0, READINGS_PER_REQUEST)
    const res = await serverRequest(config, "POST", "/api/agent/v1/readings", { token: state.token, json: { readings: batch } })
    // Les relevés pris pendant l'envoi s'ajoutent en fin de file : seuls ceux envoyés sont retirés
    jsonPolling.queue = jsonPolling.queue.slice(batch.length)
    await saveQueue(config, jsonPolling.queue)
    batches++
    rowsInserted += res.inserted
    rowsRejected += res.rejected
    if (res.warnings?.length) problems.push(...res.warnings)
  }
  const reachable = Date.now() - jsonPolling.lastOkAt < JSON_STALE_MS
  const ack = await serverRequest(config, "POST", "/api/agent/v1/heartbeat", {
    token: state.token,
    json: {
      boilerReachable: reachable,
      error: reachable ? undefined : (jsonPolling.lastError ?? "aucun relevé récent de l'interface JSON"),
      message: problems.length ? problems.join("\n") : undefined,
      boilerUrl: config.boilerUrl,
      hostname: agentName(),
      version: AGENT_VERSION,
      filesSent: batches,
      rowsInserted,
      rowsRejected,
      startedAt,
      source: "json",
      details: reachable ? (jsonPolling.details ?? undefined) : undefined,
    },
  })
  log("info", `Cycle terminé (interface JSON) : ${rowsInserted} nouvelle(s) mesure(s)${reachable ? "" : " — chaudière injoignable"}`)
  announceUpdate(ack?.latestVersion)
  return { intervalMinutes: remote.intervalMinutes, boilerReachable: reachable }
}

/** Comparaison de versions X.Y.Z : négatif si a < b */
export function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

let announcedVersion = null
/** Signale une seule fois par version qu'une mise à jour du connecteur est disponible */
function announceUpdate(latest) {
  if (typeof latest !== "string" || latest === announcedVersion || compareVersions(AGENT_VERSION, latest) >= 0) return
  announcedVersion = latest
  log("warn", `Nouvelle version du connecteur disponible : ${AGENT_VERSION} → ${latest} (voir la page de la chaudière dans Granulink)`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PAIRING_RETRY_MINUTES = 5
const DORMANT_REMINDER_HOURS = 6

/** Met le connecteur en veille : plus aucune requête vers Granulink tant qu'un nouveau code n'est pas fourni */
async function goDormant(config, reason, message, consumedCode) {
  const dormant = { reason, message, consumedCode: consumedCode ?? null, since: new Date().toISOString() }
  await saveState(config, { server: config.server, dormant })
  return { server: config.server, dormant }
}

/**
 * Appairage. Un code refusé (inconnu, déjà utilisé, expiré) n'est pas réessayé : le connecteur se met en
 * veille. Seules les erreurs réseau sont réessayées, toutes les 5 minutes (sous Docker, quitter
 * provoquerait des redémarrages en boucle).
 */
async function pairOrSleep(config, once, previous) {
  for (;;) {
    try {
      return await pair(config)
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        if (previous?.token) {
          // Code refusé alors qu'un appairage existe : on le conserve, sans réessayer ce code
          log("error", `${error.message} — l'appairage actuel est conservé.`)
          const kept = { ...previous, refusedCode: canonicalCode(config.pairingCode) }
          await saveState(config, kept)
          return kept
        }
        return goDormant(config, "pairing-refused", error.message, config.pairingCode)
      }
      if (once) throw error
      log("error", `${error.message} — nouvel essai dans ${PAIRING_RETRY_MINUTES} min`)
      await sleep(PAIRING_RETRY_MINUTES * 60_000)
    }
  }
}

async function main(argv) {
  const config = readConfig()
  const once = argv.includes("--once")

  if (argv.includes("--reset")) {
    await rm(stateFile(config), { force: true })
    log("info", "Jeton oublié : le prochain démarrage refera l'appairage.")
    return
  }

  log(
    "info",
    `Connecteur Granulink ${AGENT_VERSION} — chaudière ${config.boilerUrl}, serveur ${config.server}` +
      (config.source === "csv" ? ", journaux CSV" : config.jsonPassword ? `, interface JSON ${maskedJsonUrl(config.boilerUrl, config.jsonPort)}` : "")
  )
  // Journaux CSV (firmware V2/V3) ou interface JSON (V4) ; en mode auto, bascule si les journaux manquent
  let mode = config.source === "json" ? "json" : "csv"

  let state = await loadState(config)
  if (state && state.server !== config.server) {
    log("warn", "Le serveur a changé depuis l'appairage : nouvel appairage nécessaire.")
    state = null
  }
  if (state?.token && !state.boilerUrl) {
    // État enregistré par une version antérieure : la chaudière actuelle devient celle du jeton
    state = { ...state, boilerUrl: config.boilerUrl }
    await saveState(config, state)
  }
  if (isNewPairingCode(config.pairingCode, state)) {
    // Nouveau code : nouvel appairage. S'il est refusé, le jeton actuel reste valable
    log("info", "Nouveau code d'appairage fourni : remplacement de l'appairage actuel.")
    const previous = state
    state = await pairOrSleep(config, once, previous)
  }

  let failures = 0
  for (;;) {
    // Pas de jeton : appairage si un nouveau code est fourni, sinon veille
    if (!state?.token) {
      stopJsonPolling()
      if (shouldPair(config.pairingCode, state?.dormant)) {
        state = await pairOrSleep(config, once)
        continue
      }
      if (!state?.dormant) {
        // Ni jeton ni code : attente plutôt qu'un arrêt (Docker relancerait le conteneur en boucle)
        const message =
          "connecteur non appairé : renseignez GRANULINK_PAIRING_CODE avec le code affiché par Granulink (page de la chaudière), puis redémarrez-le"
        if (once) throw new Error(message)
        log("error", message)
      } else {
        log("warn", `En veille : ${state.dormant.message}. ${dormantAdvice(state.dormant.reason)}`)
      }
      if (once) return
      await sleep(DORMANT_REMINDER_HOURS * 3_600_000)
      continue
    }

    // Jeton délivré pour une autre chaudière : rien n'est envoyé (historiques mélangés sinon)
    const pairedUrl = boilerMismatch(state, config.boilerUrl)
    if (pairedUrl) {
      const message = mismatchAdvice(pairedUrl, config.boilerUrl)
      stopJsonPolling()
      if (once) throw new Error(message)
      log("error", message)
      await sleep(DORMANT_REMINDER_HOURS * 3_600_000)
      continue
    }

    let intervalMinutes = config.intervalOverride ?? DEFAULT_INTERVAL_MINUTES
    try {
      let result
      if (mode === "json") {
        await startJsonPolling(config)
        result = await runJsonCycle(config, state)
      } else {
        result = await runCycle(config, state)
        if (result.switchToJson) {
          mode = "json"
          await startJsonPolling(config)
          result = await runJsonCycle(config, state)
        }
      }
      intervalMinutes = config.intervalOverride ?? result.intervalMinutes ?? intervalMinutes
      failures = 0
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 410)) {
        // Chaudière supprimée ou désactivée, ou connecteur dissocié : le jeton ne sert plus
        state = await goDormant(config, error.reason ?? "unpaired", error.message, state.pairingCode)
        if (once) {
          process.exitCode = 2
          return
        }
        continue
      }
      failures++
      log("error", error.message)
      // Nouvel essai de plus en plus espacé quand Granulink est injoignable
      intervalMinutes = Math.min(MAX_BACKOFF_MINUTES, intervalMinutes * 2 ** Math.min(failures - 1, 4))
    }
    if (once) {
      stopJsonPolling()
      return
    }
    await sleep(intervalMinutes * 60_000)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log("info", "Arrêt du connecteur.")
      process.exit(0)
    })
  }
  main(process.argv.slice(2)).catch((error) => {
    log("error", error.message)
    process.exit(1)
  })
}
