#!/usr/bin/env node
/**
 * Connecteur Vertuoz
 *
 * Installé chez le client, sur le même réseau que la chaudière : il lit les journaux CSV
 * de la régulation Ökofen Pelletronic Touch (/logfiles/pelletronic) et les envoie à Vertuoz
 * par HTTPS. Seules des connexions sortantes sont utilisées : rien à ouvrir sur la box.
 *
 * Aucune dépendance : Node.js 18 ou plus récent.
 *
 * Variables d'environnement :
 *   VERTUOZ_SERVER        adresse de Vertuoz (ex. https://app.vertuoz.fr)        obligatoire
 *   BOILER_URL            adresse de la chaudière (ex. http://192.168.1.20)       obligatoire
 *   VERTUOZ_PAIRING_CODE  code d'appairage affiché par Vertuoz (premier démarrage)
 *   DATA_DIR              dossier où est conservé le jeton (défaut : ./data)
 *   INTERVAL_MINUTES      intervalle forcé entre deux envois (défaut : celui de Vertuoz)
 *   AGENT_NAME            nom affiché dans Vertuoz (défaut : nom de la machine)
 *   LOG_LEVEL             info (défaut) ou debug
 *
 * Commandes :
 *   node vertuoz-agent.mjs          appairage si nécessaire, puis envois en continu
 *   node vertuoz-agent.mjs --once   un seul cycle (test)
 *   node vertuoz-agent.mjs --reset  oublie le jeton (pour refaire l'appairage)
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const AGENT_VERSION = "1.0.0"

const LOGFILES_PATH = "/logfiles/pelletronic"
const BOILER_LISTING_TIMEOUT_MS = 10_000
const BOILER_CSV_TIMEOUT_MS = 60_000
const SERVER_TIMEOUT_MS = 60_000
const DEFAULT_INTERVAL_MINUTES = 2
const MAX_BACKOFF_MINUTES = 30

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

/** Un jour est complet côté Vertuoz quand sa mesure de 23:59 est enregistrée */
export function isComplete(progress, date) {
  const last = progress?.[date]
  return typeof last === "string" && last >= "23:59:00"
}

/** Jours à envoyer : ceux proposés par la chaudière et pas encore complets côté Vertuoz */
export function daysToSend(boilerDates, progress) {
  return boilerDates.filter((d) => !isComplete(progress, d))
}

// ---------------------------------------------------------------------------
// Configuration et état local
// ---------------------------------------------------------------------------

