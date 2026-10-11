# Connecteur Vertuoz

Petit programme à installer **chez le client, sur le même réseau que la chaudière**. Il lit les journaux
de la régulation Ökofen Pelletronic Touch (`http://<chaudière>/logfiles/pelletronic`) et les envoie à
Vertuoz. La régulation écrit ses journaux (une ligne par minute) toutes les 2 heures environ : toutes les
10 minutes, le connecteur vérifie que la chaudière répond (signe de vie) et n'envoie que les nouvelles lignes,
rien si le journal n'a pas changé.

- Connexions **sortantes uniquement** (HTTPS vers Vertuoz) : rien à ouvrir sur la box.
- Aucune dépendance : un seul fichier, Node.js 18+ ou Docker.
- Seuls les journaux manquants sont envoyés ; un jour complet n'est jamais renvoyé.

## 1. Obtenir un code d'appairage

Dans Vertuoz : **Ajouter une chaudière** → mode **Connecteur local** → la page de la chaudière affiche un
code `XXXX-XXXX`, valable 24 heures et à usage unique, ainsi que les commandes ci-dessous pré-remplies.

## 2. Lancer le connecteur

Le client n'a **pas besoin du code source** : il utilise l'image Docker publiée ou télécharge le fichier
du connecteur depuis Vertuoz.

### Avec Docker (recommandé : redémarre tout seul)

```sh
docker run -d --name vertuoz-agent --restart unless-stopped \
  -e VERTUOZ_SERVER=https://app.vertuoz.fr \
  -e BOILER_URL=http://192.168.1.20 \
  -e VERTUOZ_PAIRING_CODE=XXXX-XXXX \
  -v vertuoz-agent-data:/data \
  ghcr.io/domotrique/vertuoz-agent:1
docker logs -f vertuoz-agent
```

Ou avec Docker Compose : renseigner `docker-compose.yml`, puis `docker compose up -d`.
L'image existe pour PC/NAS (amd64) et Raspberry Pi (arm64, armv7).

### Sans Docker (Node.js 18+)

PowerShell :

```powershell
Invoke-WebRequest -Uri https://app.vertuoz.fr/telechargements/vertuoz-agent.mjs -OutFile vertuoz-agent.mjs
$env:VERTUOZ_SERVER="https://app.vertuoz.fr"
$env:BOILER_URL="http://192.168.1.20"
$env:VERTUOZ_PAIRING_CODE="XXXX-XXXX"
node vertuoz-agent.mjs
```

Linux / macOS :

```sh
curl -fsSLO https://app.vertuoz.fr/telechargements/vertuoz-agent.mjs
VERTUOZ_SERVER=https://app.vertuoz.fr BOILER_URL=http://192.168.1.20 VERTUOZ_PAIRING_CODE=XXXX-XXXX node vertuoz-agent.mjs
```

Sans Docker, le connecteur s'arrête avec la fenêtre : pour un fonctionnement permanent, utiliser Docker ou
un service (tâche planifiée Windows « au démarrage », service systemd sous Linux).

Le journal doit afficher `Appairé à l'installation « … »` puis `Cycle terminé : …`. Le jeton est enregistré
dans `data/agent.json` (ou le volume `/data` avec Docker) : aux démarrages suivants, le code n'est plus utile.

## 3. Mettre à jour le connecteur

Quand une nouvelle version est publiée, la page de la chaudière affiche « Mise à jour disponible » avec les
commandes pré-remplies. Le jeton est conservé (volume `/data` ou dossier `data`) : pas de nouveau code
d'appairage.

Docker :

```sh
docker pull ghcr.io/domotrique/vertuoz-agent:1
docker stop vertuoz-agent && docker rm vertuoz-agent
# puis relancer la commande « docker run » d'origine, sans VERTUOZ_PAIRING_CODE
```

Docker Compose : `docker compose pull` puis `docker compose up -d`.

PowerShell (Windows), dans le dossier du connecteur, après l'avoir arrêté (Ctrl+C dans sa fenêtre, ou arrêt
de la tâche planifiée) :

```powershell
Invoke-WebRequest -Uri https://app.vertuoz.fr/telechargements/vertuoz-agent.mjs -OutFile vertuoz-agent.mjs
$env:VERTUOZ_SERVER="https://app.vertuoz.fr"
$env:BOILER_URL="http://192.168.1.20"
node vertuoz-agent.mjs
```

