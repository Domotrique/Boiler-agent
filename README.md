# Connecteur Vertuoz

Petit programme à installer **chez le client, sur le même réseau que la chaudière**. Il lit les journaux
de la régulation Ökofen Pelletronic Touch (`http://<chaudière>/logfiles/pelletronic`) et les envoie à
Vertuoz toutes les 2 minutes.

- Connexions **sortantes uniquement** (HTTPS vers Vertuoz) : rien à ouvrir sur la box.
- Aucune dépendance : un seul fichier, Node.js 18+ ou Docker.
- Seuls les journaux manquants sont envoyés ; un jour complet n'est jamais renvoyé.

## 1. Obtenir un code d'appairage

Dans Vertuoz : **Ajouter une chaudière** → mode **Connecteur local** → la page de la chaudière affiche un
code `XXXX-XXXX`, valable 24 heures et à usage unique, ainsi que les commandes ci-dessous pré-remplies.

## 2. Lancer le connecteur

### Avec Docker

```sh
docker build -t vertuoz-agent .
docker run -d --name vertuoz-agent --restart unless-stopped \
  -e VERTUOZ_SERVER=https://app.vertuoz.fr \
  -e BOILER_URL=http://192.168.1.20 \
  -e VERTUOZ_PAIRING_CODE=XXXX-XXXX \
  -v vertuoz-agent-data:/data \
  vertuoz-agent
docker logs -f vertuoz-agent
```

Ou avec Docker Compose : renseigner `docker-compose.yml`, puis `docker compose up -d`.

### Sans Docker (Node.js 18+)

PowerShell :

```powershell
$env:VERTUOZ_SERVER="https://app.vertuoz.fr"
$env:BOILER_URL="http://192.168.1.20"
$env:VERTUOZ_PAIRING_CODE="XXXX-XXXX"
node vertuoz-agent.mjs
```

Linux / macOS :

```sh
VERTUOZ_SERVER=https://app.vertuoz.fr BOILER_URL=http://192.168.1.20 VERTUOZ_PAIRING_CODE=XXXX-XXXX node vertuoz-agent.mjs
```

Le journal doit afficher `Appairé à l'installation « … »` puis `Cycle terminé : …`. Le jeton est enregistré
dans `data/agent.json` (ou le volume `/data` avec Docker) : aux démarrages suivants, le code n'est plus utile.

## Variables

| Variable | Rôle | Défaut |
|---|---|---|
| `VERTUOZ_SERVER` | Adresse de Vertuoz | obligatoire |
| `BOILER_URL` | Adresse de la chaudière sur le réseau local | obligatoire |
| `VERTUOZ_PAIRING_CODE` | Code d'appairage (premier démarrage) | — |
| `DATA_DIR` | Dossier du jeton | `./data` (`/data` avec Docker) |
| `INTERVAL_MINUTES` | Forcer l'intervalle entre deux envois | celui de Vertuoz (2 min) |
| `AGENT_NAME` | Nom affiché dans Vertuoz | nom de la machine (identifiant du conteneur sous Docker) |
| `LOG_LEVEL` | `info` ou `debug` | `info` |

## Commandes utiles

- `node vertuoz-agent.mjs --once` : un seul cycle, pour tester.
- `node vertuoz-agent.mjs --reset` : oublie le jeton (pour refaire l'appairage avec un nouveau code).
- En cas d'échec de l'appairage (code erroné ou expiré, Vertuoz injoignable), le connecteur réessaie toutes les 5 minutes :
  corriger `VERTUOZ_PAIRING_CODE` puis redémarrer le conteneur.

## Tester avec la chaudière virtuelle

La chaudière virtuelle répond sur `http://localhost:8181` du poste.

- Sans Docker : `BOILER_URL=http://localhost:8181`.
- Avec Docker Desktop : `BOILER_URL=http://host.docker.internal:8181` (et `VERTUOZ_SERVER=http://host.docker.internal:3000`
  si Vertuoz tourne aussi sur le poste).

## Dépannage

| Message | Cause probable |
|---|---|
| `Code d'appairage inconnu ou déjà utilisé` | Code déjà consommé : en générer un nouveau dans Vertuoz |
| `Code d'appairage expiré` | Plus de 24 h : en générer un nouveau |
| `Chaudière injoignable` | `BOILER_URL` incorrecte ou chaudière éteinte ; Vertuoz affiche l'installation « en erreur » |
| `Vertuoz ne reconnaît plus ce connecteur` | Connecteur dissocié depuis Vertuoz : le jeton est oublié ; redémarrer avec un nouveau `VERTUOZ_PAIRING_CODE` |
