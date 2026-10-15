# Connecteur Granulink

Petit programme à installer **chez le client, sur le même réseau que la chaudière**. Il lit les journaux
de la régulation Ökofen Pelletronic Touch (`http://<chaudière>/logfiles/pelletronic`) et les envoie à
Granulink. En firmware V4 (plus de journaux), il relève chaque minute l'interface JSON de la régulation
(voir [Firmware V4](#firmware-v4--interface-json)). La régulation écrit ses journaux (une ligne par minute) toutes les 2 heures environ : toutes les
10 minutes, le connecteur vérifie que la chaudière répond (signe de vie) et n'envoie que les nouvelles lignes,
rien si le journal n'a pas changé.

- Connexions **sortantes uniquement** (HTTPS vers Granulink) : rien à ouvrir sur la box.
- Aucune dépendance : un seul fichier, Node.js 18+ ou Docker.
- Seuls les journaux manquants sont envoyés ; un jour complet n'est jamais renvoyé.

## 1. Obtenir un code d'appairage

Dans Granulink : **Ajouter une chaudière** → mode **Connecteur local** → la page de la chaudière affiche un
code `XXXX-XXXX`, valable 24 heures et à usage unique, ainsi que les commandes ci-dessous pré-remplies.

## 2. Lancer le connecteur

Le client n'a **pas besoin du code source** : il utilise l'image Docker publiée ou télécharge le fichier
du connecteur depuis Granulink.

### Avec Docker (recommandé : redémarre tout seul)

```sh
docker run -d --name granulink-agent --restart unless-stopped \
  -e GRANULINK_SERVER=https://app.granulink.fr \
  -e BOILER_URL=http://192.168.1.20 \
  -e GRANULINK_PAIRING_CODE=XXXX-XXXX \
  -v granulink-agent-data:/data \
  ghcr.io/domotrique/granulink-agent:1
docker logs -f granulink-agent
```

Ou avec Docker Compose : renseigner `docker-compose.yml`, puis `docker compose up -d`.
L'image existe pour PC/NAS (amd64) et Raspberry Pi (arm64, armv7).

### Sans Docker (Node.js 18+)

PowerShell :

```powershell
Invoke-WebRequest -Uri https://app.granulink.fr/telechargements/granulink-agent.mjs -OutFile granulink-agent.mjs
$env:GRANULINK_SERVER="https://app.granulink.fr"
$env:BOILER_URL="http://192.168.1.20"
$env:GRANULINK_PAIRING_CODE="XXXX-XXXX"
node granulink-agent.mjs
```

Linux / macOS :

```sh
curl -fsSLO https://app.granulink.fr/telechargements/granulink-agent.mjs
GRANULINK_SERVER=https://app.granulink.fr BOILER_URL=http://192.168.1.20 GRANULINK_PAIRING_CODE=XXXX-XXXX node granulink-agent.mjs
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
docker pull ghcr.io/domotrique/granulink-agent:1
docker stop granulink-agent && docker rm granulink-agent
# puis relancer la commande « docker run » d'origine, sans GRANULINK_PAIRING_CODE
```

Docker Compose : `docker compose pull` puis `docker compose up -d`.

PowerShell (Windows), dans le dossier du connecteur, après l'avoir arrêté (Ctrl+C dans sa fenêtre, ou arrêt
de la tâche planifiée) :

```powershell
Invoke-WebRequest -Uri https://app.granulink.fr/telechargements/granulink-agent.mjs -OutFile granulink-agent.mjs
$env:GRANULINK_SERVER="https://app.granulink.fr"
$env:BOILER_URL="http://192.168.1.20"
node granulink-agent.mjs
```

Linux / macOS, après l'avoir arrêté :

```sh
curl -fsSLO https://app.granulink.fr/telechargements/granulink-agent.mjs
GRANULINK_SERVER=https://app.granulink.fr BOILER_URL=http://192.168.1.20 node granulink-agent.mjs
```

## Publier l'image (exploitant de Granulink)

L'image est construite et publiée par le workflow GitHub `.github/workflows/agent-image.yml` :

```sh
git tag agent-v1.2.0
git push origin agent-v1.2.0
```

Elle apparaît dans l'onglet *Packages* du dépôt : la passer en **public** (Package settings → Change
visibility) pour que les clients puissent la télécharger sans compte GitHub. Pour utiliser un autre
registre, renseigner `NEXT_PUBLIC_AGENT_IMAGE` dans la configuration de Granulink.

