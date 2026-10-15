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
  boilerState,
  parseBoilerJson,
  decodeBoilerText,
  boilerDetails,
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

  it("température des fumées (pe1.L_ext_temp) jamais prise pour la température extérieure", () => {
    const data = { ...v3, system: {}, pe1: { ...v3.pe1, L_ext_temp: "1520" } }
    expect(readingFromJson(data).outdoorTempC).toBeNull()
  })

  // Forme des firmwares récents (/all? sur V4.02b et V4.04b) : valeurs avec métadonnées, état en champ de bits,
  // compteurs renommés ou non alimentés (32765)
  const meta = (val, extra = {}) => ({ val, factor: 0.1, unit: "°C", min: -32768, max: 32767, ...extra })
  const v4 = (pe1) => ({
    system: { system_info: "system global variables", L_ambient: meta(238), L_usb_stick: { val: 0, format: "0:Arrêt|1:Marche" } },
    hk1: { L_flowtemp_act: meta(269), L_flowtemp_set: meta(280), L_roomtemp_act: meta(0), L_roomtemp_set: meta(80), L_pump: { val: 1, format: "0:Arrêt|1:Marche" } },
    pe1: {
      pe_info: "pellematic data",
      L_temp_act: meta(612),
      L_temp_set: meta(680),
      L_ext_temp: meta(-32768),
      L_frt_temp_act: meta(5480),
      L_modulation: { val: 72, unit: "%", factor: 1, min: -32768, max: 32767 },
      L_state: { val: 16, factor: 1 },
      L_statetext: "Combustion",
      ...pe1,
    },
    error: {},
  })

  it("firmware récent : métadonnées, état en champ de bits, compteurs L_pellets_*", () => {
    const r = readingFromJson(v4({ L_pellets_today: { val: 6, unit: "kg", factor: 1 }, L_pellets_yesterday: { val: 8, unit: "kg", factor: 1 } }))
    expect(r).toMatchObject({
      outdoorTempC: 23.8,
      boilerTempC: 61.2,
      boilerTempSetC: 68,
      flowTempC: 26.9,
      roomTempC: 0,
      flameTempC: 548,
      modulationPct: 72,
      boilerStatus: 4,
      heatingPumpOn: true,
      pelletCounterTodayKg: 6,
      pelletCounterYesterdayKg: 8,
    })
  })

  it("compteurs non alimentés (32765) et sondes absentes : null", () => {
    const r = readingFromJson(v4({ L_pellets_today: { val: 32765 }, L_pellets_yesterday: { val: "32765" } }))
    expect(r.pelletCounterTodayKg).toBeNull()
    expect(r.pelletCounterYesterdayKg).toBeNull()
    expect(readingFromJson(v4({ L_temp_act: meta(32767) })).boilerTempC).toBeNull()
  })

  it("état : code ou champ de bits, mémorisé d'un relevé à l'autre", () => {
    expect(boilerState({ L_state: "99" })).toBe(99)
    expect(boilerState({ L_state: "4" })).toBe(4)
    expect(boilerState({ L_state: 16 })).toBe(4)
    expect(boilerState({ L_state: 32 })).toBe(5)
    // Combustion + « température chaudière supérieure à la température de redémarrage » (bit 28)
    expect(boilerState({ L_state: 268435472 })).toBe(4)
    // Arrêt (bit 31), avec ou sans le bit 28
    expect(boilerState({ L_state: { val: 2147483648 } })).toBe(99)
    expect(boilerState({ L_state: 2415919104 })).toBe(99)
    // Une fois le champ de bits reconnu, 4 est l'allumage (bit 2), pas la combustion
    const memory = {}
    expect(boilerState({ L_state: 2147483648 }, memory)).toBe(99)
    expect(boilerState({ L_state: 4 }, memory)).toBe(2)
    expect(boilerState({ L_state: 16 }, memory)).toBe(4)
    // Le code publié par json.properties l'emporte
    expect(boilerState({ L_state: 2147483648, L_state_enum: { val: 99, format: "0:Dauerlauf|…" } })).toBe(99)
    expect(boilerState({})).toBeNull()
  })

  it("JSON abîmé par le firmware : guillemet manquant, caractères de contrôle", () => {
    const text = '{"pe1":{"L_state":"99","L_statetext:"Arrêt\tlong\ntexte","L_temp_act":"200"}}'
    const data = parseBoilerJson(text)
    expect(data.pe1.L_statetext).toBe("Arrêt long texte")
    expect(readingFromJson(data).boilerTempC).toBe(20)
  })

  it("jeu de caractères : UTF-8 si valide, sinon Windows-1252", () => {
    expect(decodeBoilerText(new TextEncoder().encode('"Arrêt"'))).toBe('"Arrêt"')
    expect(decodeBoilerText(Uint8Array.from([0x22, 0x41, 0x72, 0x72, 0xea, 0x74, 0x22]))).toBe('"Arrêt"')
  })

  it("réponse sans chaudière : erreur explicite", () => {
    expect(() => readingFromJson({ system: {} })).toThrow(/pe1/)
    expect(() => readingFromJson(null)).toThrow()
    expect(() => readingFromJson({ system: {}, wp1: { L_state: "0" } })).toThrow(/pompe à chaleur/)
  })

  it("données détaillées (json.properties, Touch V4.02b) : facteurs des métadonnées", () => {
    const m = (val, factor, unit) => ({ val, factor, ...(unit ? { unit } : {}), min: -32768, max: 32767 })
    const data = {
      system: { L_usb_stick: { val: 1, format: "0:Aus|1:Ein" }, L_ambient_avg: m(139, 0.1, "°C") },
      hk1: { L_cfg_curve_slope: m(10, 0.1), L_cfg_curve_basepoint: m(310, 0.1, "°C"), L_cfg_limit_heat: m(180, 0.1, "°C") },
      pe1: {
        L_cfg_power: { val: 16, factor: 1, min: 8, max: 56 },
        L_starts: { val: 9625, factor: 1 },
        L_runtime: { val: 9681, unit: "h", factor: 1 },
        L_runtimeburner: { val: 2783, unit: "zs", factor: 0.01 },
        L_resttimeburner: { val: 8000, unit: "zs", factor: 0.01 },
        L_ext_temp: m(-32768, 0.1, "°C"),
        L_storage_fill: { val: 4511, unit: "kg", factor: 1 },
        L_storage_popper: m(32, 1, "kg"),
        L_ash_amount: m(24, 0.1, "kg"),
        L_cfg_ash_limit: { val: 60, unit: "kg", factor: 0.1, min: 0, max: 200 },
        L_cfg_ash_measurement: { val: 1, format: "0:Aus|1:Ein" },
        L_maint_left_hours: { val: 1000, unit: "h", factor: 1 },
        L_maint_left_days: { val: 364, unit: "d", factor: 1 },
        L_cfg_on_hyst: { val: 100, unit: "K", factor: 0.1 },
        L_cfg_min_runtime: { val: 600000, unit: "min", factor: 1.6666666666666667e-5 },
      },
    }
    expect(boilerDetails(data)).toEqual({
      boilerPowerKw: 16,
      burnerStarts: 9625,
      burnerHours: 9681,
      screwRatioPct: 25.81,
      storageFillKg: 4511,
      hopperKg: 32,
      ashMeasurement: true,
      ashKg: 2.4,
      ashLimitKg: 6,
      maintLeftHours: 1000,
      maintLeftDays: 364,
      burnerOnHystK: 10,
      minRuntimeMin: 10,
      curveSlope: 1,
      curveBasepointC: 31,
      heatLimitC: 18,
      ambientAvgC: 13.9,
      usbStick: true,
    })
  })

  it("données détaillées sans métadonnées (/all) : facteurs par défaut ; rien de connu : null", () => {
    const d = boilerDetails({
      pe1: { L_ash_amount: "24", L_cfg_min_runtime: "600000", L_runtimeburner: "0", L_resttimeburner: "0", L_storage_fill: "0" },
      hk1: { L_cfg_curve_slope: "12" },
      system: { L_usb_stick: "false" },
    })
    expect(d).toEqual({ ashKg: 2.4, minRuntimeMin: 10, screwRatioPct: 0, storageFillKg: 0, curveSlope: 1.2, usbStick: false })
    expect(boilerDetails({ pe1: { L_temp_act: "200" } })).toBeNull()
    expect(boilerDetails(null)).toBeNull()
  })

  it("file d'attente bornée : les plus anciens relevés sont abandonnés", () => {
    expect(enqueue([1, 2], [3], 5)).toEqual([1, 2, 3])
    expect(enqueue([1, 2, 3, 4], [5, 6], 5)).toEqual([2, 3, 4, 5, 6])
  })
})
