# 🧭 FindMyWay

Petite application web pour préparer ses sorties **vélo** et **course à pied** :
on pose un point de départ sur la carte, on choisit une **boucle** ou un **aller
simple**, une **distance** ou une **durée** cible… et l'itinéraire se trace tout
seul, prêt à être exporté en **GPX**.

Aucun serveur, aucun compte, aucune clé API : ce sont des fichiers statiques
(HTML/CSS/JS) qui s'exécutent entièrement dans le navigateur.

## Utilisation

```bash
python3 -m http.server 8080     # ou : npx http-server -p 8080
```

Puis ouvrir <http://localhost:8080>.

> Un serveur local est nécessaire : le code utilise des modules ES, qui ne se
> chargent pas depuis un `file://`.

Comme le site est entièrement statique, il peut aussi être publié tel quel sur
GitHub Pages, Netlify, un dossier `public/` de n'importe quel hébergeur, etc.

### En pratique

1. **Point de départ** : tape une adresse, clique sur la carte, ou utilise 📍
   pour ta position. Le marqueur reste déplaçable. Le bouton ☆ enregistre
   l'endroit sous un nom (« Domicile », « Bureau »…) : il apparaît ensuite dans
   la liste déroulante et se rappelle en un clic. 🗑 supprime le lieu
   sélectionné.
2. **Points de passage** (facultatif) : « 📌 Ajouter un point », puis un clic
   sur la carte par point à traverser. L'itinéraire les enchaîne dans l'ordre.
   Un marqueur se déplace au glisser, se retire d'un clic.
3. **Activité et terrain** : vélo ou course à pied, puis **route**, **mixte**
   ou **chemins** — chaque combinaison choisit un profil de routage adapté
   (voir plus bas). L'option **Privilégier les itinéraires balisés** colle aux
   véloroutes, voies vertes et sentiers signalisés.
4. **Type de parcours** : boucle, aller-retour (même chemin au retour) ou
   aller simple.
5. **Objectif** : une distance en km, ou une durée en minutes convertie en
   distance via la vitesse moyenne indiquée (25 km/h à vélo, 10 km/h en course
   par défaut). Le bouton 🏁 permet aussi de **fixer l'arrivée** sur la carte —
   point d'arrivée pour un aller simple, point de demi-tour pour un
   aller-retour. La distance devient alors la longueur du détour pour s'y
   rendre. Sans arrivée imposée, elle est calculée d'après la distance et la
   direction.
6. **Direction générale** : imposée (N, NE, E…) ou aléatoire.
7. **Tracer l'itinéraire**, puis **Autre variante** autant de fois que voulu
   pour obtenir un autre parcours avec les mêmes contraintes.
8. **Retoucher le tracé** : attrape la ligne et tire-la où tu veux — comme sur
   Strava ou Komoot. Un point apparaît là où tu relâches, et l'itinéraire est
   recalculé pour y passer. La poignée se déplace ensuite au glisser et se
   retire d'un clic.
9. **Exporter en GPX** : fichier compatible Garmin, Wahoo, Komoot, Strava,
   OpenRunner… Le bouton 🔗 copie un **lien de partage** qui rejoue exactement
   le même parcours chez le destinataire.

Le sélecteur en haut à droite de la carte ajoute des calques : itinéraires
cyclables balisés, sentiers de randonnée, et traces GPS publiques d'OSM — de
quoi vérifier d'un coup d'œil si un tracé suit les parcours fréquentés. Le
calque proposé suit l'activité choisie tant que tu n'as pas fait ton propre
choix.

Les réglages et le dernier point de départ sont mémorisés dans le navigateur.

## Comment le parcours est calculé

Le service de routage sait relier des points, pas produire « 30 km à partir
d'ici ». La calibration se fait donc par itérations (`js/planner.js`) :

- **Boucle** : on place 5 ou 6 points de passage sur un cercle décalé dans la
  direction demandée, de rayon `distance / 2π`, avec un léger désordre pour que
  le tracé ne soit pas un polygone parfait. On demande l'itinéraire réel, on
  compare à la cible, on redimensionne le cercle, et on recommence.
- **Aller simple** : même principe avec un point d'arrivée placé à ~78 % de la
  distance cible à vol d'oiseau (le réseau routier rallonge toujours le tracé),
  plus un point intermédiaire décalé latéralement.
- **Aller-retour** : un aller calibré sur la moitié de la cible, puis replié sur
  lui-même. Aucune requête supplémentaire, et le retour suit exactement l'aller.
