require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;

if (!CONTACT_EMAIL) {
  console.warn(
    "CONTACT_EMAIL n'est pas défini dans .env — Nominatim peut bloquer les requêtes sans identification valide. Ajoute CONTACT_EMAIL=ton@email.fr",
  );
}

app.use(express.json());

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
 * @param {Array<number>} req.body.depart - Coordonnées de départ
 * @param {Array<number>} req.body.arrivee - Coordonnées d'arrivée
 * @returns {Promise<Object>} - L'itinéraire calculé et les Terra Aventura à proximité
 */
app.post("/api/itineraire", async (req, res) => {
  const { depart, arrivee } = req.body;

  if (!depart || !arrivee) {
    return res.status(400).json({
      error: "Les champs 'depart' et 'arrivee' sont requis (ex: [lon, lat])",
    });
  }

  // TODO : appeler l'API GraphHopper pour calculer l'itinéraire réel
  // TODO : interroger PostGIS avec ST_DWithin pour trouver les Terra Aventura à proximité du tracé obtenu

  res.json({
    itineraire: { depart, arrivee, geometry: null },
    terraAventura: [],
  });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
