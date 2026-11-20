
# ERPLibre Home — extension GNOME Shell

Une extension GNOME Shell qui ajoute six indicateurs à la barre du haut :
tuilage des fenêtres et jeux, sessions Claude Code, liste de médias,
instances ERPLibre, hôtes SSH du réseau et Stream Deck Elgato. Elle
exporte aussi une interface D-Bus, par laquelle le programme Stream Deck
d'[ERPLibre](https://github.com/ERPLibre/ERPLibre) tuile les fenêtres et
suit les sessions depuis les touches du deck.

- UUID : `erplibre-home@technolibre.ca`
- GNOME Shell 45 à 51 (`shell-version` dans `metadata.json`)
- Licence : AGPL-3.0 ou ultérieure (`LICENSE`)

L'extension fonctionne seule. Dans un checkout d'ERPLibre, elle gagne les
fonctions Stream Deck : voir [Dans ERPLibre](#dans-erplibre).

## Indicateurs

| Id          | Icône par défaut              | Rôle                                                                          |
|-------------|-------------------------------|-------------------------------------------------------------------------------|
| controller  | `input-gaming-symbolic`       | D-Bus de tuilage + sous-menu Games + lien vers les préférences                |
| pencil      | `document-edit-symbolic`      | Ouvre un `gnome-terminal` avec `claude` dans un chemin choisi (Resume / Fresh / Custom) |
| media       | `video-x-generic-symbolic`    | Liste vidéo / audio ouverte via navigateur, `mpv --start=<position>`, VLC ou Spotify |
| erplibre    | `network-server-symbolic`     | Instances ERPLibre locales + distantes ; login Selenium / xdotool via KeepassXC |
| network     | `network-wired-symbolic`      | Découverte SSH (`nmap -p22` ou `nc` en repli) + hôtes de `~/.ssh/config`      |
| device      | `input-tablet-symbolic`       | Liste des Stream Deck USB Elgato, démarrage / redémarrage du daemon contrôleur |

Chaque indicateur peut être activé ou désactivé dans la fenêtre de
préférences. Sans ERPLibre autour de l'extension, tout fonctionne sauf ce
qui lance les programmes d'ERPLibre : le sous-menu Games du contrôleur (la
galerie de jeux d'ERPLibre) et le démarrage et redémarrage du programme
Stream Deck par l'indicateur device. Ces entrées disent que le niveau
Stream Deck n'est pas installé.

## Installer

Il faut GNOME Shell 45 à 51 (la liste `shell-version` de
`metadata.json` : le Shell refuse une autre version majeure), git,
`glib-compile-schemas` (paquet
`libglib2.0-bin` sur Debian et Ubuntu) et, pour les traductions, `msgfmt`
(paquet `gettext`). Les indicateurs appellent `gnome-terminal`, `nmap` ou
`nc`, `mpv`, `keepassxc-cli` et `xdotool` quand ils sont présents. Cloner
le dépôt n'importe où, compiler le schéma et les traductions, et lier le
clone dans le répertoire des extensions de l'utilisateur sous son UUID :

```bash
git clone https://github.com/TechnoLibre/erplibre-home-gnome-extension.git
cd erplibre-home-gnome-extension
glib-compile-schemas --strict schemas/
for po in po/*.po; do
  lang=$(basename "$po" .po)
  mkdir -p "locale/$lang/LC_MESSAGES"
  msgfmt --check -o "locale/$lang/LC_MESSAGES/erplibre-home.mo" "$po"
done
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/erplibre-home@technolibre.ca
./tools/enable_next_login.py erplibre-home@technolibre.ca
```

Puis fermer la session et la rouvrir : sous Wayland, GNOME Shell ne trouve
une nouvelle extension qu'à l'ouverture de session, donc
`gnome-extensions enable` échoue avant. `tools/enable_next_login.py` écrit
plutôt la clé GSettings que le Shell lit à l'ouverture.

Pour mettre à jour : `git pull`, relancer les deux compilations, fermer
la session et la rouvrir. Pour retirer :
`gnome-extensions disable erplibre-home@technolibre.ca` et supprimer le
lien.

Les pastilles de sessions Claude du crayon demandent le hook décrit dans
[hooks/README.fr.md](hooks/README.fr.md).

## Dans ERPLibre

ERPLibre clone ce dépôt dans `script/gnome-extension/erplibre_home/` d'un
checkout, par Google Repo (groupe de manifeste `erplibre_home`) ou par son
installateur `script/install/install_erplibre_home.sh`, et suit `main` : il
n'y a pas d'étiquettes de version. Depuis la racine du checkout :

| Cible | |
|---|---|
| `make erplibre_home_install` | niveau de base : clone, lien, schéma, traductions, activation à la prochaine ouverture de session |
| `make erplibre_home_install_extension` | l'extension seule |
| `make erplibre_home_enable_extension` | activer à la prochaine ouverture de session |
| `make erplibre_home_uninstall_extension` | désactiver, retirer le lien et les copies de rechargement à chaud |
| `make erplibre_home_reload` | rechargement à chaud dans la session en cours |
| `make erplibre_home_compile_locale` | compiler `po/*.po` |
| `make erplibre_home_dev_nested` / `make erplibre_home_e2e_nested` | `dev_nested.sh` / `test/e2e_nested.sh` |
| `make claude_install_hooks` | `hooks/install_claude_hooks.py` |
| `make test_gnome_extension` | les tests ci-dessous |
| `make erplibre_home_streamdeck_install` | le niveau Stream Deck d'ERPLibre |

L'extension trouve le checkout à partir de son propre chemin, liens
suivis (`lib/project-root.js`), puis lance le programme Stream Deck
d'ERPLibre, sa galerie de jeux, ses instances et son menu TODO.
[CONTRACT.md](CONTRACT.md) liste ce sur quoi chaque côté compte : les
fichiers, outils et méthodes D-Bus qu'utilise ERPLibre, et les chemins
d'ERPLibre qu'utilise l'extension. Un changement qui le rompt augmente la
version MAJOR du contrat et va sur `main` en même temps que le changement
correspondant dans ERPLibre.

Le programme Stream Deck est un dépôt à part, qu'ERPLibre clone dans
`script/stream_deck/deck/`. Dans un checkout plus ancien, sans ce clone,
l'extension trouve le même programme directement sous
`script/stream_deck/` (`lib/deck-layout.js`).

ERPLibre garde aussi les captures d'écran de l'extension et du deck, dans
`script/stream_deck/screenshots/`, avec le `capture.sh` qui les prend.

## Préférences

`gnome-extensions prefs erplibre-home@technolibre.ca`

Pages : Buttons, Pencil, Media, ERPLibre, Network, Device, Inventaire Odoo, Theming, Advanced, Sync, Log, Help, About.

## Clés GSettings

Schéma `org.gnome.shell.extensions.erplibre-home`. Clés notables :

- `enable-controller`, `enable-pencil`, `enable-media`, `enable-erplibre`, `enable-network`, `enable-device` (booléens)
- `button-order` (`as`) — ordre gauche → droite
- `panel-box` (`s`, défaut `left`) — `left` (côté droit de la zone gauche, juste avant l'horloge centrale), `center` ou `right`
- `paths`, `media`, `instances` (`s`, JSON)
- `terminal-claude-cmd` (`s`, défaut `claude --resume`)
- `network-cidrs` (`as`), `network-ssh-user` (`s`), `network-use-nmap` (`b`), `network-read-ssh-config` (`b`), `network-auto-refresh-sec` (`i`)
- `device-auto-refresh-sec` (`i`)
- `icon-overrides` (`s`, JSON)
- `enable-git-sync` (`b`), `git-sync-path` (`s`)
- `enable-icon-badges` (`b`, défaut `true`) — affiche les pastilles de comptage sur les icônes
- `enable-claude-state-watch` (`b`, défaut `true`) — surveille les fichiers d'état Claude pour le badge du crayon
- `inventory-destinations` (`s`, JSON) — les instances Odoo qui reçoivent l'inventaire des Stream Deck ; aucun jeton là, les jetons vivent dans le trousseau GNOME
- `inventory-pilot` (`s`) — l'id de la destination dont l'Odoo configure le Stream Deck, vide pour aucune ; `inventory-apply-request` (`s`) — écrite par les préférences pour appliquer une révision ou garder les valeurs locales, vidée par l'extension

## Inventaire Odoo

L'extension peut remonter les Stream Deck du poste à une ou plusieurs
instances Odoo qui ont le module ERPLibre `erplibre_streamdeck` : quels
decks sont branchés et depuis quand, le programme du deck et l'état de son
service, le système, et les versions de GNOME Shell, de l'extension et du
checkout ERPLibre. Odoo tient l'inventaire et l'historique des
branchements ; il ne se connecte jamais au poste.

Dans les préférences, page **Inventaire Odoo** :

1. ajouter une destination : une instance de l'indicateur ERPLibre, ou
   tout Odoo par son URL, et sa base de données. HTTPS est exigé, sauf
   vers cette machine (`localhost`, `127.0.0.0/8`, `[::1]` : une instance
   locale, un tunnel SSH) ;
2. l'inscrire par un code d'appairage (dans Odoo, **Stream Deck › Mes
   postes › Ajouter un poste** : 8 caractères, valable 10 minutes, à usage
   unique), une clé d'API, ou un identifiant et un mot de passe ;
3. sa ligne montre ensuite l'état : à jour, hors ligne avec les événements
   en attente, inscription révoquée, ou refusé avec la raison. Le menu de
   l'indicateur device dit la même chose en une ligne.

Odoo rend un jeton de poste, qui vit dans le trousseau GNOME (schéma
libsecret `ca.technolibre.erplibre-home.inventory`) et nulle part
ailleurs ; le code, la clé ou le mot de passe n'est envoyé qu'une fois et
n'est jamais gardé. **Désinscrire** révoque le jeton dans Odoo et l'oublie
ici, et les événements qui attendaient encore cet Odoo sont abandonnés :
ils n'atteignent jamais une inscription suivante ; **Retirer** fait de
même, puis supprime la destination et son fichier d'état.

Quand Odoo est arrêté ou lent, les événements attendent dans une file par
destination (1000 événements ou 30 jours) et arrivent dans Odoo avec
l'heure où ils ont eu lieu : GNOME Shell n'attend jamais Odoo. Un deck
branché ou débranché pendant que l'extension est arrêtée (écran verrouillé,
session fermée) est signalé à son démarrage suivant, daté de ce moment. Le
protocole est dans [CONTRACT.md](CONTRACT.md), section « Odoo inventory ».

### Configuration par Odoo

Une destination au plus, cochée **Pilote** dans sa ligne, peut configurer
le Stream Deck : le programme du deck, les plugins coupés, le
rafraîchissement des sessions et les jeux, et rien d'autre. Son Odoo
envoie une révision dans la réponse à une remontée ; rien n'est écrit
avant le clic de l'employé. Une nouvelle révision s'annonce une fois par
une notification avec **Appliquer**, par une entrée du menu de
l'indicateur device qui liste les clés changées, et par un bouton
**Appliquer** dans la ligne de la destination. À la première remontée
pilote, Odoo peut plutôt demander : **Prendre les réglages d'Odoo**
applique ses valeurs, **Garder mes réglages** n'écrit rien et Odoo adopte
les valeurs locales ; les réglages verrouillés sont ensuite proposés avec
**Appliquer**, comme d'habitude.

Appliquer vérifie d'abord chaque valeur (une seule hors de la liste
refuse toute la révision), puis réécrit
`~/.config/erplibre-home/streamdeck.conf` en un remplacement atomique,
toute autre ligne gardée, et redémarre le service du deck quand il tourne
et qu'un réglage autre que les jeux a changé. Odoo reçoit aussitôt
`applied` ou le refus et sa raison. Une révision que le fichier contient
déjà est remontée appliquée, sans notification, sauf si son redémarrage a
échoué : elle reste alors proposée jusqu'à ce qu'un clic redémarre le
service.
`$XDG_STATE_HOME/erplibre-home/pilot.json` dit au menu TODO d'ERPLibre
quels réglages Odoo a verrouillés.

