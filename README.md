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
2. **Activité** : vélo (routage cyclable) ou course à pied (routage piéton).
3. **Type de parcours** : boucle (retour au départ) ou aller simple.
4. **Objectif** : une distance en km, ou une durée en minutes convertie en
   distance via la vitesse moyenne indiquée (25 km/h à vélo, 10 km/h en course
   par défaut).
5. **Direction générale** : imposée (N, NE, E…) ou aléatoire.
6. **Tracer l'itinéraire**, puis **Autre variante** autant de fois que voulu
   pour obtenir un autre parcours avec les mêmes contraintes.
7. **Exporter en GPX** : fichier compatible Garmin, Wahoo, Komoot, Strava,
   OpenRunner…

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

L'ajustement est amorti pour éviter les oscillations et s'arrête dès que l'écart
passe sous 4 % (7 essais au maximum, en pratique 2 ou 3). Le meilleur tracé
obtenu est conservé, et l'écart résiduel est affiché s'il reste notable.

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
| Fond de carte | [OpenStreetMap](https://www.openstreetmap.org/) | tuiles standard |
| Adresses | [Nominatim](https://nominatim.openstreetmap.org/) | recherche et géocodage inverse, saisie temporisée |
| Routage | [OSRM FOSSGIS](https://routing.openstreetmap.de/) (`routed-bike` / `routed-foot`) | sans clé |
| Routage de secours | [BRouter](https://brouter.de/) (`trekking` / `hiking-beta`) | si OSRM répond mal |
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
js/routing.js         appels OSRM + repli BRouter
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
- L'aller simple ne prévoit pas le retour — pense au train, à la voiture, ou
  choisis une boucle.