## Variables

| Variable | Rôle | Défaut |
|---|---|---|
| `GRANULINK_SERVER` | Adresse de Granulink | obligatoire |
| `BOILER_URL` | Adresse de la chaudière sur le réseau local | obligatoire |
| `GRANULINK_PAIRING_CODE` | Code d'appairage (premier démarrage) | — |
| `BOILER_JSON_PASSWORD` | Mot de passe de l'interface JSON (firmware V4) | — |
| `BOILER_JSON_PORT` | Port de l'interface JSON | `4321` |
| `BOILER_SOURCE` | `auto` (journaux CSV, sinon interface JSON), `csv` ou `json` | `auto` |
| `DATA_DIR` | Dossier du jeton | `./data` (`/data` avec Docker) |
| `INTERVAL_MINUTES` | Forcer l'intervalle entre deux envois | celui de Granulink (10 min) |
| `AGENT_NAME` | Nom affiché dans Granulink | nom de la machine (identifiant du conteneur sous Docker) |
| `LOG_LEVEL` | `info` ou `debug` | `info` |

## Commandes utiles

- `node granulink-agent.mjs --once` : un seul cycle, pour tester.
- `node granulink-agent.mjs --reset` : oublie le jeton. Inutile pour refaire l'appairage : il suffit de
  redémarrer avec un **nouveau** `GRANULINK_PAIRING_CODE`, qui remplace l'appairage en cours.
- Code d'appairage refusé (erroné, expiré, déjà utilisé) : le connecteur se met en veille ; corriger
  `GRANULINK_PAIRING_CODE` puis le redémarrer. Si Granulink est injoignable, il réessaie toutes les 5 minutes.

## Plusieurs chaudières

**Un connecteur par chaudière, chacun avec son propre jeton** : un jeton correspond à une chaudière de
Granulink. Lancer deux connecteurs depuis le même dossier (ou avec le même volume Docker) leur ferait
partager un jeton, et les journaux des deux chaudières se mélangeraient dans un seul historique.

- Docker : un nom de conteneur et un volume par chaudière (`--name granulink-agent-gite -v granulink-agent-data-gite:/data`).
- Node.js : un dossier par chaudière, ou `DATA_DIR` distinct (`DATA_DIR=data-gite`).

Les commandes affichées par Granulink le font déjà dès qu'un compte a plusieurs chaudières. Depuis la
version 1.2.0, le connecteur mémorise l'adresse de la chaudière appairée et **refuse d'envoyer** si
`BOILER_URL` en désigne une autre. Si l'adresse de la même chaudière a changé (box, DHCP), générez un
nouveau code dans Granulink et redémarrez avec ce code. Granulink signale de son côté un connecteur plus
ancien qui interroge une autre adresse que celle de l'appairage.

Réparer un historique mélangé (exploitant de Granulink) :

```sh
npm run readings:purge -- --email client@exemple.fr                 # chaudières du compte et leurs mesures
npm run readings:purge -- <id> --depuis 2026-10-01                  # aperçu par journée
npm run readings:purge -- <id> --depuis 2026-10-01 --confirmer      # effacement
```

Au cycle suivant, le connecteur (correctement appairé) renvoie les journées encore présentes sur la chaudière.

## Firmware V4 : interface JSON

Depuis le firmware V4, la Pelletronic Touch n'a plus de serveur web : ni journaux CSV, ni `/index.cgi`. Seule
reste l'interface JSON (`http://<chaudière>:4321/<mot de passe>/all`), à activer sur l'écran (mode avancé,
Général › IPConfig, qui donne aussi le mot de passe).

Avec `BOILER_JSON_PASSWORD`, le connecteur essaie d'abord les journaux ; s'ils sont introuvables et que
l'interface JSON répond, il passe au **relevé minute par minute** (`BOILER_SOURCE=json` l'impose) :

