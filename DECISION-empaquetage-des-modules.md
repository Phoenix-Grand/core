# Décision d'architecture - l'empaquetage des modules

**Statut :** accepté · **Migration :** les trois étapes livrées · **Date :** 2026-08-26 · **Portée :** le core et les dépôts de modules

Ce document tranche une question : **comment un module de Kubuno arrive-t-il sur une
instance ?** Il ne concerne pas le core lui-même, dont l'empaquetage est traité par
[`PACKAGING.md`](PACKAGING.md) et n'est pas remis en cause ici.

---

## 1. Ce qui se passe aujourd'hui

Chaque dépôt de module produit **quatre paquets natifs** - `.deb`, `.rpm`, `.exe`
(NSIS) et `.pkg` (macOS) - via quatre scripts de construction et deux workflows
d'intégration continue, tous dupliqués dans chaque dépôt de module (23 aujourd'hui). En parallèle, la console
d'administration propose d'installer un module **en un clic**.

Quatre faits, tous vérifiés dans le code, décrivent l'état réel de ce dispositif.

**a) La marketplace n'utilise pas le gestionnaire de paquets du système.** Elle
télécharge le `.deb`, **l'ouvre elle-même**, en extrait la charge utile, la relocalise
dans un magasin inscriptible (`/var/lib/kubuno/modules-store/<id>`) puis démarre le
processus (`modules/marketplace/{artifact,extract,install}.rs`). `dpkg` n'intervient
jamais. Autrement dit : **le `.deb` n'est déjà qu'un conteneur**, et un conteneur
propre à Debian.

**b) L'installation en un clic ne fonctionne que sur Linux.** Le core choisit
l'artefact d'une Release GitHub par **suffixe de nom de fichier**
(`marketplace/artifact.rs`). Il attend `-windows-x64.zip` et `-macos-arm64.tar.gz` ;
la chaîne d'intégration des modules produit `…-setup-<version>-x64.exe` et
`…-<version>-arm64.pkg`. Aucun suffixe ne correspond : sur Windows et macOS, la
promesse du « un clic » échoue avant même le téléchargement.

**c) Le catalogue ne décrit pas les artefacts.** Le core lit
`https://www.kubuno.com/api/v1/modules`. Cette API n'expose **ni URL d'artefact, ni
empreinte, ni plateforme** - les champs existent côté core (`download_url`, `sha256`)
mais restent vides. D'où la devinette du point (b), et l'impossibilité, depuis le
panneau d'administration du site, de voir vers quel binaire pointe un module.

**d) L'intégrité est vérifiée, l'authenticité non.** Le core compare le SHA-256 du
téléchargement à l'empreinte annoncée par l'API GitHub. Cela prouve que le fichier
reçu est bien celui que GitHub annonce - **pas qui l'a produit**. Aucun paquet de
module n'est signé.

---

## 2. Ce qu'un paquet natif apporte réellement à un module

La question n'est pas « les paquets natifs sont-ils une bonne chose » - ils le sont
pour le core - mais « qu'apportent-ils **à un module** ».

| Service rendu par un paquet natif | Utile à un module ? |
|---|---|
| Enregistrer un service système | **Non.** C'est le core qui supervise le processus, le lance, le relance et l'arrête. |
| Poser de la configuration dans `/etc` | **Non.** La configuration du module vit dans l'arborescence du core, qui la lui injecte par variables d'environnement. |
| Appliquer des migrations de schéma | **Non.** Elles sont embarquées dans le binaire (`sqlx::migrate!`) ; les fichiers livrés ne sont qu'une référence. |
| Déclarer des dépendances système | **Marginalement.** Deux cas dans toute la flotte : `ffmpeg` (media) et `ollama` (assistant). |
| Faire respecter la version du core | **Oui, mais mal.** `Depends: kubuno-core (>= x)` - une vérification que le core fait mieux, puisqu'il connaît sa propre version et peut l'expliquer. |
| Inventaire (`dpkg -l`) et mises à jour de la distribution | **Oui.** C'est le seul apport véritable, et il se paie cher (voir §7). |

Le bilan est net : on maintient **92 scripts d'empaquetage et 48 workflows**, répartis
sur 23 dépôts de modules, pour un
service qui, dans les faits, se réduit à une ligne de dépendance et à un affichage
dans `dpkg -l`.

---