- **Avec points imposés** (passages et/ou arrivée) : le tracé qui les relie
  devient le plancher — impossible de faire plus court. S'il reste de la distance à
  couvrir, chaque portion est gonflée latéralement, alternativement d'un côté
  puis de l'autre (sinon une boucle à un seul point de passage serait un simple
  aller-retour). Le facteur de renflement est estimé analytiquement — une
  portion gonflée d'un facteur `f` s'allonge d'environ `√(1 + 4f²)` — puis
  affiné sur la distance réellement mesurée. Si les points imposent déjà plus
  que l'objectif, l'application le dit au lieu de tricher. Une arrivée choisie
  sur la carte n'est qu'un point imposé de plus, placé en dernier — d'où le même
  traitement, sans code particulier.

L'ajustement est amorti pour éviter les oscillations et s'arrête dès que l'écart
passe sous 4 % (7 essais au maximum, en pratique 2 ou 3). Le meilleur tracé
obtenu est conservé, et l'écart résiduel est affiché s'il reste notable.

### Coller aux itinéraires fréquentés

Il n'existe pas d'équivalent libre de la heatmap Strava : elle n'est exposée par
aucune API, et l'accord API interdit désormais aux applis tierces d'afficher ces
données. Le meilleur substitut réutilisable est dans OSM : les **relations
d'itinéraires** (`route=bicycle` avec ses réseaux `icn`/`ncn`/`rcn`/`lcn`,
`route=hiking`) décrivent les parcours **balisés sur le terrain**, donc ceux qui
sont réellement empruntés.

BRouter les pondère nativement, et propose un profil par usage. Le terrain
choisi sélectionne donc le profil, et l'option « itinéraires balisés » règle un
de ses paramètres :

| | Route | Mixte | Chemins |
| --- | --- | --- | --- |
| **Vélo** | `fastbike` | `trekking` + `stick_to_cycleroutes` | `gravel` + `prefer_unpaved_paths` |
| **Course** | OSRM `routed-foot` | `hiking-mountain` (SAC T1) | `hiking-mountain` (SAC T2) + `hiking_routes_preference` |

Sur le bitume en course à pied, l'instance piétonne d'OSRM reste plus adaptée
que le seul profil de marche de BRouter, taillé pour la montagne : c'est donc
elle qui passe en premier, l'autre servant de repli.

BRouter n'acceptant aucun paramètre de profil dans l'URL, régler un profil
suppose de récupérer son texte, d'y modifier les lignes `assign`, de le
téléverser (`POST /brouter/profile`) et de router avec l'identifiant renvoyé.
Tout est best-effort : au moindre accroc on retombe sur le profil standard,
puis sur OSRM. Le fournisseur et le profil réellement utilisés sont affichés
sous les statistiques — un tracé calculé par un repli ne passe pas inaperçu.

### Lien de partage

Le bouton 🔗 encode départ, points de passage, réglages, **cap et graine
aléatoire** dans le fragment de l'URL. Le fragment n'étant jamais transmis au
serveur, rien ne sort du navigateur ; et comme la génération est déterministe,
le destinataire retrouve le tracé exact, pas seulement les mêmes réglages. À
l'ouverture d'un tel lien, le parcours est retracé automatiquement. Le nom du
lieu de départ n'est volontairement pas partagé.

### Route ou chemin, à la lecture du tracé

BRouter joint à chaque itinéraire un tableau `messages` : une ligne par tronçon,
avec les tags OSM de la voie empruntée. `js/routing.js` s'en sert pour étiqueter
chaque point du tracé, à partir de `surface`, `tracktype` et `highway` — une
voie sans tag de surface est supposée goudronnée, ce qui est la règle en Europe
pour une route nommée.

La carte affiche alors un trait plein orange sur toute la longueur, avec des
**pointillés blancs par-dessus les portions non revêtues** : les chemins se
repèrent d'un coup d'œil sans que le tracé perde sa continuité. Une légende sous
les statistiques donne la répartition (« 68 % route · 32 % chemins »).

Le repli OSRM ne fournit pas cette information : dans ce cas le tracé reste
uniformément orange et la légende disparaît, plutôt que d'afficher une
répartition inventée.

### Retoucher un tracé à la main

Un itinéraire naît d'une **chaîne de points** envoyée au routeur : départ,
points de passage, arrivée. Tirer la trace revient donc à insérer un point dans
cette chaîne — reste à savoir où. `js/edit.js` retrouve la position de chaque
point de la chaîne dans la trace, puis repère entre lesquels se situe l'endroit
saisi : le nouveau point s'insère à ce rang, jamais avant le départ ni après
l'arrivée.

Le recalcul qui suit **ne recalibre pas la distance** : le tracé retouché est
celui que tu as dessiné, la distance obtenue est simplement annoncée. Une seule
requête au routeur par retouche.

Sur un aller-retour, la retouche porte sur l'aller ; saisir le brin retour
revient au même point de l'aller, et le tracé est replié à nouveau après
recalcul.

