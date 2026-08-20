require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const GRAPHHOPPER_API_KEY = process.env.GRAPHHOPPER_API_KEY;

// Domaines autorisés à appeler cette API
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

if (!process.env.FRONTEND_URL) {
  console.warn(
    "FRONTEND_URL n'est pas défini dans .env — seul http://localhost:5173 est autorisé (CORS). Ajoute FRONTEND_URL=https://ton-app.vercel.app en production.",
  );
}

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

if (!process.env.DB_NAME) {
  console.warn(
    "DB_NAME n'est pas défini dans .env — la recherche des Terra Aventura à proximité ne fonctionnera pas.",
  );
}

if (!CONTACT_EMAIL) {
  console.warn(
    "CONTACT_EMAIL n'est pas défini dans .env — Nominatim peut bloquer les requêtes sans identification valide. Ajoute CONTACT_EMAIL=ton@email.fr",
  );
}

if (!GRAPHHOPPER_API_KEY) {
  console.warn(
    "GRAPHHOPPER_API_KEY n'est pas défini dans .env — la route /api/itineraire ne fonctionnera pas. Ajoute GRAPHHOPPER_API_KEY=ta_cle",
  );
}

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

/**
 * Recherche les Terra Aventura à moins de rayonKm d'un tracé donné
 * @param {Object} geometry - GeoJSON LineString (le tracé de l'itinéraire)
 * @param {number} rayonKm - Rayon de recherche en kilomètres
 * @returns {Promise<Array>} - Liste des Terra Aventura triée par distance croissante
 */
async function findTerraAventuraProximite(geometry, rayonKm) {
  const rayonMetres = rayonKm * 1000;

  const { rows } = await pool.query(
    `SELECT
       identifiant,
       nom,
       commune,
       code_postal,
       departement,
       region,
       site_internet,
       createur,
       ST_X(geom) AS lon,
       ST_Y(geom) AS lat,
       ST_Distance(geom::geography, ST_GeomFromGeoJSON($1)::geography) AS distance_m
     FROM terra_aventura
     WHERE ST_DWithin(geom::geography, ST_GeomFromGeoJSON($1)::geography, $2)
     ORDER BY distance_m ASC`,
    [JSON.stringify(geometry), rayonMetres],
  );

  return rows;
}

// Route pour vérifier que le serveur est OK
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Géocode un nom de ville en coordonnées
 * @param {string} query - Le nom de la ville à géocodifier
 * @returns {Promise<{lat: number, lon: number, displayName: string}>} - Les coordonnées et le nom complet de la ville
 */
app.get("/api/geocode", async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({ error: "Le paramètre 'q' est requis" });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "fr");
  url.searchParams.set("viewbox", "-5.5,51.5,9.6,41.0");
  url.searchParams.set("bounded", "1");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": `terra-aventura-radar/0.1 (${CONTACT_EMAIL || "contact non renseigné"})`,
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim a répondu ${response.status}`);
    }

    const results = await response.json();

    if (results.length === 0) {
      return res.status(404).json({ error: "Ville introuvable" });
    }

    const { lat, lon, display_name: displayName } = results[0];
    res.json({ lat: parseFloat(lat), lon: parseFloat(lon), displayName });
  } catch (err) {
    console.error("Erreur de géocodage :", err.message);
    res.status(502).json({ error: "Le service de géocodage est indisponible" });
  }
});

/**
 * Calcule un itinéraire entre deux points et recherche les Terra Aventura à proximité
 * @param {Object} req.body - Les coordonnées de départ et d'arrivée
 * @param {{lat: number, lon: number}} req.body.depart - Coordonnées de départ
 * @param {{lat: number, lon: number}} req.body.arrivee - Coordonnées d'arrivée
 * @returns {Promise<Object>} - L'itinéraire calculé et les Terra Aventura à proximité
 */
app.post("/api/itineraire", async (req, res) => {
  const { depart, arrivee } = req.body;

  if (!depart?.lat || !depart?.lon || !arrivee?.lat || !arrivee?.lon) {
    return res.status(400).json({
      error:
        "Les champs 'depart' et 'arrivee' sont requis, au format { lat, lon }",
    });
  }

  if (!GRAPHHOPPER_API_KEY) {
    return res
      .status(500)
      .json({ error: "GRAPHHOPPER_API_KEY n'est pas configurée côté serveur" });
  }

  const url = new URL("https://graphhopper.com/api/1/route");

  url.searchParams.append("point", `${depart.lat},${depart.lon}`);
  url.searchParams.append("point", `${arrivee.lat},${arrivee.lon}`);
  url.searchParams.set("vehicle", "car");
  url.searchParams.set("locale", "fr");
  url.searchParams.set("points_encoded", "false");
  url.searchParams.set("key", GRAPHHOPPER_API_KEY);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error("Erreur GraphHopper :", response.status, errorBody);
      return res
        .status(502)
        .json({ error: "Impossible de calculer l'itinéraire" });
    }

    const data = await response.json();
    const path = data.paths?.[0];

    if (!path) {
      return res.status(404).json({ error: "Aucun itinéraire trouvé" });
    }

    // Rayon de recherche autour du tracé
    const rayonKm = Number(req.body.rayon) || 10; // 10 km par défaut

    let terraAventura = [];
    try {
      terraAventura = await findTerraAventuraProximite(path.points, rayonKm);
    } catch (dbErr) {
      // Si la table terra_aventura n'existe pas ou si la requête échoue, on log l'erreur mais on continue
      console.error("Erreur PostGIS :", dbErr.message);
    }

    res.json({
      itineraire: {
        geometry: path.points,
        distance: path.distance,
        duration: path.time,
      },
      terraAventura,
    });
  } catch (err) {
    console.error("Erreur de routing :", err.message);
    res.status(502).json({ error: "Le service de routing est indisponible" });
  }
});

/**
 * Recherche les Terra Aventura à proximité d'un tracé déjà calculé, sans
 * rappeler GraphHopper. Utile pour rafraîchir la liste quand l'utilisateur
 * change juste le rayon de recherche, sans recalculer l'itinéraire.
 * @param {Object} req.body - La géométrie du tracé et le rayon souhaité
 * @param {Object} req.body.geometry - GeoJSON LineString du tracé
 * @param {number} req.body.rayon - Rayon de recherche en km
 * @returns {Promise<{terraAventura: Array}>}
 */
app.post("/api/terra-aventura", async (req, res) => {
  const { geometry, rayon } = req.body;

  if (!geometry) {
    return res.status(400).json({ error: "Le champ 'geometry' est requis" });
  }

  const rayonKm = Number(rayon) || 10;

  try {
    const terraAventura = await findTerraAventuraProximite(geometry, rayonKm);
    res.json({ terraAventura });
  } catch (err) {
    console.error("Erreur PostGIS :", err.message);
    res.status(502).json({ error: "Le service de recherche est indisponible" });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