function readConfig() {
  const server = process.env.VERTUOZ_SERVER
  const boiler = process.env.BOILER_URL
  const missing = [!server && "VERTUOZ_SERVER", !boiler && "BOILER_URL"].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`variable(s) d'environnement manquante(s) : ${missing.join(", ")}`)
  }
  const interval = Number(process.env.INTERVAL_MINUTES)
  return {
    server: normalizeUrl(server),
    boilerUrl: normalizeUrl(boiler),
    pairingCode: process.env.VERTUOZ_PAIRING_CODE?.trim() || null,
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
  constructor(status, message) {
    super(message)
    this.status = status
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

async function serverRequest(config, method, pathname, { token, json, text } = {}) {
  const url = `${config.server}${pathname}`
  const headers = { "user-agent": `vertuoz-agent/${AGENT_VERSION}` }
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
    throw new HttpError(0, `Vertuoz injoignable (${describeFetchError(error, url, SERVER_TIMEOUT_MS)})`)
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(res.status, payload.error ?? `Vertuoz a répondu ${res.status}`)
  return payload
}

// ---------------------------------------------------------------------------
// Appairage et cycle d'envoi
// ---------------------------------------------------------------------------

async function pair(config) {
  if (!config.pairingCode) {
    throw new Error(
      "connecteur non appairé : renseignez VERTUOZ_PAIRING_CODE avec le code affiché par Vertuoz (page de la chaudière)"
    )
  }
  await checkDataDir(config)
  log("info", `Appairage avec ${config.server}…`)
  const res = await serverRequest(config, "POST", "/api/agent/v1/pair", {
    json: { code: config.pairingCode, hostname: agentName(), version: AGENT_VERSION, boilerUrl: config.boilerUrl },
  })
  const state = { server: config.server, token: res.token, installation: res.installation, pairedAt: new Date().toISOString() }
  await saveState(config, state)
  log("info", `Appairé à l'installation « ${res.installation.name} ». Le code d'appairage n'est plus nécessaire.`)
  return state
}

/** Un cycle : liste les journaux de la chaudière et envoie ceux qui manquent à Vertuoz */
export async function runCycle(config, state) {
  const startedAt = new Date().toISOString()
  const remote = await serverRequest(config, "GET", "/api/agent/v1/state", { token: state.token })

  let dates
  try {
    dates = parseListing(await boilerGet(config.boilerUrl, LOGFILES_PATH, BOILER_LISTING_TIMEOUT_MS))
  } catch (error) {
    log("warn", `Chaudière injoignable : ${error.message}`)
    await serverRequest(config, "POST", "/api/agent/v1/heartbeat", {
      token: state.token,
      json: { boilerReachable: false, error: error.message, boilerUrl: config.boilerUrl, hostname: agentName(), version: AGENT_VERSION, startedAt },
    })
    return { intervalMinutes: remote.intervalMinutes, boilerReachable: false }
  }

  const pending = daysToSend(dates, remote.progress)
  log("debug", `${dates.length} journal(aux) sur la chaudière, ${pending.length} à envoyer`)

  let filesSent = 0
  let rowsInserted = 0
  let rowsRejected = 0
  const problems = []
  for (const date of pending) {
    try {
      const csv = await boilerGet(config.boilerUrl, `${LOGFILES_PATH}/touch_${date.replace(/-/g, "")}.csv`, BOILER_CSV_TIMEOUT_MS)
      const res = await serverRequest(config, "POST", `/api/agent/v1/days/${date}`, { token: state.token, text: csv })
      filesSent++
      rowsInserted += res.inserted
      rowsRejected += res.rejected
      if (res.warnings?.length) problems.push(`${date} : ${res.warnings.join(" ; ")}`)
      log("debug", `${date} : ${res.inserted} mesure(s) ajoutée(s)`)
    } catch (error) {
      // Jeton révoqué : inutile de continuer le cycle
      if (error instanceof HttpError && error.status === 401) throw error
      problems.push(`${date} : ${error.message}`)
      log("warn", `${date} : ${error.message}`)
    }
  }

  await serverRequest(config, "POST", "/api/agent/v1/heartbeat", {
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
    },
  })
  log("info", `Cycle terminé : ${filesSent} journal(aux) envoyé(s), ${rowsInserted} nouvelle(s) mesure(s)`)
  return { intervalMinutes: remote.intervalMinutes, boilerReachable: true }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PAIRING_RETRY_MINUTES = 5

/**
 * Appairage, réessayé toutes les 5 minutes en cas d'échec plutôt que de quitter :
 * sous Docker, un redémarrage en boucle épuiserait les tentatives autorisées.
 */
async function pairWithRetry(config, once) {
  for (;;) {
    try {
      return await pair(config)
    } catch (error) {
      if (once) throw error
      log("error", `${error.message} — nouvel essai dans ${PAIRING_RETRY_MINUTES} min`)
      await sleep(PAIRING_RETRY_MINUTES * 60_000)
    }
  }
}

async function main(argv) {
  const config = readConfig()

  if (argv.includes("--reset")) {
    await rm(stateFile(config), { force: true })
    log("info", "Jeton oublié : le prochain démarrage refera l'appairage.")
    return
  }

  log("info", `Connecteur Vertuoz ${AGENT_VERSION} — chaudière ${config.boilerUrl}, serveur ${config.server}`)

  let state = await loadState(config)
  if (state && state.server !== config.server) {
    log("warn", "Le serveur a changé depuis l'appairage : nouvel appairage nécessaire.")
    state = null
  }
  const once = argv.includes("--once")
  if (!state) state = await pairWithRetry(config, once)

  let failures = 0
  for (;;) {
    let intervalMinutes = config.intervalOverride ?? DEFAULT_INTERVAL_MINUTES
    try {
      const result = await runCycle(config, state)
      intervalMinutes = config.intervalOverride ?? result.intervalMinutes ?? intervalMinutes
      failures = 0
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        // Connecteur dissocié depuis Vertuoz : le jeton est oublié, un nouveau code est attendu
        log("error", "Vertuoz ne reconnaît plus ce connecteur (dissocié ?) : renseignez un nouveau VERTUOZ_PAIRING_CODE.")
        await rm(stateFile(config), { force: true })
        if (once) {
          process.exitCode = 2
          return
        }
        state = await pairWithRetry(config, once)
        continue
      }
      failures++
      log("error", error.message)
      // Nouvel essai de plus en plus espacé quand Vertuoz est injoignable
      intervalMinutes = Math.min(MAX_BACKOFF_MINUTES, intervalMinutes * 2 ** Math.min(failures - 1, 4))
    }
    if (once) return
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
