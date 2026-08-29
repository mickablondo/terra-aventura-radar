"""
Importe (upsert) le GeoJSON nettoyé par clean_terra_aventura.py directement
dans la table PostGIS terra_aventura — sans passer par une table temporaire
ni par ogr2ogr.

Chaque circuit est identifié par sa colonne "identifiant" (contrainte UNIQUE
en base) : s'il existe déjà, ses champs sont mis à jour ; sinon, une nouvelle
ligne est insérée. Rejouer ce script plusieurs fois de suite est donc sans
risque (idempotent).

Usage :
    python import_to_postgis.py mon_export.geojson

Variables d'environnement attendues :
    DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
"""

import json
import os
import sys

import psycopg2


def main():
    if len(sys.argv) != 2:
        print("Usage : python import_to_postgis.py mon_export.geojson")
        sys.exit(1)

    geojson_path = sys.argv[1]

    with open(geojson_path, encoding="utf-8") as f:
        data = json.load(f)

    features = data["features"]
    print(f"{len(features)} circuits à importer/mettre à jour")

    conn = psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=os.environ.get("DB_PORT", "5432"),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        sslmode="require",  # obligatoire sur Supabase
    )
    cur = conn.cursor()

    upserted = 0
    for feature in features:
        props = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"]

        cur.execute(
            """
            INSERT INTO terra_aventura
                (identifiant, nom, commune, code_postal, departement, region, site_internet, createur, geom)
            VALUES
                (%(identifiant)s, %(nom)s, %(commune)s, %(code_postal)s, %(departement)s, %(region)s,
                 %(site_internet)s, %(createur)s, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326))
            ON CONFLICT (identifiant) DO UPDATE SET
                nom = EXCLUDED.nom,
                commune = EXCLUDED.commune,
                code_postal = EXCLUDED.code_postal,
                departement = EXCLUDED.departement,
                region = EXCLUDED.region,
                site_internet = EXCLUDED.site_internet,
                createur = EXCLUDED.createur,
                geom = EXCLUDED.geom
            """,
            {
                "identifiant": props.get("identifiant"),
                "nom": props.get("nom"),
                "commune": props.get("commune"),
                "code_postal": props.get("code_postal"),
                "departement": props.get("departement"),
                "region": props.get("region"),
                "site_internet": props.get("site_internet"),
                "createur": props.get("createur"),
                "lon": lon,
                "lat": lat,
            },
        )
        upserted += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f"{upserted} circuits importés/mis à jour dans PostGIS")


if __name__ == "__main__":
    main()