import {
  Map,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./style.css";

setWorkerUrl(workerUrl);

/*
Fonds de carte :
- https://demotiles.maplibre.org/style.json (MapLibre)
- https://tiles.openfreemap.org/styles/liberty
*/

const map = new Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [-0.45, 46.58], // Nouvelle-Aquitaine, enfin environ ... :)
  zoom: 6,
});

map.addControl(new NavigationControl());

const form = document.getElementById("route-form");
const submitButton = document.getElementById("route-submit");
const errorEl = document.getElementById("route-error");

let departMarker = null;
let arriveeMarker = null;
let terraAventuraMarkers = [];

// Force une pause utilisée pour espacer les appels à /api/geocode (Nominatim limite à 1 requête/seconde)
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Géocode un nom de ville en coordonnées, via l'API backend /api/geocode
async function geocode(query) {
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);

  if (!response.ok) {
    throw new Error(`Ville introuvable : ${query}`);
  }

  return response.json(); // { lat, lon, displayName }
}

// Calcule l'itinéraire entre deux points (appel à GraphHopper) et récupère les Terra Aventura à proximité
async function fetchItineraire(depart, arrivee) {
  const response = await fetch("/api/itineraire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depart, arrivee }),
  });

  if (!response.ok) {
    throw new Error("Impossible de calculer l'itinéraire");
  }

  return response.json(); // format : { itineraire: { geometry, distance, duration }, terraAventura }
}

/**
 * Place un marker sur la carte
 * @param {*} position - { lat, lon, displayName }
 * @param {*} color - couleur du marker (ex: "#d9a441")
 * @returns - {Marker} - l'objet Marker créé
 */
function placeMarker(position, color) {
  return new Marker({ color })
    .setLngLat([position.lon, position.lat])
    .addTo(map);
}

/**
 * Affiche le tracé de l'itinéraire sur la carte
 * @param {*} geometry - GeoJSON LineString { type: "LineString", coordinates: [[lon, lat], ...] }
 * @returns
 */
function displayRoute(geometry) {
  const routeFeature = { type: "Feature", geometry, properties: {} };
  const source = map.getSource("route");

  if (source) {
    source.setData(routeFeature);
    return;
  }

  map.addSource("route", { type: "geojson", data: routeFeature });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "#a8432a",
      "line-width": 4,
      "line-opacity": 0.85,
    },
  });
}

// Echappe les caractères spéciaux dans une chaîne pour l'afficher dans du HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// Retire les marqueurs Terra Aventura de la recherche précédente
function clearTerraAventuraMarkers() {
  terraAventuraMarkers.forEach((marker) => marker.remove());
  terraAventuraMarkers = [];
}

/**
 * Affiche un marqueur (avec popup) pour chaque Terra Aventura à proximité du trajet
 * @param {*} sites - Liste renvoyée par le backend : { nom, commune, lon, lat, site_internet, distance_m, ... }[]
 */
function displayTerraAventura(sites) {
  clearTerraAventuraMarkers();

  for (const site of sites) {
    const lien = site.site_internet
      ? `<br/><a href="${escapeHtml(site.site_internet)}" target="_blank" rel="noopener">Voir la fiche</a>`
      : "";

    const popup = new Popup({ offset: 20 }).setHTML(
      `<strong>${escapeHtml(site.nom)}</strong><br/>${escapeHtml(site.commune)}${lien}`,
    );

    const marker = new Marker({ color: "#16342a" })
      .setLngLat([site.lon, site.lat])
      .setPopup(popup)
      .addTo(map);

    terraAventuraMarkers.push(marker);
  }
}

/**
 * Calcule les coordonnées du rectangle englobant un ensemble de points
 * @param {*} coordinates - Liste de coordonnées [[lon, lat], ...]
 * @returns
 */
function computeBounds(coordinates) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const [lon, lat] of coordinates) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

/**
 * Affiche un message d'erreur
 * @param {*} message - Le message d'erreur à afficher
 */
function setError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/**
 * Définit l'état de chargement du bouton de soumission
 * @param {*} isLoading - true si le bouton doit être désactivé, false sinon
 */
function setLoading(isLoading) {
  submitButton.disabled = isLoading;
}

/**
 * Gère la soumission du formulaire de recherche d'itinéraire
 * @param {*} event - L'événement de soumission du formulaire
 */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const depart = form.depart.value.trim();
  const arrivee = form.arrivee.value.trim();

  if (!depart || !arrivee) return;

  setError("");
  setLoading(true);

  try {
    // Correctif : appels l'un après l'autre (et pas en parallèle avec Promise.all) pour respecter la limite de 1 requête/seconde imposée par Nominatim.
    const departPos = await geocode(depart);
    await wait(1000);
    const arriveePos = await geocode(arrivee);

    if (departMarker) departMarker.remove();
    if (arriveeMarker) arriveeMarker.remove();

    departMarker = placeMarker(departPos, "#d9a441");
    arriveeMarker = placeMarker(arriveePos, "#a8432a");

    // Cadrage 1 : on cadre la carte sur les deux markers de départ et d'arrivée
    map.fitBounds(
      computeBounds([
        [departPos.lon, departPos.lat],
        [arriveePos.lon, arriveePos.lat],
      ]),
      { padding: 80, maxZoom: 12, duration: 800 },
    );

    const { itineraire, terraAventura } = await fetchItineraire(
      departPos,
      arriveePos,
    );
    displayRoute(itineraire.geometry); // Affiche le tracé de l'itinéraire sur la carte
    displayTerraAventura(terraAventura); // Affiche les markers des Terra Aventura à proximité du tracé

    // Cadrage 2 : on cadre la carte sur l'ensemble du tracé de l'itinéraire
    map.fitBounds(computeBounds(itineraire.geometry.coordinates), {
      padding: 80,
      maxZoom: 12,
      duration: 800,
    });
  } catch (err) {
    console.error("Erreur lors de la recherche d'itinéraire :", err);
    setError(err.message || "Une erreur est survenue, vérifie l'orthographe.");
  } finally {
    setLoading(false);
  }
});
