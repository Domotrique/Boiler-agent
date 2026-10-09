import { describe, expect, it } from "vitest"

import {
  canonicalCode,
  daysToSend,
  dormantAdvice,
  isComplete,
  normalizeUrl,
  parseListing,
  shouldPair,
} from "./vertuoz-agent.mjs"

describe("connecteur : normalizeUrl", () => {
  it("ajoute http:// et retire le / final", () => {
    expect(normalizeUrl("192.168.1.20")).toBe("http://192.168.1.20")
    expect(normalizeUrl("http://localhost:8181/")).toBe("http://localhost:8181")
    expect(normalizeUrl("https://app.vertuoz.fr")).toBe("https://app.vertuoz.fr")
  })

  it("conserve un chemin (Vertuoz derrière un sous-dossier)", () => {
    expect(normalizeUrl("https://exemple.fr/vertuoz/")).toBe("https://exemple.fr/vertuoz")
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
    expect(dormantAdvice("deleted")).toContain("docker rm -f vertuoz-agent")
    expect(dormantAdvice("deactivated")).toContain("désinstaller")
    expect(dormantAdvice("unpaired")).toContain("nouveau VERTUOZ_PAIRING_CODE")
  })
})
