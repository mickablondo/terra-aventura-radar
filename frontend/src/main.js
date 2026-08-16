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
  style: "https://tiles.openfreemap.org/styles/liberty", // TODO : fond de carte de démo à remplacer plus tard
  center: [-0.45, 46.58], // Nouvelle-Aquitaine, enfin environ ... :)
  zoom: 6,
});

map.addControl(new NavigationControl());
