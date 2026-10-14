import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  newLinesOnly,
  canonicalCode,
  daysToSend,
  dormantAdvice,
  isComplete,
  normalizeUrl,
  parseListing,
  shouldPair,
  boilerMismatch,
  isNewPairingCode,
  mismatchAdvice,
  enqueue,
  jsonUrl,
  maskedJsonUrl,
  readingFromJson,
} from "./granulink-agent.mjs"

describe("connecteur : normalizeUrl", () => {
  it("ajoute http:// et retire le / final", () => {
    expect(normalizeUrl("192.168.1.20")).toBe("http://192.168.1.20")
    expect(normalizeUrl("http://localhost:8181/")).toBe("http://localhost:8181")
    expect(normalizeUrl("https://app.granulink.fr")).toBe("https://app.granulink.fr")
  })

  it("conserve un chemin (Granulink derrière un sous-dossier)", () => {
    expect(normalizeUrl("https://exemple.fr/granulink/")).toBe("https://exemple.fr/granulink")
  })

  it("refuse une adresse vide ou un autre protocole", () => {
    expect(() => normalizeUrl("")).toThrow()
    expect(() => normalizeUrl("ftp://chaudiere")).toThrow()
  })
})

describe("connecteur : parseListing", () => {
  it("extrait les dates des journaux, sans doublon", () => {
    const html = '<a href="touch_20261004.csv">touch_20261004.csv</a><a href="touch_20261003.csv">x</a>'
    expect(parseListing(html)).toEqual(["2026-10-03", "2026-10-04"])
  })
})

describe("connecteur : jours à envoyer", () => {
  const progress = { "2026-10-03": "23:59:36", "2026-10-04": "17:59:36" }

  it("reconnaît un jour complet", () => {
    expect(isComplete(progress, "2026-10-03")).toBe(true)
    expect(isComplete(progress, "2026-10-04")).toBe(false)
    expect(isComplete(progress, "2026-10-05")).toBe(false)
    expect(isComplete(undefined, "2026-10-03")).toBe(false)
  })

  it("n'envoie que les jours incomplets ou absents", () => {
    expect(daysToSend(["2026-10-03", "2026-10-04", "2026-10-05"], progress)).toEqual(["2026-10-04", "2026-10-05"])
  })
})

describe("connecteur : veille après suppression ou dissociation", () => {
  it("compare les codes sans tenir compte de la casse ni du tiret", () => {
    expect(canonicalCode("ab cd-2345")).toBe("ABCD2345")
  })

  it("n'essaie pas de nouveau un code déjà consommé ou refusé", () => {
    const dormant = { reason: "deleted", consumedCode: "ABCD2345" }
    expect(shouldPair("abcd-2345", dormant)).toBe(false)
    expect(shouldPair("WXYZ-6789", dormant)).toBe(true)
    expect(shouldPair(null, dormant)).toBe(false)
    expect(shouldPair("WXYZ-6789", undefined)).toBe(true)
  })

  it("propose la désinstallation quand la chaudière n'existe plus", () => {
    expect(dormantAdvice("deleted")).toContain("docker rm -f granulink-agent")
    expect(dormantAdvice("deactivated")).toContain("désinstaller")
    expect(dormantAdvice("unpaired")).toContain("nouveau GRANULINK_PAIRING_CODE")
  })
})

describe("versions", () => {
  it("compare les versions du connecteur", async () => {
    const { compareVersions } = await import("./granulink-agent.mjs")
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0)
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("1.0.1", "v1.0.1")).toBe(0)
  })
})

describe("connecteur : seulement les nouvelles lignes (journaux écrits toutes les 2 heures)", () => {
  const header = "Datum ;Zeit ;AT [°C];"
  const csv = [header, "12.10.2026;13:58:00;8,1;", "12.10.2026;13:59:00;8,0;", "12.10.2026;14:00:00;7,9;", ""].join("\n")

  it("en-tête et mesures postérieures à la dernière connue", () => {
    expect(newLinesOnly(csv, "13:58:00")).toEqual({ body: `${header}\n12.10.2026;13:59:00;8,0;\n12.10.2026;14:00:00;7,9;\n`, count: 2 })
  })

  it("rien de nouveau : rien à envoyer", () => {
    expect(newLinesOnly(csv, "14:00:00")).toEqual({ body: "", count: 0 })
  })

  it("journal entier sans avancement, sur demande de relecture ou au passage à l'heure d'hiver", () => {
    expect(newLinesOnly(csv, undefined).count).toBe(3)
    expect(newLinesOnly(csv, "00:00:00").body).toBe(csv)
    const dst = [header, "25.10.2026;02:58:00;5;", "25.10.2026;02:59:00;5;", "25.10.2026;02:00:00;5;", "25.10.2026;02:01:00;5;"].join("\n")
    expect(newLinesOnly(dst, "02:59:00")).toEqual({ body: dst, count: 4 })
  })
})