Odoo peut aussi disposer les touches d'accueil de chaque modèle de deck :
quelle touche ouvre quel plugin, lesquelles portent le tableau de bord,
lesquelles restent noires, avec une icône et un libellé. L'extension
envoie à Odoo le catalogue du programme du deck du checkout (ses plugins
à touche d'accueil, ses icônes, la géométrie de chaque modèle), lu à son
démarrage et quand le commit du checkout change. Une disposition dont le
catalogue ne permet pas l'action, l'icône ou la touche, ou qui nomme un
plugin coupé, refuse la révision ; au clic,
`~/.config/erplibre-home/keymap.json` est écrit avec `streamdeck.conf`,
les deux ou aucun, avant un seul redémarrage du service du deck, qui le
lit à son démarrage. Seuls les modèles qu'Odoo dispose y sont remplacés :
la disposition d'un autre modèle, éditée à la main, reste.

## Pastilles de comptage

Chaque indicateur visible affiche une petite pastille circulaire sur
l'icône de la barre du haut :

- **controller** — nombre de Stream Decks détectés
- **pencil** — première pastille : chemins configurés ; deuxième
  pastille (seulement quand ≥1 session Claude tourne) : nombre de
  sessions vivantes ; troisième pastille (seulement si au moins une
  session attend l'utilisateur) : compte en attente, jaune sur hook
  `Stop` (tour de l'assistant fini), rouge si hook `Notification`
- **media** — nombre d'entrées média
- **erplibre** — instances locales + distantes
- **network** — hôtes `~/.ssh/config` + résultats du dernier scan
- **device** — nombre de Stream Decks

Le menu déroulant du crayon ajoute aussi une pastille par ligne pour
les chemins qui ont des sessions Claude actives.

## D-Bus

Chemin d'objet `/org/gnome/Shell/Extensions/ERPLibreHome`, interface
`org.gnome.Shell.Extensions.ERPLibreHome`, sur le nom de bus de session de
GNOME Shell `org.gnome.Shell`. [CONTRACT.md](CONTRACT.md) liste les
méthodes qu'appelle ERPLibre (tuilage, minuteries, dispositions, fenêtres,
sessions Claude et mpv, rechargement à chaud). Les menus utilisent aussi :

- `OpenPath(s) -> b`
- `OpenMedia(s, s) -> b  (alias OpenFilm kept)` (player = `browser` | `mpv`)
- `OpenInstance(s, s) -> b` (action = `url` | `login` | `copy_user` | `copy_pass` | `open_keepass` | `start_server`)
- `ScanNetwork() -> s`
- `ListPaths() -> s`, `ListMedia() -> s  (alias ListFilms kept)`, `ListInstances() -> s`, `ListDevices() -> s`

## KeepassXC

Par instance ERPLibre : `keepass_db`, `keepass_keyfile` (optionnel), `keepass_yubikey_slot` / `keepass_yubikey_serial` (optionnel), `keepass_entry`. Le mot de passe maître est gardé en mémoire 5 minutes après le déverrouillage.

## Méthodes d'auto-login

- `selenium` — lance le `script/selenium/web_login.py` de l'instance avec son `.venv.erplibre/bin/python`. Repli sur `xdotool` si le venv manque.
- `xdotool` — expérimental. Ouvre l'URL, tape l'utilisateur, Tab, mot de passe, Entrée.
- `none` — masque l'item d'auto-login.

## Limitations

- Les sites de streaming DRM (Netflix, Crunchyroll, etc.) ne fonctionnent que via le navigateur.
- Le scan réseau n'exige pas root mais ne trouve pas SSH sur des ports non standards.
- La sync Git résout les conflits en mode dernier-écrit-gagne ; un merge manuel peut être requis.

## Développement

`./dev_nested.sh` lance un GNOME Shell imbriqué avec l'extension, dans un
bac à sable sous `$XDG_RUNTIME_DIR/erplibre-home-nested/` : fermer sa
fenêtre efface tout, la session parente n'est pas touchée. Une extension
en marche se recharge elle-même depuis une copie sous un nouvel UUID :

```bash
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/ERPLibreHome \
  --method org.gnome.Shell.Extensions.ERPLibreHome.HotReload
```

`DEBUG.md` relie les symptômes aux journaux et aux sondes ;
`ARCHITECTURE.md` décrit comment s'assemblent les indicateurs,
l'interface D-Bus et les fichiers d'état.

`README.md`, `README.fr.md` et `hooks/README*.md` sont générés par mmg à
partir du `README.base.md` voisin : modifier le `.base.md`, puis lancer
`pip install mmg` une fois et
`mmg --yes README.base.md hooks/README.base.md`.

## Tests

Les tests unitaires demandent Node.js 22 ou plus récent et Python 3, rien
d'autre ; ils tournent dans un clone seul comme dans ERPLibre :

```bash
npm test                                   # both suites below
node --test test/unit/*.test.js            # the GJS code, gi:// faked
python3 -m unittest discover -s test/python  # tools/, hooks/, names
glib-compile-schemas --strict --dry-run schemas/
```

`test/e2e_nested.sh` lance un GNOME Shell sans écran sur un bus privé et
vérifie que l'extension devient active, répond sur D-Bus et monte chaque
indicateur. `test/manual.md` est la liste de vérification manuelle.

### Verdicts dans le registre des requis

`npm test` peut envoyer le verdict de chaque test au registre des requis
d'une instance Odoo qui porte le module `erplibre_devops_requirement`. Un
requis prouvé par un test de ce dépôt liste une ligne *Test Node* avec la
référence
`erplibre-home-gnome-extension:test/unit/<fichier>::<nom du test>`, ou une
ligne *Test unitaire de dépôt* avec la référence
`erplibre-home-gnome-extension:test/python/<fichier>::<Classe>::<méthode>`.
Après les suites, `test/run_suites.py` écrit le verdict de chaque
référence déclarée qui a tourné, avec un appel par référence ; un test
qu'aucun requis ne cite ne coûte aucun appel. Un test déclaré absent d'un
fichier qui a tourné jusqu'au bout est noté en erreur : il a été renommé
ou supprimé, et sa référence est à mettre à jour.

Quatre variables d'environnement l'activent, les quatre ou aucune.
L'identifiant est un utilisateur du groupe *Lanceur de tests de requis*,
et la clé est la clé d'API de cet utilisateur. `read -rs` lit la clé sans
l'afficher et la garde hors de l'historique du shell :

```bash
export ERPLIBRE_REQUIREMENT_URL=https://odoo.example.com
export ERPLIBRE_REQUIREMENT_DB=registry
export ERPLIBRE_REQUIREMENT_LOGIN=test_runner
read -rs ERPLIBRE_REQUIREMENT_KEY && export ERPLIBRE_REQUIREMENT_KEY
npm test
```

L'URL doit être en HTTPS. HTTP sans chiffrement n'est accepté que vers
une adresse de bouclage, comme un tunnel SSH vers l'instance, parce que
la clé part avec chaque appel. Les suites elles-mêmes ne reçoivent pas
ces variables. Chaque journal envoyé a la clé masquée, les chemins
relatifs au dépôt et le répertoire personnel affiché `~`.

Sans ces variables, `npm test` lance les deux commandes ci-dessus telles
quelles, n'ouvre aucune connexion et n'affiche rien de plus. Avec elles,
la sortie est la même, plus une ligne. Un envoi qui échoue affiche une
ligne d'avertissement et s'arrête. Le code de sortie est toujours celui
des suites, et la clé n'est jamais affichée.

## Internationalisation

L'extension est livrée en anglais (source) et en français. GNOME
shell choisit automatiquement la bonne langue selon `LANG`
(ex. `LANG=fr_CA.UTF-8`).

- `po/erplibre-home.pot` — gabarit d'extraction ; à régénérer
  après l'ajout de chaînes `_()`.
- `po/en.po`, `po/fr.po` — catalogues par langue.
- `locale/<lang>/LC_MESSAGES/erplibre-home.mo` — catalogues
  binaires lus à l'exécution ; ignorés par git, compilés à
  l'installation.

Pour ajouter une langue, copier `po/en.po` vers `po/<lang>.po` (ex.
`po/de.po`), traduire chaque `msgstr "…"`, la compiler avec la boucle
`msgfmt` de [Installer](#installer) (ou `po/compile_locales.py`, qui
demande `python3-polib`) et recharger l'extension. GNOME choisit `<lang>`
quand la locale système correspond.

## Licence

AGPL-3.0 ou ultérieure, voir `LICENSE`. © TechnoLibre.