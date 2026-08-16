import { Map, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
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

// Petite pause, utilisée pour espacer les appels à /api/geocode
// (Nominatim limite à 1 requête/seconde, voir sa politique d'usage)
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

    // Calcul des bounds pour ajuster la vue de la carte afin d'inclure les deux markers
    const bounds = [
      [
        Math.min(departPos.lon, arriveePos.lon),
        Math.min(departPos.lat, arriveePos.lat),
      ],
      [
        Math.max(departPos.lon, arriveePos.lon),
        Math.max(departPos.lat, arriveePos.lat),
      ],
    ];

    map.fitBounds(bounds, { padding: 80, maxZoom: 12, duration: 800 });

    // TODO : appeler POST /api/itineraire avec ces coordonnées pour tracer le trajet réel et récupérer les Terra Aventura à proximité
  } catch (err) {
    console.error("Erreur lors de la recherche d'itinéraire :", err);
    setError(err.message || "Une erreur est survenue, vérifie l'orthographe.");
  } finally {
    setLoading(false);
  }
});