describe("connecteur : une chaudière par jeton", () => {
  const state = { token: "t", pairingCode: "ABCD2345", boilerUrl: "http://192.168.1.20" }

  it("refait l'appairage quand un autre code est fourni", () => {
    expect(isNewPairingCode("WXYZ-6789", state)).toBe(true)
    expect(isNewPairingCode("abcd-2345", state)).toBe(false)
    expect(isNewPairingCode(null, state)).toBe(false)
    expect(isNewPairingCode("WXYZ-6789", null)).toBe(false)
  })

  it("ne réessaie pas un code refusé ni un ancien état sans code mémorisé", () => {
    expect(isNewPairingCode("WXYZ-6789", { ...state, refusedCode: "WXYZ6789" })).toBe(false)
    expect(isNewPairingCode("QRST-2345", { ...state, refusedCode: "WXYZ6789" })).toBe(true)
    expect(isNewPairingCode("WXYZ-6789", { token: "t" })).toBe(false)
  })

  it("détecte une autre chaudière que celle de l'appairage", () => {
    expect(boilerMismatch(state, "http://192.168.1.20")).toBeNull()
    expect(boilerMismatch(state, "http://192.168.1.21")).toBe("http://192.168.1.20")
    expect(boilerMismatch({ token: "t" }, "http://192.168.1.21")).toBeNull()
    expect(boilerMismatch(null, "http://192.168.1.21")).toBeNull()
  })

  it("explique comment servir une seconde chaudière", () => {
    const advice = mismatchAdvice("http://192.168.1.20", "http://192.168.1.21")
    expect(advice).toContain("DATA_DIR")
    expect(advice).toContain("nouveau code d'appairage")
  })
})

describe("connecteur : interface JSON (firmware V4)", () => {
  const v3 = JSON.parse(readFileSync(path.resolve("agent/fixtures/oekofen-v3-all.json"), "utf8"))

  it("adresse : même hôte que la chaudière, port et mot de passe de l'interface", () => {
    expect(jsonUrl("http://192.168.1.20", 4321, "aB3x")).toBe("http://192.168.1.20:4321/aB3x/all")
    expect(jsonUrl("http://localhost:8181", 4321, "12 34")).toBe("http://localhost:4321/12%2034/all")
    expect(maskedJsonUrl("http://192.168.1.20", 4321)).toBe("http://192.168.1.20:4321/***/all")
  })

  it("relevé d'une vraie chaudière (V3, à l'arrêt) : dixièmes, sonde absente, booléens", () => {
    const r = readingFromJson(v3, new Date("2026-10-14T16:11:00Z"))
    expect(r).toEqual({
      at: "2026-10-14T16:11:00.000Z",
      outdoorTempC: 18.9,
      boilerTempC: 19.7,
      boilerTempSetC: 8,
      flowTempC: 21.9,
      flowTempSetC: 8,
      roomTempC: 22,
      roomTempSetC: 8,
      flameTempC: 19.7,
      modulationPct: 0,
      boilerStatus: 99,
      heatingPumpOn: false,
      pelletCounterTodayKg: 0,
      pelletCounterYesterdayKg: 0,
    })
  })

  it("sonde extérieure de la chaudière en secours, -32768 ignoré", () => {
    const data = { ...v3, system: {}, pe1: { ...v3.pe1, L_ext_temp: "-52" } }
    expect(readingFromJson(data).outdoorTempC).toBe(-5.2)
    expect(readingFromJson({ ...v3, system: {} }).outdoorTempC).toBeNull()
  })

  it("réponse sans chaudière : erreur explicite", () => {
    expect(() => readingFromJson({ system: {} })).toThrow(/pe1/)
    expect(() => readingFromJson(null)).toThrow()
  })

  it("file d'attente bornée : les plus anciens relevés sont abandonnés", () => {
    expect(enqueue([1, 2], [3], 5)).toEqual([1, 2, 3])
    expect(enqueue([1, 2, 3, 4], [5, 6], 5)).toEqual([2, 3, 4, 5, 6])
  })
})
