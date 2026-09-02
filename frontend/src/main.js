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
import { inject } from "@vercel/analytics";

// Injecte le script d'analytics Vercel (https://vercel.com/docs/concepts/analytics)
inject();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Impossible d'enregistrer le service worker :", error);
    });
  });
}

setWorkerUrl(workerUrl);

const API_BASE_URL = import.meta.env.VITE_API_URL || "";

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
const submitIcon = submitButton.querySelector(".route-card__submit-icon");
const errorEl = document.getElementById("route-error");

const allToggleButtons = document.querySelectorAll(".route-card__radius-btn");
const radiusButtons = document.querySelectorAll("[data-rayon]");
const vehiculeButtons = document.querySelectorAll("[data-vehicule]");

let departMarker = null;
let arriveeMarker = null;
let terraAventuraMarkers = [];
let selectedRayon = 10;
let selectedVehicule = "car";
let lastDepartPos = null;
let lastArriveePos = null;
let lastRouteGeometry = null; // pour rafraîchir juste les Terra Aventura sans rappeler GraphHopper

// Force une pause utilisée pour espacer les appels à /api/geocode (Nominatim limite à 1 requête/seconde)
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Géocode un nom de ville en coordonnées, via l'API backend /api/geocode
async function geocode(query) {
  const response = await fetch(
    `${API_BASE_URL}/api/geocode?q=${encodeURIComponent(query)}`,
  );

  if (!response.ok) {
    throw new Error(`Ville introuvable : ${query}`);
  }

  return response.json(); // { lat, lon, displayName }
}

// Calcule l'itinéraire entre deux points (appel à GraphHopper) et récupère les Terra Aventura à proximité
async function fetchItineraire(depart, arrivee, rayon, vehicule) {
  const response = await fetch(`${API_BASE_URL}/api/itineraire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depart, arrivee, rayon, vehicule }),
  });

  if (!response.ok) {
    throw new Error("Impossible de calculer l'itinéraire");
  }

  return response.json(); // format : { itineraire: { geometry, distance, duration }, terraAventura }
}

// Rafraîchit juste la liste des Terra Aventura à proximité d'un tracé déjà
// calculé, sans rappeler GraphHopper (utilisé quand on change le rayon)
async function fetchTerraAventura(geometry, rayon) {
  const response = await fetch(`${API_BASE_URL}/api/terra-aventura`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry, rayon }),
  });

  if (!response.ok) {
    throw new Error("Impossible de rafraîchir les Terra Aventura à proximité");
  }

  return response.json(); // { terraAventura }
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

// Échappe le HTML basique pour éviter qu'un nom/ville avec des caractères
// spéciaux (ex: "<" dans un nom de circuit) ne casse le rendu de la popup.
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

/**
 * Construit les liens HTML vers les sites internet des Terra Aventura
 * @param {*} siteInternet - Chaîne de caractères contenant les URLs séparées par des virgules
 * @returns - Chaîne HTML contenant les liens cliquables vers les sites internet
 */
function buildSiteLinks(siteInternet) {
  if (!siteInternet) return "";

  const urls = siteInternet
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const links = urls.map((url) => {
    let label = url;
    try {
      label = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      // URL malformée en base : on garde l'URL brute comme libellé plutôt que de planter
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  });

  return `<br/>${links.join(" · ")}`;
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
    const liens = buildSiteLinks(site.site_internet);

    const popup = new Popup({ offset: 20 }).setHTML(
      `<strong>${escapeHtml(site.nom)}</strong><br/>${escapeHtml(site.commune)}${liens}`,
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
 * Définit l'état de chargement du formulaire (soumission, changement de rayon ou de véhiculee)
 * @param {*} isLoading - true si les contrôles doivent être désactivés, false sinon
 */
function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitIcon.classList.toggle("is-spinning", isLoading);
  allToggleButtons.forEach((btn) => (btn.disabled = isLoading));
}

/**
 * Recalcule l'itinéraire à partir des dernières positions géocodées connues
 */
async function runRouteSearch() {
  if (!lastDepartPos || !lastArriveePos) return;

  setError("");
  setLoading(true);

  try {
    const { itineraire, terraAventura } = await fetchItineraire(
      lastDepartPos,
      lastArriveePos,
      selectedRayon,
      selectedVehicule,
    );

    displayRoute(itineraire.geometry);
    displayTerraAventura(terraAventura);
    lastRouteGeometry = itineraire.geometry;

    map.fitBounds(computeBounds(itineraire.geometry.coordinates), {
      padding: 80,
      maxZoom: 12,
      duration: 800,
    });
  } catch (err) {
    console.error("Erreur lors du calcul de l'itinéraire :", err);
    setError(err.message || "Impossible de calculer l'itinéraire.");
  } finally {
    setLoading(false);
  }
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

  let departPos;
  let arriveePos;

  try {
    // Correctif : appels l'un après l'autre (et pas en parallèle avec Promise.all) pour respecter la limite de 1 requête/seconde imposée par Nominatim.
    departPos = await geocode(depart);
    await wait(1000);
    arriveePos = await geocode(arrivee);
  } catch (err) {
    console.error("Erreur lors de la recherche d'itinéraire :", err);
    setError(err.message || "Une erreur est survenue, vérifie l'orthographe.");
    setLoading(false);
    return;
  }

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

  lastDepartPos = departPos;
  lastArriveePos = arriveePos;

  // runRouteSearch() gère son propre setLoading/try-catch pour la suite
  await runRouteSearch();
});

// Changement de rayon : on ne recalcule pas l'itinéraire, on rafraîchit
// juste la liste des Terra Aventura à proximité du tracé déjà obtenu.
radiusButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const rayon = Number(btn.dataset.rayon);
    if (rayon === selectedRayon) return;

    selectedRayon = rayon;
    radiusButtons.forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });

    if (!lastRouteGeometry) return; // aucune recherche encore faite, le rayon sera pris en compte à la prochaine

    setError("");
    setLoading(true);

    try {
      const { terraAventura } = await fetchTerraAventura(
        lastRouteGeometry,
        selectedRayon,
      );
      displayTerraAventura(terraAventura);
    } catch (err) {
      console.error("Erreur lors du changement de rayon :", err);
      setError(
        err.message ||
          "Impossible de rafraîchir les Terra Aventura à proximité.",
      );
    } finally {
      setLoading(false);
    }
  });
});

// Changement de véhicule : le tracé change potentiellement (routes cyclables vs routières), donc on rappelle GraphHopper.
vehiculeButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const vehicule = btn.dataset.vehicule;
    if (vehicule === selectedVehicule) return;

    selectedVehicule = vehicule;
    vehiculeButtons.forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });

    await runRouteSearch();
  });
});