Linux / macOS, après l'avoir arrêté :

```sh
curl -fsSLO https://app.vertuoz.fr/telechargements/vertuoz-agent.mjs
VERTUOZ_SERVER=https://app.vertuoz.fr BOILER_URL=http://192.168.1.20 node vertuoz-agent.mjs
```

## Publier l'image (exploitant de Vertuoz)

L'image est construite et publiée par le workflow GitHub `.github/workflows/agent-image.yml` :

```sh
git tag agent-v1.0.0
git push origin agent-v1.0.0
```

Elle apparaît dans l'onglet *Packages* du dépôt : la passer en **public** (Package settings → Change
visibility) pour que les clients puissent la télécharger sans compte GitHub. Pour utiliser un autre
registre, renseigner `NEXT_PUBLIC_AGENT_IMAGE` dans la configuration de Vertuoz.

## Variables

| Variable | Rôle | Défaut |
|---|---|---|
| `VERTUOZ_SERVER` | Adresse de Vertuoz | obligatoire |
| `BOILER_URL` | Adresse de la chaudière sur le réseau local | obligatoire |
| `VERTUOZ_PAIRING_CODE` | Code d'appairage (premier démarrage) | — |
| `DATA_DIR` | Dossier du jeton | `./data` (`/data` avec Docker) |
| `INTERVAL_MINUTES` | Forcer l'intervalle entre deux envois | celui de Vertuoz (10 min) |
| `AGENT_NAME` | Nom affiché dans Vertuoz | nom de la machine (identifiant du conteneur sous Docker) |
| `LOG_LEVEL` | `info` ou `debug` | `info` |

## Commandes utiles

- `node vertuoz-agent.mjs --once` : un seul cycle, pour tester.
- `node vertuoz-agent.mjs --reset` : oublie le jeton (pour refaire l'appairage avec un nouveau code).
- Code d'appairage refusé (erroné, expiré, déjà utilisé) : le connecteur se met en veille ; corriger
  `VERTUOZ_PAIRING_CODE` puis le redémarrer. Si Vertuoz est injoignable, il réessaie toutes les 5 minutes.

## Tester avec la chaudière virtuelle

La chaudière virtuelle répond sur `http://localhost:8181` du poste.

- Sans Docker : `BOILER_URL=http://localhost:8181`.
- Avec Docker Desktop : `BOILER_URL=http://host.docker.internal:8181` (et `VERTUOZ_SERVER=http://host.docker.internal:3000`
  si Vertuoz tourne aussi sur le poste).

## Suppression de la chaudière et désinstallation

Vertuoz ne peut pas désinstaller le connecteur à distance (il n'accepte aucune connexion entrante). Quand la
chaudière est **supprimée** ou **désactivée** dans Vertuoz, ou le connecteur **dissocié**, le connecteur reçoit
la raison au cycle suivant, oublie son jeton et **se met en veille** : il n'interroge plus Vertuoz et rappelle
toutes les 6 heures dans son journal comment le désinstaller ou le réutiliser.

Désinstaller :

```sh
docker rm -f vertuoz-agent && docker volume rm vertuoz-agent-data   # Docker
docker compose down -v                                              # Docker Compose
```

Sans Docker : arrêter le programme, puis supprimer `vertuoz-agent.mjs` et le dossier `data`.

Réutiliser le connecteur (autre chaudière, nouvel appairage) : renseigner un **nouveau** `VERTUOZ_PAIRING_CODE`
et le redémarrer. Un code déjà utilisé ou refusé n'est jamais réessayé.

## Dépannage

| Message | Cause probable |
|---|---|
| `Code d'appairage inconnu ou déjà utilisé` | Code déjà consommé : en générer un nouveau dans Vertuoz |
| `Code d'appairage expiré` | Plus de 24 h : en générer un nouveau |
| `Chaudière injoignable` | `BOILER_URL` incorrecte ou chaudière éteinte ; Vertuoz affiche l'installation « en erreur » |
| `En veille : la chaudière … a été supprimée` | Chaudière supprimée ou désactivée dans Vertuoz : désinstaller le connecteur (voir plus haut) |
| `En veille : ce connecteur a été dissocié…` | Redémarrer avec un nouveau `VERTUOZ_PAIRING_CODE` |