## 3. Options envisagées

**Option A - Statu quo, en corrigeant les suffixes.** Ajouter `.exe` et `.pkg` à la
liste des suffixes reconnus. *Rejetée* : cela ne ferait que télécharger un installateur
graphique NSIS ou un `.pkg` que le core devrait ensuite exécuter - c'est-à-dire lancer
un installateur système depuis un service, exactement ce que l'architecture interdit
(zéro exécution non maîtrisée sur l'hôte). Le problème de fond - un conteneur différent
par système - resterait entier.

**Option B - Assumer les paquets natifs jusqu'au bout.** Publier de vrais dépôts `apt`
et `dnf` signés, un installateur silencieux Windows, un `.pkg` notarisé. *Rejetée* :
c'est le chemin le plus coûteux (infrastructure de dépôts, signature de code Windows,
compte développeur Apple, notarisation) pour un gain qui ne profite qu'à un cas d'usage -
l'administrateur qui veut voir ses modules dans l'inventaire de sa distribution.

**Option C - Un format unique, installé par le core.** *Retenue.* Détaillée ci-dessous.

**Option D - Une image OCI par module.** *Rejetée* : imposerait un moteur de conteneurs
là où Kubuno se veut installable sans, alourdirait chaque module de plusieurs dizaines
de mégaoctets de système de base, et casserait le modèle « un module = un processus
supervisé par le core ».

---

## 4. Décision

> **Les modules sont distribués dans un format unique, `.kbpkg`, que le core installe
> lui-même. Le core, lui, conserve ses paquets natifs.**

Ce n'est pas un renversement : c'est la **reconnaissance de ce que le code fait déjà**
(§1.a). On cesse d'emballer une charge utile dans un conteneur Debian pour la déballer
aussitôt, et on adopte un conteneur qui vaut pour les quatre systèmes.

La répartition devient lisible :

- **le core** est un logiciel système → paquet natif (`.deb`, `.rpm`, `.exe`, `.pkg`),
  compte de service, unité systemd/launchd/WinSW, configuration dans `/etc` ;
- **un module** est une extension d'application → `.kbpkg`, installé, vérifié, démarré,
  mis à jour et retiré par le core.

---

## 5. Le format

**Un fichier par couple (système, architecture)** : un binaire Rust pèse une trentaine
de mégaoctets, un paquet « gras » réunissant quatre cibles en ferait plus de cent pour
n'en utiliser qu'une.

```
office-0.1.5-linux-x86_64.kbpkg        (archive ZIP)
├── manifest.toml          identité, exigences, ce que le module demande
├── SHA256SUMS             empreinte de chaque fichier de l'archive
├── SHA256SUMS.sig         signature Ed25519 détachée du relevé ci-dessus
├── bin/kubuno-office      l'exécutable
├── frontend/              entry.js, entry.css, assets
├── migrations/            référence (les migrations réelles sont dans le binaire)
├── LICENSE
└── CHANGELOG.md
```

ZIP plutôt que `tar.zst` : lisible par tous les systèmes et tous les outils sans
dépendance, entrée par entrée, sans décompression complète préalable.

Le manifeste porte ce que le `.deb` ne savait pas exprimer :

```toml
[module]
id = "office"; version = "0.1.5"; runtime = "rust"; entrypoint = "bin/kubuno-office"

[requires]
core = ">=0.1.6"           # vérifié par le core, qui connaît sa version
modules = ["drive"]        # dépendances entre modules, résolues avant démarrage
system = ["ffmpeg"]        # signalé à l'administrateur, jamais installé d'autorité

[target]
os = "linux"; arch = "x86_64"

[capabilities]
port = 3105
storage = true             # ce que le module demande à l'instance
```

**Signature.** `SHA256SUMS.sig` est produite par la chaîne d'intégration avec une clé
Ed25519 dont la partie publique est **embarquée dans le core** pour les modules
officiels. Pour un module tiers, la clé est déclarée dans le catalogue et **confirmée
par l'administrateur à la première installation**, puis épinglée. C'est un gain net :
aujourd'hui, rien ne prouve l'origine d'un paquet de module (§1.d).

---

## 6. Ce que le catalogue doit porter

L'API du site (`/api/v1/modules`) gagne, par module, un tableau d'artefacts :

