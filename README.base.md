<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# ERPLibre Home — GNOME Shell extension

A GNOME Shell extension that adds six indicators to the top bar: window
tiling and games, Claude Code sessions, a media list, ERPLibre instances,
SSH hosts of the network, and Elgato Stream Deck devices. It also exports
a D-Bus interface, through which the Stream Deck program of
[ERPLibre](https://github.com/ERPLibre/ERPLibre) tiles windows and follows
sessions from the deck's keys.

- UUID: `erplibre-home@technolibre.ca`
- GNOME Shell 45 to 51 (`shell-version` in `metadata.json`)
- License: AGPL-3.0-or-later (`LICENSE`)

The extension runs on its own. Inside an ERPLibre checkout it gains the
Stream Deck features: see [Inside ERPLibre](#inside-erplibre).

## Indicators

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
| Id          | Default icon                  | What it does                                                                 |
|-------------|-------------------------------|------------------------------------------------------------------------------|
| controller  | `input-gaming-symbolic`       | Tiling D-Bus + Games sub-menu + link to prefs                                |
| pencil      | `document-edit-symbolic`      | Open `gnome-terminal` running `claude` in a chosen path (Resume / Fresh / Custom) |
| media       | `video-x-generic-symbolic`    | Curated video / audio list opened via browser, `mpv --start=<position>`, VLC or Spotify |
| erplibre    | `network-server-symbolic`     | Local + remote ERPLibre instances; KeepassXC-driven Selenium / xdotool login |
| network     | `network-wired-symbolic`      | SSH host discovery (`nmap -p22` or `nc` fallback) + `~/.ssh/config` hosts    |
| device      | `input-tablet-symbolic`       | List of Elgato Stream Deck USB devices, launch / restart controller daemon  |

Each indicator can be toggled in the preferences window. Without ERPLibre
around the extension, everything works except what starts ERPLibre's
programs: the controller's Games sub-menu (ERPLibre's game gallery) and
the device indicator's start and restart of the Stream Deck program. Those
entries say that the Stream Deck level is not installed.

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
## Install

It needs GNOME Shell 45 to 51 (the `shell-version` list of
`metadata.json`: the Shell refuses another major), git,
`glib-compile-schemas` (package
`libglib2.0-bin` on Debian and Ubuntu) and, for the translations, `msgfmt`
(package `gettext`). The indicators call `gnome-terminal`, `nmap` or `nc`,
`mpv`, `keepassxc-cli` and `xdotool` when they are present. Clone the
repository anywhere, compile the schema and the translations, and link
the clone into the user's extensions directory under its UUID:

<!-- [fr] -->
## Installer

Il faut GNOME Shell 45 à 51 (la liste `shell-version` de
`metadata.json` : le Shell refuse une autre version majeure), git,
`glib-compile-schemas` (paquet
`libglib2.0-bin` sur Debian et Ubuntu) et, pour les traductions, `msgfmt`
(paquet `gettext`). Les indicateurs appellent `gnome-terminal`, `nmap` ou
`nc`, `mpv`, `keepassxc-cli` et `xdotool` quand ils sont présents. Cloner
le dépôt n'importe où, compiler le schéma et les traductions, et lier le
clone dans le répertoire des extensions de l'utilisateur sous son UUID :

<!-- [end] -->
<!-- [common] -->
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

<!-- [end] -->
<!-- [en] -->
Then log out and back in: under Wayland, GNOME Shell finds a new extension
only at login, so `gnome-extensions enable` fails before it.
`tools/enable_next_login.py` writes the GSettings key the Shell reads at
login instead.

To update, `git pull`, run the two compile steps again and log out and
back in. To remove, `gnome-extensions disable erplibre-home@technolibre.ca`
and delete the link.

The pencil's Claude session badges need the hook described in
[hooks/README.md](hooks/README.md).

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
## Inside ERPLibre

ERPLibre clones this repository at `script/gnome-extension/erplibre_home/`
of a checkout, by Google Repo (manifest group `erplibre_home`) or by its
installer `script/install/install_erplibre_home.sh`, and follows `main`:
there are no release tags. From the checkout root:

<!-- [fr] -->
## Dans ERPLibre

ERPLibre clone ce dépôt dans `script/gnome-extension/erplibre_home/` d'un
checkout, par Google Repo (groupe de manifeste `erplibre_home`) ou par son
installateur `script/install/install_erplibre_home.sh`, et suit `main` : il
n'y a pas d'étiquettes de version. Depuis la racine du checkout :

<!-- [end] -->
<!-- [en] -->
| Target | |
|---|---|
| `make erplibre_home_install` | base level: clone, link, schema, translations, enable at next login |
| `make erplibre_home_install_extension` | the extension alone |
| `make erplibre_home_enable_extension` | enable at next login |
| `make erplibre_home_uninstall_extension` | disable, remove the link and the hot reload copies |
| `make erplibre_home_reload` | hot reload in the running session |
| `make erplibre_home_compile_locale` | compile `po/*.po` |
| `make erplibre_home_dev_nested` / `make erplibre_home_e2e_nested` | `dev_nested.sh` / `test/e2e_nested.sh` |
| `make claude_install_hooks` | `hooks/install_claude_hooks.py` |
| `make test_gnome_extension` | the tests below |
| `make erplibre_home_streamdeck_install` | ERPLibre's Stream Deck level |

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
The extension finds the checkout from its own path, links followed
(`lib/project-root.js`), and then starts ERPLibre's Stream Deck program,
its game gallery, its instances and its TODO menu. [CONTRACT.md](CONTRACT.md)
lists what each side relies on: the files, tools and D-Bus methods
ERPLibre uses, and the paths of ERPLibre the extension uses. A change
that breaks it bumps the contract's MAJOR version and goes to `main`
together with the matching change in ERPLibre.

ERPLibre also keeps the screenshots of the extension and of the deck, in
`script/stream_deck/screenshots/`, with the `capture.sh` that takes them.

<!-- [fr] -->
L'extension trouve le checkout à partir de son propre chemin, liens
suivis (`lib/project-root.js`), puis lance le programme Stream Deck
d'ERPLibre, sa galerie de jeux, ses instances et son menu TODO.
[CONTRACT.md](CONTRACT.md) liste ce sur quoi chaque côté compte : les
fichiers, outils et méthodes D-Bus qu'utilise ERPLibre, et les chemins
d'ERPLibre qu'utilise l'extension. Un changement qui le rompt augmente la
version MAJOR du contrat et va sur `main` en même temps que le changement
correspondant dans ERPLibre.

ERPLibre garde aussi les captures d'écran de l'extension et du deck, dans
`script/stream_deck/screenshots/`, avec le `capture.sh` qui les prend.

<!-- [end] -->
<!-- [en] -->
## Preferences

`gnome-extensions prefs erplibre-home@technolibre.ca`

Pages: Buttons, Pencil, Media, ERPLibre, Network, Device, Theming, Sync, Advanced, About.

## GSettings keys

Schema id `org.gnome.shell.extensions.erplibre-home`. Selected keys:

- `enable-controller`, `enable-pencil`, `enable-media`, `enable-erplibre`, `enable-network`, `enable-device` (booleans)
- `button-order` (`as`) — left-to-right ordering
- `panel-box` (`s`, default `left`) — `left` (right edge of the left section, just before the centre clock), `center` or `right`
- `paths`, `media`, `instances` (`s`, JSON arrays)
- `terminal-claude-cmd` (`s`, default `claude --resume`)
- `network-cidrs` (`as`), `network-ssh-user` (`s`), `network-use-nmap` (`b`), `network-read-ssh-config` (`b`), `network-auto-refresh-sec` (`i`)
- `device-auto-refresh-sec` (`i`)
- `icon-overrides` (`s`, JSON object keyed by indicator id)
- `enable-git-sync` (`b`), `git-sync-path` (`s`)
- `enable-icon-badges` (`b`, default `true`) — show count circles on top-bar icons
- `enable-claude-state-watch` (`b`, default `true`) — watch Claude session state files for the pencil badge

## Icon badges

Each visible indicator decorates its top-bar icon with a small circular
count badge:

- **controller** — number of Stream Deck devices currently detected
- **pencil** — first badge: configured paths; second badge (only when
  ≥1 Claude session is running): live session count; third badge
  (only when at least one session awaits user feedback): awaiting
  count, yellow on a `Stop` hook (assistant turn ended), red when a
  `Notification` hook is pending
- **media** — number of media entries in the catalogue
- **erplibre** — local + remote instance count
- **network** — `~/.ssh/config` hosts + last network scan host count
- **device** — number of Stream Deck devices

The pencil dropdown also shows a per-row badge with the same colour for
each path that has running Claude sessions.

## D-Bus

Object path `/org/gnome/Shell/Extensions/ERPLibreHome`, interface
`org.gnome.Shell.Extensions.ERPLibreHome`, on GNOME Shell's session bus
name `org.gnome.Shell`. [CONTRACT.md](CONTRACT.md) lists the methods
ERPLibre calls (tiling, timers, layouts, windows, Claude and mpv sessions,
hot reload). The menus also use:

- `OpenPath(s) -> b`
- `OpenMedia(s, s) -> b  (alias OpenFilm kept)` (player = `browser` | `mpv`)
- `OpenInstance(s, s) -> b` (action = `url` | `login` | `copy_user` | `copy_pass` | `open_keepass` | `start_server`)
- `ScanNetwork() -> s`
- `ListPaths() -> s`, `ListMedia() -> s  (alias ListFilms kept)`, `ListInstances() -> s`, `ListDevices() -> s`

## KeepassXC

Per ERPLibre instance: `keepass_db`, `keepass_keyfile` (optional), `keepass_yubikey_slot` / `keepass_yubikey_serial` (optional), `keepass_entry`. Master password is held in memory for 5 minutes after a successful unlock.

## Auto-login methods

- `selenium` — runs the instance's `script/selenium/web_login.py` with its `.venv.erplibre/bin/python`. Falls back to `xdotool` if the venv is missing.
- `xdotool` — experimental. Open URL, type user, Tab, type password, Return.
- `none` — hide the auto-login menu item.

## Limitations

- DRM streaming sites (Netflix, Crunchyroll, etc.) only work via the browser launcher.
- Network scan does not require root but cannot find SSH on non-default ports.
- Git sync resolves conflicts as last-write-wins; manual merges may be required.

## Development

`./dev_nested.sh` starts a nested GNOME Shell with the extension, in a
sandbox under `$XDG_RUNTIME_DIR/erplibre-home-nested/`: closing its window
discards everything, the parent session is not touched. A running
extension reloads itself from a copy under a new UUID:

<!-- [fr] -->
## Préférences

`gnome-extensions prefs erplibre-home@technolibre.ca`

Pages : Buttons, Pencil, Media, ERPLibre, Network, Device, Theming, Sync, Advanced, About.

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

<!-- [end] -->
<!-- [common] -->
```bash
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/ERPLibreHome \
  --method org.gnome.Shell.Extensions.ERPLibreHome.HotReload
```

<!-- [end] -->
<!-- [en] -->
`DEBUG.md` maps symptoms to logs and probes; `ARCHITECTURE.md` describes
how the indicators, the D-Bus interface and the state files fit together.

`README.md`, `README.fr.md` and `hooks/README*.md` are generated from
the `README.base.md` next to them by mmg: edit the `.base.md`, then run
`pip install mmg` once and `mmg --yes README.base.md hooks/README.base.md`.

## Tests

The unit tests need Node.js 22 or later and Python 3, nothing else; they
run in a clone on its own as well as inside ERPLibre:

<!-- [fr] -->
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

<!-- [end] -->
<!-- [common] -->
```bash
npm test                                   # both suites below
node --test test/unit/*.test.js            # the GJS code, gi:// faked
python3 -m unittest discover -s test/python  # tools/, hooks/, names
glib-compile-schemas --strict --dry-run schemas/
```

<!-- [end] -->
<!-- [en] -->
`test/e2e_nested.sh` starts a headless GNOME Shell on a private bus and
checks that the extension becomes active, answers on D-Bus and mounts
every indicator. `test/manual.md` is the manual checklist.

<!-- [fr] -->
`test/e2e_nested.sh` lance un GNOME Shell sans écran sur un bus privé et
vérifie que l'extension devient active, répond sur D-Bus et monte chaque
indicateur. `test/manual.md` est la liste de vérification manuelle.

<!-- [end] -->
<!-- [en] -->
### Verdicts in the requirement registry

`npm test` can send the verdict of each test to the requirement registry
of an Odoo instance that has the `erplibre_devops_requirement` module. A
requirement proved by a test of this repository lists a *Node test* line
with the reference
`erplibre-home-gnome-extension:test/unit/<file>::<test name>`, or a
*Repository unit test* line with the reference
`erplibre-home-gnome-extension:test/python/<file>::<Class>::<method>`.
After the suites, `test/run_suites.py` writes the verdict of each
declared reference that ran, one call per reference; a test that no
requirement cites costs no call. A declared test missing from a file
that ran to the end is noted as an error: it was renamed or deleted, and
its reference is to update.

Four environment variables turn it on, all four or none. The login is a
user of the *Requirement test runner* group, and the key is that user's
API key. `read -rs` reads the key without showing it and keeps it out of
the shell history:

<!-- [fr] -->
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

<!-- [end] -->
<!-- [common] -->
```bash
export ERPLIBRE_REQUIREMENT_URL=https://odoo.example.com
export ERPLIBRE_REQUIREMENT_DB=registry
export ERPLIBRE_REQUIREMENT_LOGIN=test_runner
read -rs ERPLIBRE_REQUIREMENT_KEY && export ERPLIBRE_REQUIREMENT_KEY
npm test
```

<!-- [end] -->
<!-- [en] -->
The URL must be HTTPS. Plain HTTP is accepted only for a loopback
address, such as an SSH tunnel to the instance, because the key travels
with every call. The suites themselves do not receive these variables.
Each sent log has the key masked, paths relative to the repository, and
the home directory shown as `~`.

Without these variables, `npm test` runs the two commands above as they
are, opens no connection and prints nothing more. With them, the output
is the same plus one line. A failed send prints one warning line and
stops. The exit code is always the suites' own, and the key is never
printed.

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
## Internationalisation

The extension ships English (source) and French translations. GNOME
shell auto-picks the right one based on the system `LANG` (e.g.
`LANG=fr_CA.UTF-8`).

- `po/erplibre-home.pot` — extraction template; regenerate after
  adding new `_()` strings.
- `po/en.po`, `po/fr.po` — per-language catalogues.
- `locale/<lang>/LC_MESSAGES/erplibre-home.mo` — compiled binary
  catalogues read at runtime; ignored by git, built at install.

To add a language, copy `po/en.po` to `po/<lang>.po` (e.g. `po/de.po`),
translate every `msgstr "…"`, compile it with the `msgfmt` loop of
[Install](#install) (or `po/compile_locales.py`, which needs
`python3-polib`) and reload the extension. GNOME picks `<lang>` when the
system locale matches.

<!-- [fr] -->
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

<!-- [end] -->
<!-- [en] -->
## License

AGPL-3.0-or-later, see `LICENSE`. © TechnoLibre.
<!-- [fr] -->
## Licence

AGPL-3.0 ou ultérieure, voir `LICENSE`. © TechnoLibre.
<!-- [end] -->
