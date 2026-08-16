import { Map, NavigationControl, setWorkerUrl } from "maplibre-gl";
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const depart = form.depart.value.trim();
  const arrivee = form.arrivee.value.trim();

  if (!depart || !arrivee) return;

  // TODO :
  // 1. géocoder "depart" et "arrivee" pour obtenir des coordonnées
  // 2. appeler POST /api/itineraire du backend avec ces coordonnées pour récupérer le trajet + les Terra Aventura à proximité
  // TODO : voir si 2 appels pour le point 2 ou un seul !?
  console.log("Recherche d'itinéraire :", { depart, arrivee });
});