```json
"artifacts": [
  { "os": "linux", "arch": "x86_64",
    "url": "https://github.com/kubuno/office/releases/download/v0.1.5/office-0.1.5-linux-x86_64.kbpkg",
    "size": 31457280, "sha256": "…", "sig": "…", "core": ">=0.1.6" }
]
```

Trois conséquences immédiates : le core **cesse de deviner** par suffixe de nom de
fichier ; l'installation en un clic devient possible sur les quatre systèmes ; et le
panneau d'administration du site peut enfin **afficher vers quel binaire pointe chaque
module**, avec sa taille et son empreinte.

---

## 7. Ce que l'on perd, et comment on le compense

**Les modules disparaissent de l'inventaire de la distribution.** `dpkg -l` et
`dnf list` ne les verront plus, et les mises à jour automatiques du système ne les
couvriront plus. C'est le vrai prix de cette décision, et il faut le dire aux
administrateurs plutôt que le masquer. Compensation : la console d'administration liste
les modules, leur version et les mises à jour disponibles, et la ligne de commande fait
de même sans navigateur (`kubuno modules:list`, `kubuno modules:update`).

**Kubuno devient responsable de la vérification.** C'est déjà le cas dans les faits
(§1.a) ; le format rend cette responsabilité explicite et l'outille - empreintes par
fichier et signature, au lieu d'une seule empreinte d'archive.

**Les dépendances système ne sont plus installées automatiquement.** Elles ne l'étaient
déjà pas pour la marketplace. Le manifeste les déclare, le core vérifie leur présence
et refuse l'installation avec un message qui nomme le paquet manquant.

**Un `.deb` de module reste utile en environnement fermé.** Rien n'oblige à le
supprimer : voir l'étape 3 de la migration.

---

## 8. Migration, en trois étapes

**Étape 1 - le catalogue (sans rien casser). ✔ livrée le 2026-08-26.** L'API du site expose les artefacts (§6)
et le panneau d'administration les affiche. Le core préfère `artifacts[]` quand il
existe, et retombe sur la devinette actuelle sinon. *Gain immédiat : la visibilité
demandée, et la fin des installations impossibles sur Windows et macOS.*

**Étape 2 - un module pilote. ✔ livrée le 2026-08-26.** `drive` produit un `.kbpkg` **en plus** de ses paquets
actuels ; le core sait le lire, en vérifier la signature et l'installer. On juge sur
pièce avant de toucher aux autres dépôts.

**Étape 3 - la flotte. ✔ livrée le 2026-08-26.** Généralisation à tous les modules, puis retrait des trois scripts
`build_rpm.sh`, `build_windows.sh` et `build_macos.sh` des dépôts de modules. Le `.deb`
de module est **conservé** tant qu'il sert aux déploiements par gestion de configuration
et aux instances hors ligne ; il devient une commodité, non le mécanisme.

À aucune étape une instance existante ne cesse de fonctionner : les modules déjà
installés le restent, et le core continue de lire son magasin comme aujourd'hui.

---

## 9. Signature : ce qui est décidé

**La clé vit du côté site - mais du bon côté.** Le site a deux moitiés, et la
distinction est ici toute la sécurité :

- le **panneau d'administration**, qui n'est *jamais déployé en ligne* (c'est
  écrit dans son propre `README`) : il tourne sur une machine de confiance et
  n'envoie en production qu'une base expurgée. **C'est là que vit la clé privée.**
- le **serveur public**, joignable par tout l'internet, en PHP, avec une surface
  d'attaque : **la clé n'y est jamais déposée**. L'y placer reviendrait à ce
  qu'une compromission du site permette de signer n'importe quel module - que
  chaque instance installerait et exécuterait ensuite comme un processus
  supervisé, avec accès à la base.

Ce que cette signature atteste, et qu'il faut énoncer honnêtement : **« le
catalogue a vérifié et approuvé ce fichier »**, et non « nous l'avons construit ».
Pour que ce soit vrai, le panneau doit **télécharger l'artefact et calculer
lui-même son empreinte** avant de signer - signer l'empreinte annoncée par un
tiers reviendrait à contresigner une affirmation qu'on n'a pas vérifiée. Coût
réel : un relevé complet télécharge aujourd'hui environ trois gigaoctets.
(Une signature au moment de la construction, dans la chaîne d'intégration, reste
possible plus tard en défense supplémentaire ; elle atteste autre chose.)