- un relevé par minute, conservé dans une file d'attente (`readings-queue.json` du dossier `DATA_DIR`, une semaine
  au plus) et envoyé à chaque cycle : une coupure de Granulink ne perd rien ;
- les deux formes de réponse sont lues : valeurs nues (anciens firmwares) ou avec métadonnées (`{"val": 537,
  "factor": 0.1}`) ; texte en UTF-8, sinon Windows-1252 ; défauts connus du JSON corrigés (guillemet manquant après
  `L_statetext`, caractères de contrôle) ; valeurs « indisponible » (`-32768`…`-32766`, `32765`…`32767`) ignorées ;
- état de la chaudière (`pe1.L_state`) en code (4 = combustion, 99 = veille) ou en champ de bits selon le firmware
  (16 = combustion, 2147483648 = arrêt) ;
- compteurs de granulés : `storage_fill_today`/`yesterday` ou `L_pellets_today`/`yesterday` selon le firmware ;
- pas d'historique sur la chaudière : les données commencent au démarrage du connecteur ;
- la consommation est recalée par Granulink sur le compteur de granulés de la chaudière
  (`pe1.storage_fill_today`) quand il est alimenté, sinon estimée d'après la modulation et la puissance.

Si la régulation (firmware V3.10c/d) est réglée en allemand, les umlauts rendent la réponse invalide : passer
l'écran en anglais.

## Tester avec la chaudière virtuelle

La chaudière virtuelle répond sur `http://localhost:8181` du poste (interface JSON : port 4321, mot de passe
`1234`).

- Sans Docker : `BOILER_URL=http://localhost:8181`.
- Avec Docker Desktop : `BOILER_URL=http://host.docker.internal:8181` (et `GRANULINK_SERVER=http://host.docker.internal:3000`
  si Granulink tourne aussi sur le poste).
- Firmware V4 : `/_sim?firmware=4` sur la chaudière virtuelle, puis `BOILER_JSON_PASSWORD=1234` ;
  `/_sim?compteurs=non` simule une chaudière sans compteur de granulés (consommation estimée).

## Suppression de la chaudière et désinstallation

Granulink ne peut pas désinstaller le connecteur à distance (il n'accepte aucune connexion entrante). Quand la
chaudière est **supprimée** ou **désactivée** dans Granulink, ou le connecteur **dissocié**, le connecteur reçoit
la raison au cycle suivant, oublie son jeton et **se met en veille** : il n'interroge plus Granulink et rappelle
toutes les 6 heures dans son journal comment le désinstaller ou le réutiliser.

Désinstaller :

```sh
docker rm -f granulink-agent && docker volume rm granulink-agent-data   # Docker
docker compose down -v                                              # Docker Compose
```

Sans Docker : arrêter le programme, puis supprimer `granulink-agent.mjs` et le dossier `data`.

Réutiliser le connecteur (autre chaudière, nouvel appairage) : renseigner un **nouveau** `GRANULINK_PAIRING_CODE`
et le redémarrer. Un code déjà utilisé ou refusé n'est jamais réessayé.

## Dépannage

| Message | Cause probable |
|---|---|
| `Code d'appairage inconnu ou déjà utilisé` | Code déjà consommé : en générer un nouveau dans Granulink |
| `Code d'appairage expiré` | Plus de 24 h : en générer un nouveau |
| `Chaudière injoignable` | `BOILER_URL` incorrecte ou chaudière éteinte ; Granulink affiche l'installation « en erreur » |
| `… interface JSON : mot de passe JSON refusé` | `BOILER_JSON_PASSWORD` différent de celui de l'écran (Général › IPConfig) |
| `… réponse illisible (JSON invalide)` | Régulation réglée en allemand (firmware V3.10) : la passer en anglais |
| `En veille : la chaudière … a été supprimée` | Chaudière supprimée ou désactivée dans Granulink : désinstaller le connecteur (voir plus haut) |
| `En veille : ce connecteur a été dissocié…` | Redémarrer avec un nouveau `GRANULINK_PAIRING_CODE` |
