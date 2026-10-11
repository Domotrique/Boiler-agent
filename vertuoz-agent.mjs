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
 *   DATA_DIR              dossier où est conservé le jeton (défaut : ./data) — un dossier par chaudière
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

export const AGENT_VERSION = "1.2.0"

const LOGFILES_PATH = "/logfiles/pelletronic"
const BOILER_LISTING_TIMEOUT_MS = 10_000
const BOILER_CSV_TIMEOUT_MS = 60_000
const SERVER_TIMEOUT_MS = 60_000
const DEFAULT_INTERVAL_MINUTES = 10
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

/**
 * Lignes à envoyer d'un journal : l'en-tête et les mesures postérieures à la dernière connue de Vertuoz
 * (`sinceTime`, HH:MM:SS). La régulation n'écrit ses journaux que toutes les 2 heures environ : la plupart des
 * cycles n'ont rien de nouveau (`count` nul) et n'envoient rien. Journal entier sans avancement connu, si
 * Vertuoz demande une relecture (00:00:00) ou si l'heure recule dans le fichier (passage à l'heure d'hiver).
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

/** Un jour est complet côté Vertuoz quand sa mesure de 23:59 est enregistrée */
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
    "Si l'adresse de la même chaudière a changé, générez un nouveau code d'appairage dans Vertuoz " +
    "et redémarrez avec VERTUOZ_PAIRING_CODE."
  )
}

/** Instructions affichées quand le connecteur n'a plus de chaudière à servir */
export function dormantAdvice(reason) {
  if (reason === "deleted" || reason === "deactivated") {
    return (
      "Ce connecteur n'a plus d'utilité : vous pouvez le désinstaller. " +
      "Docker : docker rm -f vertuoz-agent && docker volume rm vertuoz-agent-data ; " +
      "sans Docker : arrêtez le programme puis supprimez vertuoz-agent.mjs et le dossier data. " +
      "Pour le réutiliser avec une autre chaudière, renseignez un nouveau VERTUOZ_PAIRING_CODE et redémarrez-le."
    )
  }
  return "Pour le réutiliser, renseignez un nouveau VERTUOZ_PAIRING_CODE (affiché par Vertuoz) et redémarrez-le."
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
  if (!res.ok) throw new HttpError(res.status, payload.error ?? `Vertuoz a répondu ${res.status}`, payload.reason)
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
    },
  })
  log(
    "info",
    `Cycle terminé : ${filesSent} journal(aux) envoyé(s), ${rowsInserted} nouvelle(s) mesure(s)${unchanged ? `, ${unchanged} inchangé(s)` : ""}`
  )
  announceUpdate(ack?.latestVersion)
  return { intervalMinutes: remote.intervalMinutes, boilerReachable: true }
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
  log("warn", `Nouvelle version du connecteur disponible : ${AGENT_VERSION} → ${latest} (voir la page de la chaudière dans Vertuoz)`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PAIRING_RETRY_MINUTES = 5
const DORMANT_REMINDER_HOURS = 6

/** Met le connecteur en veille : plus aucune requête vers Vertuoz tant qu'un nouveau code n'est pas fourni */
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

  log("info", `Connecteur Vertuoz ${AGENT_VERSION} — chaudière ${config.boilerUrl}, serveur ${config.server}`)

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
      if (shouldPair(config.pairingCode, state?.dormant)) {
        state = await pairOrSleep(config, once)
        continue
      }
      if (!state?.dormant) {
        // Ni jeton ni code : attente plutôt qu'un arrêt (Docker relancerait le conteneur en boucle)
        const message =
          "connecteur non appairé : renseignez VERTUOZ_PAIRING_CODE avec le code affiché par Vertuoz (page de la chaudière), puis redémarrez-le"
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
      if (once) throw new Error(message)
      log("error", message)
      await sleep(DORMANT_REMINDER_HOURS * 3_600_000)
      continue
    }

    let intervalMinutes = config.intervalOverride ?? DEFAULT_INTERVAL_MINUTES
    try {
      const result = await runCycle(config, state)
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