**Un module non signé est accepté, mais signalé.** La console l'annonce
clairement - origine non vérifiée - et l'installation demande une confirmation
explicite. C'est le bon arbitrage tant que l'écosystème tiers démarre : refuser
d'emblée fermerait la porte à des modules légitimes avant que l'outillage
n'existe.

Avec une réserve, sans laquelle la signature ne protégerait de rien : **ce qui a
été signé une fois ne peut plus revenir non signé.** Le core mémorise, par
module, qu'une signature valide a été vue ; une version ultérieure non signée, ou
signée par une autre clé, est **refusée** et non simplement signalée. Sans cette
règle, un attaquant se contenterait de retirer la signature pour retomber dans le
cas « averti, puis accepté ».

### Ce qui est en place (2026-08-26)

La signature porte sur **la liste**, pas sur chaque paquet : un manifeste
`/api/v1/modules/manifest` réunit tous les modules, toutes les plateformes et
toutes les empreintes, accompagné d'une **signature Ed25519 détachée**
(en-tête `X-Kubuno-Signature`) ; la clé publique est servie par
`/api/v1/modules/signing-key` et embarquée dans le core (surchargeable par
`KUBUNO_MARKETPLACE_KEY` pour une instance qui suit un autre catalogue).

Le manifeste **ne contient que ce que le catalogue a vérifié lui-même** : le
catalogue télécharge chaque artefact et en calcule l'empreinte, au lieu de
relayer celle qu'annonce la publication. Les empreintes non vérifiées restent
visibles, marquées comme telles, mais ne sont jamais signées.

⚠️ **La clé privée n'est jamais sous une racine servie.** L'évidence « un niveau
au-dessus du site » n'en est pas une : l'installation de développement sert
`/var/www/html` elle-même, et une clé posée là s'est révélée **téléchargeable en
HTTP** - constaté et corrigé sur-le-champ.

**Où vit quoi, depuis la refonte du site (2026-08-26).** Le catalogue a quitté le
site PHP pour un service dédié (`api.kubuno.com`, Rust + PostgreSQL, dépôt
`kubuno.com/service`, tenu par une autre session) ; le relevé d'artefacts et le
manifeste signé y ont été portés à l'identique - mêmes colonnes, même règle de
choix, même clé. Côté core, cela change deux adresses :