Quelques détails qui comptent :

- une couche invisible et large recouvre la trace, car un trait de 5 px est
  difficile à attraper à la souris comme au doigt ;
- pendant le glissement, un aperçu en pointillés relie les deux voisins au
  curseur — sans interroger le routeur à chaque pixel ;
- le clic qui suit un relâchement est ignoré, sinon la carte le prendrait pour
  une demande de déplacement du point de départ ;
- un tracé retouché voyage entier dans le lien de partage (la graine seule
  rejouerait le tracé d'origine, pas tes modifications) ;
- « Tracer l'itinéraire » ou « Autre variante » repart d'un tracé neuf et
  abandonne les retouches.

### Pas d'impasses ni de demi-tours

Un point de passage se cale parfois sur une voie sans issue : le routeur y
entre, va au bout, puis repart en sens inverse. `js/simplify.js` détecte ces
replis sur la trace — deux brins qui se superposent (à 15 m près) **et** sont
parcourus en sens opposé (plus de 120° d'écart) — et supprime la portion entre
les deux passages à la jonction. Le tracé reste continu, raccourcit, et la
calibration en tient compte à l'essai suivant.

Un simple virage en épingle (moins de 40 m) est conservé, tout comme le tout
début et la toute fin du parcours : si le domicile est lui-même au fond d'une
impasse, il faut bien en sortir.

## Services utilisés

| Rôle | Service | Remarque |
| --- | --- | --- |
| Fond de carte | [OpenStreetMap](https://www.openstreetmap.org/) · [CyclOSM](https://www.cyclosm.org/) | tuiles standard ou orientées vélo |
| Itinéraires balisés | [Waymarked Trails](https://waymarkedtrails.org/) | calques vélo et randonnée, © Sarah Hoffmann (CC-BY-SA) |
| Traces GPS | [traces publiques OSM](https://www.openstreetmap.org/traces) | calque `gps.tile.openstreetmap.org` |
| Adresses | [Nominatim](https://nominatim.openstreetmap.org/) | recherche et géocodage inverse, saisie temporisée |
| Routage | [BRouter](https://brouter.de/) (`fastbike`, `trekking`, `gravel`, `hiking-mountain`) | un profil par terrain, réglable |
| Routage de secours | [OSRM FOSSGIS](https://routing.openstreetmap.de/) (`routed-bike` / `routed-foot`) | et fournisseur principal pour la course sur route |
| Altitudes | [Open-Meteo Elevation](https://open-meteo.com/en/docs/elevation-api) | D+ et profil, best-effort |

Ces serveurs sont mis à disposition gratuitement par la communauté : l'usage
reste raisonnable (quelques requêtes par tracé), merci de ne pas en faire un
service automatisé à gros volume.

## Structure

```
index.html            interface
css/styles.css        styles (thème clair/sombre, responsive)
js/app.js             carte Leaflet, formulaire, orchestration
js/planner.js         génération et calibration des parcours
js/simplify.js        suppression des impasses parcourues aller-retour
js/edit.js            retouche du tracé (position des points dans la trace)
js/routing.js         choix du profil selon terrain, BRouter puis repli OSRM
js/share.js           lien de partage (encodage / lecture)
js/layers.js          fonds de carte et calques d'itinéraires balisés
js/geocoding.js       recherche d'adresse (Nominatim)
js/places.js          lieux de départ enregistrés (localStorage)
js/elevation.js       profil altimétrique et dénivelé
js/gpx.js             génération et téléchargement du GPX
js/geo.js             utilitaires géographiques
tests/run.mjs         tests de la logique de tracé (node, sans réseau)
vendor/leaflet/       Leaflet 1.9.4 (embarqué, pas de CDN)
```

## Tests

```bash
node tests/run.mjs
```

Ils couvrent la calibration des distances et le nettoyage des allers-retours,
avec un routeur simulé — donc sans réseau ni navigateur.

## Limites connues

- Le dénivelé est calculé à partir d'un modèle d'élévation échantillonné sur
  120 points : c'est un ordre de grandeur, pas une mesure barométrique.
- Sur un point de départ isolé (chemin privé, forêt), le routeur peut ne rien
  trouver : déplace le marqueur vers une route proche.
- Les lieux enregistrés vivent dans le navigateur (localStorage) : ils ne
  suivent pas d'un appareil à l'autre et disparaissent si tu effaces les données
  du site.
- La popularité réelle (heatmap Strava, Komoot) n'est pas accessible : les
  itinéraires balisés OSM en sont un substitut, pas un équivalent.
- L'aller simple ne prévoit pas le retour — pense au train, à la voiture, ou
  choisis une boucle ou un aller-retour.