| | Avant | Maintenant |
|---|---|---|
| Catalogue | `www.kubuno.com/api/v1/modules` (404 aujourd'hui) | `api.kubuno.com/v1/modules` |
| Surcharge | - | `KUBUNO_MARKETPLACE_URL`, `KUBUNO_MARKETPLACE_KEY` |

⚠️ **Un manifeste absent n'est pas une signature retirée.** Le catalogue répond
404 tant qu'aucune empreinte n'a été vérifiée : c'est un état normal. Le core
distingue donc « installation reportée, réessayez » (manifeste indisponible) de
« installation refusée » (manifeste valide qui ne couvre plus ce module) - sans
quoi une indisponibilité passagère ressemblerait à une attaque.

## 9 bis. Questions encore ouvertes

1. **Faut-il un `.kbpkg` universel** contenant les quatre cibles pour les usages hors
   ligne, en plus des paquets par cible ?
2. **Les capacités déclarées** (`[capabilities]`) sont-elles seulement informatives, ou
   le core doit-il les faire respecter à l'exécution ?


---

## 10. État d'avancement

**Étape 1 - livrée.** Le catalogue du site porte désormais, pour chaque module et
chaque plateforme, le fichier publié, son URL, sa taille et son empreinte
(table `module_artifacts`, relevée depuis les publications GitHub par le panneau
d'administration, exposée par `/api/v1/modules`). Le core préfère cette
description à sa devinette par suffixe, et **refuse explicitement** ce qu'il ne
sait pas déballer plutôt que d'échouer plus loin.

### Ce que l'étape 1 a mis au jour, et ce qui en a été fait

**Le catalogue mentait sur les versions.** Il annonçait `0.1.5` pour vingt modules
dont les binaires publiés sont en `0.1.6` : une valeur unique, écrite à la main,
qui dérivait d'une version entière à chaque publication. La version affichée est
désormais **dérivée de l'étiquette de publication** relevée avec les artefacts -
le catalogue ne peut plus contredire ce vers quoi il pointe. *Corrigé.*

**Des paquets construits étaient jetés.** Quatre modules ont atteint la v0.1.6
avec des paquets manquants (`photos` sans RPM ni macOS, `tasks` sans RPM, `mail`
sans macOS, `wiki` sans Windows). Le journal accusait la construction ; elle avait
réussi. C'est **l'envoi vers la publication** qui échouait : le travail attendait
dix minutes qu'un autre workflow crée la publication, puis abandonnait en
annonçant à tort « build.yml likely failed ». Sur un dépôt dont le `.deb` met plus
de dix minutes à se construire, la publication n'existait simplement pas encore.
Cette étape étant commune à tous les formats, **un `.kbpkg` y tomberait
exactement pareil** - elle a donc été corrigée dans les 25 dépôts : le travail
crée lui-même la publication quand elle manque. *Corrigé.* En revanche, les cinq
paquets natifs manquants n'ont **pas** été reconstruits : ces formats disparaissent
à l'étape 3.

**Un module peut être au catalogue sans rien d'installable.** `build` et `p2pnas`
y figurent sans aucune publication. Le catalogue expose maintenant un indicateur
`installable`, pour que la console distingue « pas encore publié » d'un échec.
*Corrigé.*

**Le relevé peut vieillir sans que rien ne le signale** - d'autant plus depuis que
la version en dépend. Le panneau affiche donc la date du dernier relevé et
avertit au-delà de deux semaines. *Corrigé.*

Ce que cette étape ne résout pas, et qui attend l'étape 2 : sur Windows et macOS,
un module ne publie qu'un installateur système (`.exe`, `.pkg`). Le core sait
ouvrir une archive, pas piloter l'installateur d'un système : l'installation
depuis la console y reste donc impossible **par construction** tant que le
`.kbpkg` n'existe pas. C'est exactement le trou que l'étape 2 vient boucher.


---

## 11. Étape 2 - ce qui a été construit, et ce que l'épreuve a appris

`drive` produit désormais un `.kbpkg` **en plus** de ses paquets système
(`build_kbpkg.sh`, publié par sa chaîne d'intégration à chaque version).

**Le format a été simplifié par rapport au §5.** Plutôt qu'un `manifest.toml`
nouveau, l'archive a pour racine **le répertoire du module tel que le serveur
s'attend à le trouver sur disque** : `module.toml` (le manifeste qu'il lit déjà),
l'exécutable, `frontend/`, `migrations/`, `LICENSE`, `CHANGELOG.md`, et un
`SHA256SUMS` pour qu'une copie hors ligne reste vérifiable sans catalogue. Rien
n'est traduit à l'installation, et **le core n'a eu besoin d'aucune
modification** pour le lire : il localise déjà un module par son `module.toml`,
racine d'archive comprise.

**Un argument décisif est apparu en chemin.** Le core ouvre le `.deb` en
appelant `dpkg-deb`, et le `.tar.gz` en appelant `tar` - des outils externes.
Le **ZIP est le seul format qu'il déballe en Rust pur**. Autrement dit,
l'installation depuis la console ne pouvait fonctionner que là où `dpkg-deb`
existe. Le choix du conteneur n'est donc pas une préférence de goût : c'est ce
qui rend l'installation possible sur Windows et macOS.

**Le coût, dit franchement :** 51 Mo contre 39 Mo pour le `.deb` de la même
version - le ZIP compresse en deflate là où dpkg utilise zstd. Le binaire n'y est
pour rien (115 Mo bruts, dont 6 seulement de symboles). C'est le prix de
l'universalité ; la piste zstd-dans-ZIP reste ouverte le jour où le lecteur du
core sera le seul consommateur qui compte.

**Éprouvé de bout en bout**, sur un core jetable pointé vers un catalogue local
servant un manifeste signé avec la vraie clé : artefact recommandé (`kbpkg`),
téléchargé, **manifeste signé vérifié**, **empreinte attestée par ce manifeste**,
archive déballée, module démarré à chaud. Puis, manifeste retiré : réinstallation
**refusée** au nom de la non-régression, avec le message « installation
reportée ».

⚠️ **Un piège de banc d'essai, et une bonne surprise.** Ma première tentative a
été rejetée par le core : signature invalide. La cause n'était pas le core mais
mon montage - le compte de service ne pouvait pas lire le fichier à signer, et
PHP a donc signé une **chaîne vide**, produisant une signature parfaitement
valide… d'un corps vide. Le core a eu raison de refuser. À retenir pour l'étape 3 :
un outil de signature doit **échouer bruyamment** quand le corps est vide, jamais
signer ce qu'il n'a pas pu lire.


---

## 12. Étape 3 - la flotte

Les **24 dépôts de modules** produisent désormais un `.kbpkg` :

- `_tools/packaging/module_build_kbpkg.sh` est le gabarit auto-détectant (id et
  version lus dans `Cargo.toml`), déployé par `_tools/deploy_packaging.sh` au
  même titre que les trois autres scripts d'empaquetage ;
- la chaîne d'intégration de chaque module construit et publie le paquet
  **Linux** à côté du `.deb` (21 dépôts ; `drive` l'avait déjà) ;
- le gabarit `module_dist.yml` construit et publie les paquets **Windows** et
  **macOS** à partir des binaires déjà compilés pour ces cibles par les scripts
  existants - un `.kbpkg` par couple système/architecture.

**Ce qui n'est pas encore retiré, et pourquoi.** Les scripts `build_rpm.sh`,
`build_windows.sh` et `build_macos.sh` restent en place : ils fournissent
toujours les binaires que le `.kbpkg` empaquette, et les paquets système gardent
leur usage - déploiement par gestion de configuration, réseaux fermés,
administrateurs qui veulent leurs modules dans l'inventaire de leur distribution.
Le retrait se décidera quand la flotte aura vécu une version complète sur le
nouveau format.

⚠️ **Deux dépôts restent à part** : `p2pnas` et `stt` n'ont pas de `build.yml`
du tout. Leur `dist.yml` produira bien les paquets Windows et macOS - et le peut
depuis que l'envoi vers la publication ne dépend plus d'un autre workflow - mais
personne n'y construit le paquet Linux.

### Ce que « tous les systèmes » veut dire exactement

| | Construit | Publié par la CI | Éprouvé ici |
|---|---|---|---|
| Linux x86-64 | oui | oui | **oui, de bout en bout** (installation réelle depuis la console) |
| Windows x64 | oui (croisé, cible msvc) | oui | non - aucune machine Windows ici |
| macOS arm64 | oui (exécuteur macOS) | oui | non - aucun Mac ici |

Une distinction que le format efface au passage : pour un module, **il n'y a plus
de question Debian contre Fedora**. C'est le même fichier. Et ce n'est pas un
détail de confort : l'installation depuis la console était cassée sur Fedora
aussi, puisque le serveur y aurait téléchargé un `.deb` pour le confier à
`dpkg-deb`, absent de ces systèmes.


---

## 13. Première release réelle - `drive` v0.1.7

Publiée le 2026-08-26. Ce que la Release porte :

| Artefact | État |
|---|---|
| `drive-0.1.7-linux-x86_64.kbpkg` | **publié** (51 Mo) |
| `drive-0.1.7-macos-aarch64.kbpkg` | **publié** (51 Mo) |
| `drive-0.1.7-windows-x86_64.kbpkg` | **manquant** - voir ci-dessous |
| `.deb` (39 Mo), `.rpm`, `.pkg` | publiés |

Le paquet macOS confirme que la chaîne fonctionne au-delà de Linux, sur une
plateforme qu'aucune machine ici ne pouvait éprouver.

⚠️ **Le paquet Windows a été perdu pour une raison bête et instructive** :
l'exécuteur Windows de l'intégration continue **n'a pas `zip`**. Le binaire
s'était compilé, le frontend aussi ; seul l'archivage a échoué -
`zip: command not found`. Le constructeur retombe désormais sur 7-Zip puis sur
PowerShell. Corrigé après la release : le paquet Windows arrivera avec la
suivante.

⚠️ La chaîne de qualité a également échoué, sur du code antérieur : un lint
apparu avec un compilateur plus récent (`chunks_exact_to_as_chunks`) refusait le
lecteur de noms de polices. Corrigé.

**Ce que cette release ne prouve pas encore** : aucune instance n'installera le
`.kbpkg` tant que le core publié ignore les champs `artifact`/`artifacts` du
catalogue - elle retombe sur sa devinette par suffixe et prend le `.deb`. Sans
danger, mais le nouveau format ne sera réellement exercé qu'après une release du
core.
